/* THE KEEPER: the side that holds the targets and their secrets, checks the
 * rights, asks a person when it must, runs the connector, answers, and journals.
 * An application runs one (or `serve` does).
 *
 *   const k = keeper(storeDir, {
 *       sides: () => [{ dir, who }],          each agent's folder, and who it is
 *       ask: (request) => Promise<decision>,  a call waits for a person: show it (optional)
 *       secrets: (name) => Promise<string>,   a secret a connector needs, from the host's store
 *       connectors: { name: connector },      how each kind of target is reached
 *       local: false,                         true adds the `local` connector (tests, serve)
 *                                             the `ssh` connector is added unless `connectors.ssh` is given (null to drop it)
 *       timeout: 10 * 60_000,                 how long a call waits for a person
 *   });
 *   k.pump();                     take what the agents asked since (every half second or so)
 *   k.approvals();                the calls waiting for a person
 *   k.decide(id, 'yes' | 'no' | 'always', by, word)
 *   k.stop(agent?, by)            every target of an agent cut ("*" or none: everybody)
 *   k.journal({ agent, target, since, limit })
 *   k.act(op, args, who)          a person's change from the page, or an agent's call: Promise<{ ok, text, data }>
 *   k.read(verb, args, by)        a person's read from the page (mail.open): never asked, journaled as theirs;
 *                                 Promise<{ ok, text, data: { raw, folder, ref, cut... } | code }>
 *   k.onChange(fn)                something a page shows changed
 *   k.notice({ agent, target, kind, text, ref })   something that happened LATER (a mail returned,
 *                                 a scheduled send that failed): told to the agent and to the person
 *
 * WHO ASKS IS SAID BY THE FOLDER. The application gives each folder its who
 * ({ id, kind: "agent", name }); what an ask says of itself is never believed.
 *
 * `ask` may resolve to "yes", "no", "always", or { decision, by, word }; a
 * person deciding on the page (decide) ends the same request, whichever comes
 * first. Without `ask`, only decide does.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../server/store.mjs';
import { VERBS, Refused, check, detail as detailOf, no, oneLine, isVerb, reads } from '../server/verbs.mjs';
import { decide as rightsOf, ruleFrom, LEVELS, toolDecide, classesOf } from '../server/rights.mjs';
import { lines, notices as noticesOf, sayNotices, TOOLS } from '../server/mcp.mjs';
import { offered, catalogOf, catalogDiff, argsProblem, resultText, TOOLS_FILE } from '../server/external.mjs';
import { mcp as mcpConnector } from './connectors/mcp.mjs';
import { openJournal, hide } from './journal.mjs';
import { approvals as openApprovals, TIMEOUT_MS } from './approvals.mjs';
import { cardOf } from '../server/cards.mjs';
import { local as localConnector } from './connectors/local.mjs';
import { ssh as sshConnector } from './connectors/ssh.mjs';
import { webdav as webdavConnector } from './connectors/webdav.mjs';
import { graph as graphConnector } from './connectors/graph.mjs';
import { mail as mailConnector } from './connectors/mail.mjs';
import { calendar as calendarConnector } from './connectors/calendar.mjs';
import { contacts as contactsConnector } from './connectors/contacts.mjs';
import { device as deviceConnector } from './connectors/device.mjs';

export { openStore, Refused, LEVELS };
/* Older than this when first seen, an ask is not done: its command stopped waiting a while ago. */
export const TOO_LATE_MS = 60_000;
const PERSON = { id: 'person', kind: 'person', name: 'A person' };

const MEANS = {
    watch: 'read only',
    propose: 'you read; every action is asked of a person',
    frame: 'you read, and act where a rule allows; the rest is asked of a person',
    free: 'everything',
};
/* An MCP server's tools, by level (rights.mjs, CLASS_PRESETS). */
const MCP_MEANS = {
    watch: 'its read-only tools',
    propose: 'its tools; a person approves each one that writes or deletes',
    frame: 'its tools, as set class by class',
    free: 'its tools; a person approves each one that deletes or overwrites',
};
const ruleText = (r) => (r.kind === 'path' ? `under ${r.value}` : r.kind === 'verb' ? r.value : r.kind === 'site' ? `site ${r.value}` : `"${r.value}"`);

/* What an agent reads of its targets. */
export function sayTargets(list) {
    if (!list.length) return 'You were given no target.';
    const out = ['Your targets:'];
    for (const t of list) {
        if (t.kind === 'mcp') {
            out.push(`  ${t.id} (mcp) "${t.title}": an external MCP server: ${MCP_MEANS[t.level]}; they are among your tools, named ${t.id}-...${t.tools !== undefined ? ` (${t.tools} now)` : ''}`);
            continue;
        }
        out.push(`  ${t.id} (${t.kind}) "${t.title}": ${t.level}: ${MEANS[t.level]}`);
        if (t.level === 'frame' && t.rules.length) out.push(`      allowed without asking: ${t.rules.map(ruleText).join(', ')}`);
    }
    out.push('Say why in one short line when you act: a person may read it before deciding.');
    return out.join('\n');
}

