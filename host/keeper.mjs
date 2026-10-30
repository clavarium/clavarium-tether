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
 *   k.onChange(fn)                something a page shows changed
 *
 * WHO ASKS IS SAID BY THE FOLDER. The application gives each folder its who
 * ({ id, kind: "agent", name }); what an ask says of itself is never believed.
 *
 * `ask` may resolve to "yes", "no", "always", or { decision, by, word }; a
 * person deciding on the page (decide) ends the same request, whichever comes
 * first. Without `ask`, only decide does.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { VERBS, Refused, check, detail as detailOf, no, oneLine } from '../server/verbs.mjs';
import { decide as rightsOf, ruleFrom, LEVELS } from '../server/rights.mjs';
import { lines } from '../server/mcp.mjs';
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
const ruleText = (r) => (r.kind === 'path' ? `under ${r.value}` : r.kind === 'verb' ? r.value : r.kind === 'site' ? `site ${r.value}` : `"${r.value}"`);

/* What an agent reads of its targets. */
export function sayTargets(list) {
    if (!list.length) return 'You were given no target.';
    const out = ['Your targets:'];
    for (const t of list) {
        out.push(`  ${t.id} (${t.kind}) "${t.title}": ${t.level}: ${MEANS[t.level]}`);
        if (t.level === 'frame' && t.rules.length) out.push(`      allowed without asking: ${t.rules.map(ruleText).join(', ')}`);
    }
    out.push('Say why in one short line when you act: a person may read it before deciding.');
    return out.join('\n');
}

/* How long a connector may take to say what a request is about, before it is asked anyway. */
const DESCRIBE_MS = 6000;