/* How long a connector may take to say what a request is about, before it is asked anyway. */
const DESCRIBE_MS = 6000;

/* A file an agent handed over (a firmware to flash), put in its folder's files/ by its
   command: read once into the call as base64, then removed. Only a plain name there. */
function withFile(dir, a) {
    if (typeof a.imageFile !== 'string') return a;
    const { imageFile, ...rest } = a;
    if (!/^[0-9a-f-]{36}\.bin$/.test(imageFile)) return rest;
    const file = join(dir, 'files', imageFile);
    try { const image = readFileSync(file).toString('base64'); rmSync(file, { force: true }); return { ...rest, image }; } catch { return rest; }
}

/* How long an act may run before its agent stops waiting (it is then told the act may have been done). */
export const RUN_MS = 10 * 60_000;
const runFor = (verb, a) => (verb === 'terminal.run' && Number(a.timeout) > 0 ? Math.max(RUN_MS, Number(a.timeout) * 1000 + 60_000) : RUN_MS);
/* What a late notice is: mail.bounced, mail.delayed, mail.later-failed... */
const NOTICE_KIND = /^[a-z][a-z0-9.-]{0,40}$/;

export function keeper(dir, { sides = () => [], ask, notify, secrets = async () => { throw new Refused('no secret store was given'); }, connectors = {}, local = false, timeout = TIMEOUT_MS, now = () => Date.now() } = {}) {
    const store = openStore(dir, { now });
    const known = new Set();                         // every secret value handed to a connector
    const journal = openJournal(dir, { now, secrets: () => known });
    const listeners = new Set();
    const changed = (what) => { for (const fn of listeners) { try { fn(what); } catch { /* its fault */ } } };
    const queue = openApprovals({ now, timeout, onChange: (w) => changed({ approvals: w }) });
    const conns = { ...connectors };
    if (local && !conns.local) conns.local = localConnector();
    /* The SSH connector is wired in by default: it is only a client, holds
       nothing until a target asks it to connect, and loads ssh2 lazily. A host
       that does not want it passes `connectors: { ssh: null }`. */
    if (!('ssh' in conns)) conns.ssh = sshConnector();
    /* The online-folder connectors are wired in by default too: each is a plain
       HTTPS client that holds nothing until a target asks it to connect (webdav
       holds nothing at all; graph caches only a token it fetched). A host that
       does not want one passes `connectors: { webdav: null }` / `{ graph: null }`. */
    if (!('webdav' in conns)) conns.webdav = webdavConnector();
    if (!('graph' in conns)) conns.graph = graphConnector();
    /* The mail connector, wired in by default: an IMAP client that holds nothing
       until a target asks it to connect, and caches only a token it minted from the
       stored refresh token. A host that does not want it passes `{ mail: null }`. */
    if (!('mail' in conns)) conns.mail = mailConnector();
    if (!('calendar' in conns)) conns.calendar = calendarConnector();
    if (!('contacts' in conns)) conns.contacts = contactsConnector();
    /* Work done in a person's browser (a device to flash): it waits for a page to run it. */
    if (!('device' in conns)) conns.device = deviceConnector({ now });
    /* External MCP servers: an HTTP client that holds nothing until a target of kind mcp is listed or called. */
    if (!('mcp' in conns)) conns.mcp = mcpConnector({ now });
    /* What a connector is handed for one target: who asks, and its secrets by the
       name the target gives them (the host keeps the values). */
    const ctxOf = (t, agent) => ({
        agent,
        secret: async (key) => {
            const name = t.secrets?.[key];
            if (!name) no(`${t.title} names no secret "${key}"`);
            const value = await secrets(name);
            if (typeof value === 'string' && value) known.add(value);
            return value;
        },
    });
    /* A connector with work of its own at a set time (a mail sent later) is woken
       once with the keeper's hand, then ticked each minute. */
    const tickers = Object.values(conns).filter((c) => typeof c?.tick === 'function');
    for (const c of tickers) c.wake?.({ dir, now, target: (id) => store.target(id), ctx: ctxOf, stopped: (id) => store.stopped(id), note: (line) => journal.append({ ...line, ...(line.agent ? { agent: { id: line.agent.id, name: nameOf(line.agent.id) } } : {}) }), notice: (n) => notice(n) });
    const ticker = tickers.length ? setInterval(() => { for (const c of tickers) Promise.resolve(c.tick()).catch(() => { /* tried again next minute */ }); }, 60_000) : null;
    ticker?.unref?.();
    store.onChange((w) => changed({ store: w }));
    journal.onAppend((l) => changed({ journal: l }));

    /* ---- what happened later ----
       A mail that came back, a scheduled send that failed: no ask waits for it. A notice is
       journaled (op "notice"), appended to the agent's folder (notices.jsonl: its MCP server
       tells it on its next call, or with the notices tool), handed to the application
       (`notify`: to show it to the person and wake the agent), and said to the pages (onChange). */
    function notice({ agent, target, kind, text, ref } = {}) {
        const id = oneLine(agent && typeof agent === 'object' ? agent.id : agent, 100);
        const k = oneLine(kind, 41);
        if (!NOTICE_KIND.test(k)) no('a notice needs a kind, like mail.bounced');
        const t = target && typeof target === 'object' && target.id ? { id: oneLine(target.id, 100), title: oneLine(target.title ?? store.target(target.id)?.title, 200) } : null;
        const n = { id: randomUUID(), at: new Date(now()).toISOString(), agent: id || null, ...(t ? { target: t } : {}), kind: k, text: hide(oneLine(text, 1000), known), ...(ref ? { ref: oneLine(ref, 300) } : {}) };
        journal.append({ op: 'notice', agent: id ? { id, name: nameOf(id) } : undefined, target: t ?? undefined, kind: k, detail: n.text, ref: n.ref });
        const side = id ? sides().find((s) => s.who?.id === id) : null;
        if (side) { try { mkdirSync(side.dir, { recursive: true }); appendFileSync(join(side.dir, 'notices.jsonl'), `${JSON.stringify(n)}\n`); } catch { /* journaled and told anyway */ } }
        try { notify?.(n); } catch { /* the application's */ }
        changed({ notice: n });
        return n;
    }

    const agents = () => sides().map((s) => s.who);
    const nameOf = (id) => agents().find((w) => w.id === id)?.name ?? id;
    const agentRef = (who) => ({ id: who.id, name: who.name ?? who.id });
    const byRef = (by) => (by ? { id: oneLine(by.id, 100) || PERSON.id, name: oneLine(by.name, 80) || PERSON.name } : null);
    const minutes = Math.round(timeout / 60_000);

    /* ---- an agent's call ---- */
    async function call(verb, given, who, { held, started: begun } = {}) {
        const me = agentRef(who);
        if (store.stopped(who.id)) {
            journal.append({ agent: me, verb, decision: 'stopped' });
            no('a person stopped everything for you: nothing was done');
        }
        const a = check(verb, given);
        if (verb === 'targets') {
            const all = store.targets();
            const mine = all.filter((t) => t.kind === 'mcp').length ? offered(all, who.id, { reserved: RESERVED }) : [];
            const list = all.filter((t) => t.grants[who.id]).map((t) => ({ id: t.id, title: t.title, kind: t.kind, level: t.grants[who.id].level, rules: t.grants[who.id].rules,
                ...(t.kind === 'mcp' ? { tools: mine.filter((x) => x.target === t.id).length } : {}) }));
            return { text: sayTargets(list), data: list };
        }
        /* Its own requests still waiting for a person, and taking one back. Scoped to
           the agent: a conversation sees and withdraws only its own, never another's. */
        if (verb === 'pending') {
            const list = queue.list(me.id).map((r) => ({ id: r.id, verb: r.verb, target: r.target?.title ?? null, detail: r.detail ?? '', why: r.why ?? '', since: r.at }));
            return { text: list.length ? list.map((r) => `${r.id}  ${r.verb}${r.target ? ` on ${r.target}` : ''}${r.detail ? ` — ${r.detail}` : ''}${r.why ? ` (${r.why})` : ''}`).join('\n') : 'No request of yours is waiting for a person.', data: list };
        }
        if (verb === 'notices') {
            const side = sides().find((s) => s.who?.id === who.id);
            const list = side ? noticesOf(side.dir, { all: a.all === true }) : [];
            return { text: list.length ? sayNotices(list) : 'Nothing new happened since.', data: list };
        }
        if (verb === 'withdraw') {
            queue.withdraw(oneLine(a.id, 100), me.id, a.reason);
            journal.append({ agent: me, verb: 'withdraw', detail: oneLine(a.id, 100), ...(a.reason ? { word: oneLine(a.reason, 200) } : {}) });
            return { text: `Withdrew the request ${oneLine(a.id, 100)}: it can no longer be approved.` };
        }
        const t = store.target(a.target);
        const g = t?.grants?.[who.id];
        if (!t || !g) no(`no target ${a.target} that you were given`);
        if (!VERBS[verb].kinds.includes(t.kind)) no(`${verb} is not for a ${t.kind} target`);
        if (VERBS[verb].done === false) no(`${verb} is not available yet`);
        const conn = conns[t.connector];
        if (!conn) no(`${t.title} cannot be reached from here: its connector is off`);
        /* A tool of an external MCP server: the keeper's own catalog says what it is, never the agent's list. */
        const tool = t.kind === 'mcp' ? (t.catalog?.tools ?? []).find((x) => x.name === a.tool) ?? null : null;
        const base = { agent: me, target: { id: t.id, title: t.title }, verb, detail: detailOf(verb, a), why: a.why, ...(tool ? { tool: tool.name, class: tool.class } : {}) };
        if (t.kind === 'mcp' && !tool) {
            journal.append({ ...base, decision: 'refused', because: 'tool' });
            no(`${t.title} has no tool ${oneLine(a.tool, 128)} (its list may have changed: look at your tools again) -- nothing was done`);
        }
        const d = tool ? toolDecide(g, tool) : rightsOf(g.level, verb, a, g.rules);
        if (d.go === 'no') {
            journal.append({ ...base, decision: 'refused', because: d.because, level: g.level });
            if (tool) no(`${t.title}: the tool ${tool.name} (${tool.class}) is not allowed to you -- nothing was done`);
            no(`${t.title} is at level ${g.level}: ${MEANS[g.level]}`);
        }
        if (tool) {
            const problem = argsProblem(tool.inputSchema, a.arguments);
            if (problem) no(`${tool.name}: ${problem} -- nothing was done`);
            try { conn.admit?.(t, who.id); } catch (e) { journal.append({ ...base, decision: 'refused', because: 'rate' }); throw e; }
        }
        let outcome = { decision: 'auto' }; let asked = null;
        if (d.go === 'ask') {
            /* "Always" on an external tool: yes for that tool, for this agent -- never for a destructive one (only the page sets that). */
            const rule = tool ? (tool.class !== 'destructive' ? { kind: 'tool', value: tool.name } : null) : ruleFrom(verb, a);
            /* What a person approves, as facts for a card; and what it is about (the mail
               answered, the invitation), when the connector can tell -- a read, briefly. */
            const card = cardOf(verb, a, t, tool);
            if (typeof conn.describe === 'function') {
                try {
                    const about = await Promise.race([conn.describe(verb, t, a, ctxOf(t, who.id)), new Promise((r) => { setTimeout(() => r(null), DESCRIBE_MS).unref?.(); })]);
                    if (about && typeof about === 'object') card.about = about;
                } catch { /* the card says less, the request still goes */ }
            }
            const { request, decision } = queue.open({ ...base, card, level: g.level, ...(rule ? { rule } : {}) });
            asked = request.id;
            try { held?.(request); } catch { /* the folder's */ }
            if (ask) {
                Promise.resolve().then(() => ask(request)).then((v) => {
                    if (!v || !queue.get(request.id)) return;
                    const o = typeof v === 'string' ? { decision: v } : v;
                    try { queue.decide(request.id, o.decision, byRef(o.by ?? PERSON), o.word); } catch { /* decided already */ }
                }, () => {});
            }
            outcome = await decision;
            if (outcome.decision === 'always' && rule && tool) {
                try {
                    store.toolRights(t.id, who.id, { tools: { [tool.name]: 'yes' } });
                    journal.append({ op: 'allow', agent: me, target: base.target, rule, by: outcome.by });
                } catch { /* the call is still approved */ }
            } else if (outcome.decision === 'always' && rule) {
                try {
                    store.allow(t.id, who.id, rule);
                    journal.append({ op: 'allow', agent: me, target: base.target, rule, by: outcome.by });
                    /* Rules count from "frame" up: at "propose", "always" would add a rule that
                       never applies. The target moves to "frame", and the screen says so. */
                    if (store.grantOf(t.id, who.id)?.level === 'propose') {
                        store.grant(t.id, who.id, 'frame');
                        journal.append({ op: 'level', agent: me, target: base.target, level: 'frame', by: outcome.by });
                    }
                } catch { /* the call is still approved */ }
            }
            if (outcome.decision !== 'yes' && outcome.decision !== 'always') {
                journal.append({ ...base, decision: outcome.decision, by: outcome.by, word: outcome.word });
                if (outcome.decision === 'no') no(`refused by ${outcome.by?.name ?? 'a person'}${outcome.word ? `: "${outcome.word}"` : ''}`);
                if (outcome.decision === 'timeout') no(`not answered within ${minutes} minute${minutes === 1 ? '' : 's'}: nothing was done`);
                if (outcome.decision === 'withdrawn') no(`withdrawn by the AI${outcome.word ? `: "${outcome.word}"` : ''}: nothing was done`);
                no('a person stopped everything for you: nothing was done');
            }
            if (store.stopped(who.id)) no('a person stopped everything for you: nothing was done');
        }
        const started = now();
        /* A connector whose work waits for a person (a job run in their browser) says how much longer: the agent's ask keeps waiting. */
        const ctx = { ...ctxOf(t, who.id), hold: (until) => { try { held?.({ until, id: `${verb}:${t.id}` }); } catch { /* the folder's */ } changed({ jobs: verb }); } };
        /* The act begins: its agent keeps waiting while it runs, and a keeper restarted now knows
           it may have been done -- never run twice, never answered "nothing was done". */
        try { begun?.({ until: new Date(now() + runFor(verb, a)).toISOString() }); } catch { /* the folder's */ }
        let res; let ok = true; let error;
        try { res = await conn.run(verb, t, a, ctx); } catch (e) {
            ok = false; error = e instanceof Refused ? e.message : `failed: ${e?.message ?? e}`;
        }
        /* An external server's answer: marked as data from that server, never instructions, and cut to size. */
        if (ok && tool) res = resultText(t.title, tool.name, res);
        /* What happened is told even if the journal cannot keep it (a full disk): a done act is never answered "not done" (loop 18). */
        let unjournaled = false;
        try { journal.append({ ...base, decision: outcome.decision, because: d.go === 'yes' ? d.because : undefined, by: outcome.by, ok: ok && !res?.toolError, error: error ?? (res?.toolError ? 'the tool reported an error' : undefined), size: res?.size, exit: res?.exit, ms: now() - started, request: asked }); } catch { unjournaled = true; }
        if (ok && unjournaled) res = { ...res, text: `${res.text}\n(The journal could not record this act.)` };
        if (!ok) no(hide(error, known));
        return { text: hide(res.text, known), data: { ...(res.exit !== undefined ? { exit: res.exit } : {}), size: res.size ?? 0 } };
    }

    /* ---- a person's change, from the page ---- */
    function person(op, a, who) {
        const by = byRef(who);
        switch (op) {
            case 'agents': return agents();
            case 'targets': return store.targets().map(({ secrets: s, ...t }) => ({ ...t, secrets: Object.keys(s ?? {}) }));
            case 'approvals': return queue.list(a.agent);
            case 'journal': return journal.read(a);
            case 'stops': return store.stops();
            case 'state': return { agents: agents(), targets: person('targets', {}, who), approvals: queue.list(), jobs: conns.device?.jobs?.() ?? [], stops: store.stops(), journal: journal.read({ agent: a.agent, limit: a.limit ?? 50 }), timeout };
            case 'jobs': return conns.device?.jobs?.() ?? [];
            case 'job-file': { if (!conns.device) no('no device connector'); return conns.device.file(a.id); }
            case 'job-done': { if (!conns.device) no('no device connector'); const r = conns.device.finish(a.id, a.ok, a.text); changed({ jobs: a.id }); return r; }
            case 'decide': return api.decide(a.id, a.decision, by, a.word);
            case 'stop': return api.stop(a.agent, by);
            case 'resume': return api.resume(a.agent, by);
            case 'level': {
                const g = store.grant(a.target, a.agent, a.level ?? null);
                journal.append({ op: 'level', agent: { id: a.agent, name: nameOf(a.agent) }, target: { id: a.target, title: store.target(a.target)?.title }, level: a.level ?? 'none', by });
                return g;
            }
            case 'allow': case 'unallow': {
                const r = op === 'allow' ? store.allow(a.target, a.agent, a.rule) : store.unallow(a.target, a.agent, a.rule);
                journal.append({ op, agent: { id: a.agent, name: nameOf(a.agent) }, target: { id: a.target, title: store.target(a.target)?.title }, rule: r, by });
                return r;
            }
            case 'put-target': {
                const t = store.putTarget(a);
                if (t.kind === 'mcp') { conns[t.connector]?.forget?.(t.id); void refresh(t.id).catch(() => { /* said in its catalog */ }); }
                return t;
            }
            case 'remove-target': { const r = store.removeTarget(a.target); for (const c of Object.values(conns)) { try { c?.forget?.(r.id); } catch { /* gone */ } } return r; }
            /* AN EXTERNAL MCP SERVER, from the page: its name, its address, the NAME of the secret that holds
               its key (never the key: the application keeps it in its vault). Listed at once. */
            case 'mcp-add': return addServer(a);
            /* A file in the usual form ({ "mcpServers": { name: { url, headers } } }) where every key is a
               reference to a secret, "${NAME}": servers made from it. A value written in it is refused. */
            case 'mcp-import': return importServers(a.config);
            case 'mcp-refresh': return refresh(oneLine(a.target, 100));
            case 'mcp-rights': {
                const g = store.toolRights(a.target, a.agent, { classes: a.classes, tools: a.tools, askOpen: a.askOpen });
                const said = [a.classes ? Object.entries(a.classes).map(([k, v]) => `${k}: ${v ?? 'as its level'}`).join(', ') : '', a.tools ? Object.entries(a.tools).map(([k, v]) => `${k}: ${v ?? 'as its class'}`).join(', ') : '', a.askOpen !== undefined ? `ask what reaches outside: ${a.askOpen === true}` : ''].filter(Boolean).join('; ');
                journal.append({ op: 'tools', agent: { id: a.agent, name: nameOf(a.agent) }, target: { id: a.target, title: store.target(a.target)?.title }, detail: said, by });
                return { ...g, classes: classesOf(g) };
            }
            default: return no(`there is no ${oneLine(op, 40)}`);
        }
    }

    /* ---- a person's read, from the application's page ----
       A page opening a mail cited to a person (mail.open): a READ only, on a target the application holds,
       for a person it has already checked may read it (Tether does not know the application's people). Never
       asked of anyone, never an agent's: journaled as that person's read (op "read"). The connector gives the
       bytes whole (ctx.person), handed back here and nowhere else: nothing is kept. */
    async function read(verb, args = {}, by) {
        const who = byRef(by ?? PERSON);
        try {
            if (!isVerb(oneLine(verb, 40)) || !reads(verb) || !VERBS[verb].kinds) no(`${oneLine(verb, 40)} is not a read a person may ask here`);
            const a = check(verb, args && typeof args === 'object' ? args : {});
            const t = store.target(a.target);
            if (!t) no(`no target ${a.target}`);
            if (!VERBS[verb].kinds.includes(t.kind)) no(`${verb} is not for a ${t.kind} target`);
            const conn = conns[t.connector];
            if (!conn) no(`${t.title} cannot be reached from here: its connector is off`);
            const started = now();
            let res; let error; let code;
            try { res = await conn.run(verb, t, a, { ...ctxOf(t, who.id), person: who }); } catch (e) { error = e instanceof Refused ? e.message : `failed: ${e?.message ?? e}`; code = e?.code; }
            try { journal.append({ op: 'read', by: who, target: { id: t.id, title: t.title }, verb, detail: detailOf(verb, a), ok: !error, error, size: res?.size, ms: now() - started }); } catch { /* the read is answered anyway */ }
            if (error) return { ok: false, text: hide(error, known), ...(code ? { code } : {}) };
            const { text, size, ...rest } = res ?? {};
            return { ok: true, text: hide(text ?? '', known), data: { size: size ?? 0, ...rest } };
        } catch (e) {
            if (e instanceof Refused) return { ok: false, text: e.message, ...(e.code ? { code: e.code } : {}) };
            return { ok: false, text: `failed: ${e?.message ?? e}` };
        }
    }

    async function act(op, args = {}, who, opts) {
        const a = args && typeof args === 'object' ? args : {};
        try {
            if (who?.kind === 'person') return { ok: true, text: 'Done.', data: await person(oneLine(op, 40), a, who) };
            if (!who?.id) no('nobody said who they are');
            const r = await call(oneLine(op, 40), a, who, opts);
            return { ok: true, text: r.text, data: r.data };
        } catch (e) {
            if (e instanceof Refused) return { ok: false, text: e.message };
            return { ok: false, text: `failed: ${e?.message ?? e}` };
        }
    }

    /* What each folder asked and was not answered yet: started, answered when done. */
    const busy = new Set();
    const write = (side, line) => { mkdirSync(side.dir, { recursive: true }); appendFileSync(join(side.dir, 'answers.jsonl'), `${JSON.stringify({ at: new Date(now()).toISOString(), ...line })}\n`); };
    function pump() {
        let n = 0;
        try { offerTools(); } catch { /* written again next time */ }
        for (const side of sides()) {
            const answers = lines(join(side.dir, 'answers.jsonl'));
            const done = new Set(answers.filter((x) => x.held !== true).map((x) => x.ask));
            const holding = new Set(answers.filter((x) => x.held === true).map((x) => x.ask));
            const running = new Set(answers.filter((x) => x.held === true && x.running === true).map((x) => x.ask));
            for (const q of lines(join(side.dir, 'asks.jsonl'))) {
                if (typeof q.id !== 'string' || done.has(q.id)) continue;
                const key = `${side.dir}\n${q.id}`;
                if (busy.has(key)) continue;
                n++;
                /* Held by a keeper that is no longer the one running: the person never saw it here. */
                if (running.has(q.id)) { write(side, { ask: q.id, ok: false, text: 'not answered: its keeper restarted while doing it -- it may have been done: check (a list, a read) before asking again' }); continue; }
                if (holding.has(q.id)) { write(side, { ask: q.id, ok: false, text: 'not answered: its keeper restarted; nothing was done, ask again' }); continue; }
                if (!(now() - Date.parse(q.at) < TOO_LATE_MS)) { write(side, { ask: q.id, ok: false, text: 'too late: this ask waited too long and was not done' }); continue; }
                busy.add(key);
                /* Taken: the agent keeps waiting while the keeper works out what to ask a person (loop 28: a late pickup
                   was answered "nothing was done" while its card still reached the person). Never the person's hold. */
                write(side, { ask: q.id, held: true, taken: true, until: new Date(now() + 2 * DESCRIBE_MS + 30_000).toISOString() });
                act(oneLine(q.op, 40), withFile(side.dir, q.args && typeof q.args === 'object' ? q.args : {}), side.who, { held: (request) => write(side, { ask: q.id, held: true, until: request.until, request: request.id }), started: ({ until }) => write(side, { ask: q.id, held: true, running: true, until }) })
                    .then((r) => write(side, { ask: q.id, ok: r.ok, text: r.text, ...(r.data && !Array.isArray(r.data) ? { data: r.data } : {}) }))
                    .catch((e) => write(side, { ask: q.id, ok: false, text: `failed: ${e?.message ?? e}` }))
                    .finally(() => busy.delete(key));
            }
        }
        queue.expire();
        return n;
    }

    /* ---- external MCP servers ---- */
    const RESERVED = TOOLS.map((x) => x.name);
    const SECRET_REF = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$/;
    function serverConfig(a) {
        const url = String(a.url ?? '').trim();
        let u; try { u = new URL(url); } catch { no('the address of an MCP server is a URL, like https://mcp.example.com/mcp'); }
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && a.allowHttp === true)) no('the address must be https (plain http only where allowed, for a local network)');
        if (u.username || u.password) no('no user or password in the address: the key is a secret, named apart');
        const config = { url: u.href };
        if (a.header) { const h = oneLine(a.header, 60); if (!/^[A-Za-z0-9-]{1,60}$/.test(h)) no('the header is a header name, like Authorization or X-API-Key'); config.header = h; }
        if (a.allowHttp === true) config.allowHttp = true;
        for (const k of ['perMinute', 'perDay']) if (a[k] !== undefined && a[k] !== null && a[k] !== '') { const n = Math.trunc(Number(a[k])); if (!(n > 0)) no(`${k} is a number of calls`); config[k] = n; }
        return config;
    }
    async function addServer(a) {
        const title = oneLine(a.title ?? a.name, 120);
        if (!title) no('an MCP server needs a name');
        const secret = a.secret === undefined || a.secret === null || a.secret === '' ? '' : oneLine(a.secret, 200);
        if (secret && !SECRET_REF.test(secret)) no('the key is given by the NAME of a secret of the vault, never by its value');
        const t = store.putTarget({ id: a.id, title, kind: 'mcp', connector: 'mcp', config: serverConfig(a), secrets: secret ? { token: secret } : {} });
        conns.mcp?.forget?.(t.id);
        let catalog = null; let error = '';
        try { catalog = await refresh(t.id); } catch (e) { error = e.message; }
        const { secrets: sec, ...shown } = store.target(t.id);
        return { ...shown, secrets: Object.keys(sec ?? {}), ...(catalog ? {} : { error }) };
    }
    async function importServers(config) {
        const all = config && typeof config === 'object' ? (config.mcpServers ?? config.servers) : null;
        if (!all || typeof all !== 'object' || Array.isArray(all)) no('the file holds { "mcpServers": { "name": { "url": "https://...", "headers": { "Authorization": "Bearer ${SECRET_NAME}" } } } }');
        const made = [];
        for (const [name, s] of Object.entries(all)) {
            if (!s || typeof s !== 'object') no(`${oneLine(name, 60)}: not a server`);
            if (s.command) no(`${oneLine(name, 60)}: a program to start (stdio) is not run here; only servers reached by an address`);
            const url = s.url ?? s.serverUrl;
            const heads = s.headers && typeof s.headers === 'object' ? Object.entries(s.headers) : [];
            if (heads.length > 1) no(`${oneLine(name, 60)}: one header for the key at most`);
            let header; let secret;
            for (const [h, v] of heads) {
                const m = /^(Bearer\s+)?\$\{([A-Za-z0-9_][A-Za-z0-9_.:-]{0,99})\}$/.exec(String(v ?? '').trim());
                if (!m) no(`${oneLine(name, 60)}: the header ${oneLine(h, 60)} holds a value, not a reference to a secret ("\${NAME}") -- nothing was made`);
                if (h.toLowerCase() === 'authorization' && !m[1]) no(`${oneLine(name, 60)}: Authorization is "Bearer \${NAME}"`);
                header = h.toLowerCase() === 'authorization' ? undefined : h; secret = m[2];
            }
            made.push({ title: name, url, header, secret, allowHttp: s.allowHttp === true });
        }
        for (const m of made) serverConfig(m);
        const out = [];
        for (const m of made) out.push(await addServer(m));
        return out;
    }
    /* A server listed again: one at a time each; asked again meanwhile, once more after. */
    const refreshing = new Map();
    function refresh(id) {
        const on = refreshing.get(id);
        if (on) { on.again = true; return on.done; }
        const entry = { again: false };
        entry.done = (async () => {
            try { let c; do { entry.again = false; c = await listOnce(id); } while (entry.again); return c; } finally { refreshing.delete(id); }
        })();
        refreshing.set(id, entry);
        return entry.done;
    }
    async function listOnce(id) {
        const t = store.target(id);
        if (!t || t.kind !== 'mcp') no(`no MCP server ${oneLine(id, 100)}`);
        const conn = conns[t.connector];
        if (typeof conn?.discover !== 'function') no(`${t.title} cannot be reached from here: its connector is off`);
        const target = { id: t.id, title: t.title };
        try {
            const raw = await conn.discover(t, ctxOf(t, 'keeper'));
            let tools = catalogOf(raw);
            /* A server that writes the key back into its list never has it shown. */
            try { tools = JSON.parse(hide(JSON.stringify(tools), known)); } catch { /* kept as listed */ }
            const diff = catalogDiff(t.catalog?.tools ?? [], tools);
            const c = store.setCatalog(t.id, { tools });
            if (!t.catalog || t.catalog.error || diff.added.length || diff.removed.length || diff.changed.length) {
                const said = [diff.added.length ? `+ ${diff.added.join(', ')}` : '', diff.removed.length ? `- ${diff.removed.join(', ')}` : '', diff.changed.length ? `~ ${diff.changed.join(', ')}` : ''].filter(Boolean).join('; ');
                journal.append({ op: 'catalog', target, detail: `${tools.length} tool${tools.length === 1 ? '' : 's'}${said ? `: ${said}` : ''}`, ok: true });
            }
            return c;
        } catch (e) {
            const msg = hide(e instanceof Refused ? e.message : `failed: ${e?.message ?? e}`, known);
            try { store.setCatalog(t.id, { error: msg }); } catch { /* removed meanwhile */ }
            journal.append({ op: 'catalog', target, ok: false, error: msg });
            throw new Refused(msg);
        }
    }
    /* Each agent's external tools, in its folder (tools.json): written when they change. The agent's
       MCP server reads it and tells the agent; a call is checked here again, whatever the file says. */
    let toolsGen = 0; let toolsSeen = -1;
    const toolsWritten = new Map();
    store.onChange(() => { toolsGen++; });
    function offerTools() {
        const list = sides();
        if (toolsSeen === toolsGen && list.every((s) => toolsWritten.has(s.dir))) return;
        toolsSeen = toolsGen;
        const all = store.targets();
        const any = all.some((t) => t.kind === 'mcp');
        for (const side of list) {
            const tools = any ? offered(all, side.who.id, { reserved: RESERVED, stopped: store.stopped(side.who.id) }) : [];
            const text = hide(JSON.stringify({ v: 1, tools }), known);
            if (toolsWritten.get(side.dir) === text) continue;
            const file = join(side.dir, TOOLS_FILE);
            let there = null;
            try { if (!lstatSync(file).isSymbolicLink()) there = readFileSync(file, 'utf8'); } catch { /* none yet */ }
            if (there === text || (there === null && !tools.length)) { toolsWritten.set(side.dir, text); continue; }
            mkdirSync(side.dir, { recursive: true });
            /* A fresh name, created only if nothing is there (a link the agent planted is never followed), then put in place whole. */
            const tmp = join(side.dir, `.${TOOLS_FILE}.${randomUUID()}.tmp`);
            writeFileSync(tmp, text, { flag: 'wx' }); renameSync(tmp, file);
            toolsWritten.set(side.dir, text);
        }
    }
    conns.mcp?.attach?.({ changed: (id) => { void refresh(id).catch(() => { /* said in its catalog */ }); }, targets: () => store.targets().filter((t) => t.kind === 'mcp' && t.connector === 'mcp') });
    /* Listed once at the start: their streams of changes listened to again. */
    for (const t of store.targets()) if (t.kind === 'mcp') void refresh(t.id).catch(() => { /* said in its catalog */ });

    const api = {
        store,
        /* An MCP server listed again now: Promise<catalog>. */
        refresh,
        act,
        read,
        pump,
        approvals: (agent) => queue.list(agent),
        /* Approved calls that wait for a person's browser (a device to flash). */
        jobs: () => conns.device?.jobs?.() ?? [],
        decide: (id, decision, by = PERSON, word = '') => queue.decide(oneLine(id, 100), decision, byRef(by), word),
        async stop(agent, by = PERSON) {
            const who = oneLine(agent, 100) || '*';
            store.stop(who);
            const ended = queue.stop(who, byRef(by));
            for (const c of Object.values(conns)) { try { await c.close?.(who); } catch { /* still stopped */ } }
            journal.append({ op: 'stop', agent: { id: who, name: who === '*' ? 'everybody' : nameOf(who) }, by: byRef(by) });
            return { stopped: who, ended };
        },
        resume(agent, by = PERSON) {
            const who = oneLine(agent, 100) || '*';
            store.resume(who);
            journal.append({ op: 'resume', agent: { id: who, name: who === '*' ? 'everybody' : nameOf(who) }, by: byRef(by) });
            return { resumed: who };
        },
        journal: (query) => journal.read(query),
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        notice,
        connectors: conns,
        /* Every connector taken down: terminals, running commands. */
        async close() { clearInterval(ticker); queue.stop('*'); for (const c of Object.values(conns)) { try { await (c.shutdown ?? c.close)?.call(c, '*'); } catch { /* down anyway */ } } },
    };
    return api;
}