export function keeper(dir, { sides = () => [], ask, secrets = async () => { throw new Refused('no secret store was given'); }, connectors = {}, local = false, timeout = TIMEOUT_MS, now = () => Date.now() } = {}) {
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
    for (const c of tickers) c.wake?.({ dir, now, target: (id) => store.target(id), ctx: ctxOf, stopped: (id) => store.stopped(id), note: (line) => journal.append({ ...line, ...(line.agent ? { agent: { id: line.agent.id, name: nameOf(line.agent.id) } } : {}) }) });
    const ticker = tickers.length ? setInterval(() => { for (const c of tickers) Promise.resolve(c.tick()).catch(() => { /* tried again next minute */ }); }, 60_000) : null;
    ticker?.unref?.();
    store.onChange((w) => changed({ store: w }));
    journal.onAppend((l) => changed({ journal: l }));

    const agents = () => sides().map((s) => s.who);
    const nameOf = (id) => agents().find((w) => w.id === id)?.name ?? id;
    const agentRef = (who) => ({ id: who.id, name: who.name ?? who.id });
    const byRef = (by) => (by ? { id: oneLine(by.id, 100) || PERSON.id, name: oneLine(by.name, 80) || PERSON.name } : null);
    const minutes = Math.round(timeout / 60_000);

    /* ---- an agent's call ---- */
    async function call(verb, given, who, { held } = {}) {
        const me = agentRef(who);
        if (store.stopped(who.id)) {
            journal.append({ agent: me, verb, decision: 'stopped' });
            no('a person stopped everything for you: nothing was done');
        }
        const a = check(verb, given);
        if (verb === 'targets') {
            const list = store.targets().filter((t) => t.grants[who.id]).map((t) => ({ id: t.id, title: t.title, kind: t.kind, level: t.grants[who.id].level, rules: t.grants[who.id].rules }));
            return { text: sayTargets(list), data: list };
        }
        /* Its own requests still waiting for a person, and taking one back. Scoped to
           the agent: a conversation sees and withdraws only its own, never another's. */
        if (verb === 'pending') {
            const list = queue.list(me.id).map((r) => ({ id: r.id, verb: r.verb, target: r.target?.title ?? null, detail: r.detail ?? '', why: r.why ?? '', since: r.at }));
            return { text: list.length ? list.map((r) => `${r.id}  ${r.verb}${r.target ? ` on ${r.target}` : ''}${r.detail ? ` — ${r.detail}` : ''}${r.why ? ` (${r.why})` : ''}`).join('\n') : 'No request of yours is waiting for a person.', data: list };
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
        const base = { agent: me, target: { id: t.id, title: t.title }, verb, detail: detailOf(verb, a), why: a.why };
        const d = rightsOf(g.level, verb, a, g.rules);
        if (d.go === 'no') {
            journal.append({ ...base, decision: 'refused', because: 'level', level: g.level });
            no(`${t.title} is at level ${g.level}: ${MEANS[g.level]}`);
        }
        let outcome = { decision: 'auto' };
        if (d.go === 'ask') {
            const rule = ruleFrom(verb, a);
            /* What a person approves, as facts for a card; and what it is about (the mail
               answered, the invitation), when the connector can tell -- a read, briefly. */
            const card = cardOf(verb, a, t);
            if (typeof conn.describe === 'function') {
                try {
                    const about = await Promise.race([conn.describe(verb, t, a, ctxOf(t, who.id)), new Promise((r) => { setTimeout(() => r(null), DESCRIBE_MS).unref?.(); })]);
                    if (about && typeof about === 'object') card.about = about;
                } catch { /* the card says less, the request still goes */ }
            }
            const { request, decision } = queue.open({ ...base, card, level: g.level, ...(rule ? { rule } : {}) });
            try { held?.(request); } catch { /* the folder's */ }
            if (ask) {
                Promise.resolve().then(() => ask(request)).then((v) => {
                    if (!v || !queue.get(request.id)) return;
                    const o = typeof v === 'string' ? { decision: v } : v;
                    try { queue.decide(request.id, o.decision, byRef(o.by ?? PERSON), o.word); } catch { /* decided already */ }
                }, () => {});
            }
            outcome = await decision;
            if (outcome.decision === 'always' && rule) {
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
        const ctx = ctxOf(t, who.id);
        let res; let ok = true; let error;
        try { res = await conn.run(verb, t, a, ctx); } catch (e) {
            ok = false; error = e instanceof Refused ? e.message : `failed: ${e?.message ?? e}`;
        }
        journal.append({ ...base, decision: outcome.decision, because: d.go === 'yes' ? d.because : undefined, by: outcome.by, ok, error, size: res?.size, exit: res?.exit, ms: now() - started });
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
            case 'state': return { agents: agents(), targets: person('targets', {}, who), approvals: queue.list(), stops: store.stops(), journal: journal.read({ agent: a.agent, limit: a.limit ?? 50 }), timeout };
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
            case 'put-target': return store.putTarget(a);
            case 'remove-target': return store.removeTarget(a.target);
            default: return no(`there is no ${oneLine(op, 40)}`);
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
        for (const side of sides()) {
            const answers = lines(join(side.dir, 'answers.jsonl'));
            const done = new Set(answers.filter((x) => x.held !== true).map((x) => x.ask));
            const holding = new Set(answers.filter((x) => x.held === true).map((x) => x.ask));
            for (const q of lines(join(side.dir, 'asks.jsonl'))) {
                if (typeof q.id !== 'string' || done.has(q.id)) continue;
                const key = `${side.dir}\n${q.id}`;
                if (busy.has(key)) continue;
                n++;
                /* Held by a keeper that is no longer the one running: the person never saw it here. */
                if (holding.has(q.id)) { write(side, { ask: q.id, ok: false, text: 'not answered: its keeper restarted; nothing was done, ask again' }); continue; }
                if (!(now() - Date.parse(q.at) < TOO_LATE_MS)) { write(side, { ask: q.id, ok: false, text: 'too late: this ask waited too long and was not done' }); continue; }
                busy.add(key);
                act(oneLine(q.op, 40), q.args && typeof q.args === 'object' ? q.args : {}, side.who, { held: (request) => write(side, { ask: q.id, held: true, until: request.until, request: request.id }) })
                    .then((r) => write(side, { ask: q.id, ok: r.ok, text: r.text, ...(r.data && !Array.isArray(r.data) ? { data: r.data } : {}) }))
                    .catch((e) => write(side, { ask: q.id, ok: false, text: `failed: ${e?.message ?? e}` }))
                    .finally(() => busy.delete(key));
            }
        }
        queue.expire();
        return n;
    }

    const api = {
        store,
        act,
        pump,
        approvals: (agent) => queue.list(agent),
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
        connectors: conns,
        /* Every connector taken down: terminals, running commands. */
        async close() { clearInterval(ticker); queue.stop('*'); for (const c of Object.values(conns)) { try { await (c.shutdown ?? c.close)?.call(c, '*'); } catch { /* down anyway */ } } },
    };
    return api;
}
