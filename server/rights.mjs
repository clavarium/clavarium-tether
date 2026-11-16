/* THE RIGHTS: what an agent may do on a target without asking a person.
 *
 * Each target, for each agent, has a LEVEL:
 *
 *   watch     reads only; anything else is refused
 *   propose   reads; each acting verb is asked of a person
 *   frame     reads, and acting verbs an allow rule covers; the rest is asked
 *             (a terminal line the strict read-only parser accepts passes too: commands.mjs)
 *   free      everything (the journal still says it all) -- but a DESTRUCTIVE terminal line
 *             (rm -r, mkfs, dd, reboot...: commands.mjs) is asked at every level
 *
 * An ALLOW RULE is { kind, value }:
 *
 *   command   terminal.run of a command whose first words are these
 *             ("git status" covers "git status --short", not "git stash")
 *   path      files.write / move / delete at or under this path ("~/Projects")
 *   verb      one verb with nothing to compare (terminal.open)
 *   site      browser.open of this host or one under it; and every acting browser verb on a granted tab
 *             whose page is on that host or under it ("*.example.com": only the hosts under it)
 *
 * A COMMAND WITH SHELL CONTROL IN IT IS NEVER COVERED BY A RULE. "git status;
 * rm -rf ~" starts with "git status"; the rule was given for git status. So a
 * command holding ; & | ` $ < > ( ) { } or a backslash is asked, whatever the rules.
 *
 * Pure functions: no clock, no file, no connector. The keeper applies them.
 */
import { reads, oneLine } from './verbs.mjs';
import { readOnly, destructive, lineOf } from './commands.mjs';

export const LEVELS = Object.freeze(['watch', 'propose', 'frame', 'free']);
export const RULE_KINDS = Object.freeze(['command', 'path', 'verb', 'site']);
export const RULES_MAX = 100;
export const RULE_MAX = 300;
const PATH_VERBS = ['files.write', 'files.delete', 'files.move'];

export const isLevel = (level) => LEVELS.includes(level);
const CONTROL = /[;&|`$<>(){}\\\n\r]/;
const words = (command) => String(command ?? '').trim().split(/\s+/).filter(Boolean);

/* A path as rules compare it: "~/a/b" (relative paths start from the target's
 * folder, "~"), or "/a/b". ".." is resolved; one that climbs above its start
 * gives null, and null is never covered. */
export function normalPath(given) {
    const s = String(given ?? '').trim().replace(/\\/g, '/');
    if (!s) return null;
    const absolute = s.startsWith('/');
    const body = s === '~' ? '' : s.startsWith('~/') ? s.slice(2) : s;
    const parts = [];
    for (const seg of body.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
    }
    return absolute ? `/${parts.join('/')}` : parts.length ? `~/${parts.join('/')}` : '~';
}
const under = (path, top) => {
    const p = normalPath(path); const t = normalPath(top);
    if (p === null || t === null) return false;
    if (t === '/') return p.startsWith('/');
    return p === t || p.startsWith(`${t}/`);
};
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

/* A host against a site rule: "example.com" is it and the hosts under it; "*.example.com" only those under it. */
export function siteMatches(host, value) {
    const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
    const v = String(value ?? '').toLowerCase();
    if (!h || !v) return false;
    if (v.startsWith('*.')) return h.endsWith(v.slice(1)) && h.length > v.length - 1;
    return h === v || h.endsWith(`.${v}`);
}

/* A rule, checked and cleaned; a refusal says why. */
export function cleanRule(rule) {
    const kind = String(rule?.kind ?? '');
    if (!RULE_KINDS.includes(kind)) return { refused: `a rule is one of: ${RULE_KINDS.join(', ')}` };
    let value = oneLine(rule?.value, RULE_MAX);
    if (!value) return { refused: 'a rule needs a value' };
    if (kind === 'command') { if (CONTROL.test(value)) return { refused: 'a command rule holds no shell control' }; value = words(value).join(' '); }
    if (kind === 'path') { value = normalPath(value); if (value === null) return { refused: 'that path climbs above its folder' }; }
    if (kind === 'site') {
        value = value.toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
        /* A host, or "*.host" (the hosts under it); a star anywhere else is no pattern. */
        if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(value)) return { refused: 'a site is a host name, or *.host' };
    }
    return { kind, value };
}

/* Whether one rule covers one call. */
export function covers(rule, verb, a = {}) {
    switch (rule?.kind) {
        case 'command': {
            if (verb !== 'terminal.run' || CONTROL.test(a.command ?? '')) return false;
            const want = words(rule.value); const got = words(a.command);
            return want.length > 0 && want.every((w, i) => got[i] === w);
        }
        case 'path':
            if (!PATH_VERBS.includes(verb)) return false;
            return verb === 'files.move' ? under(a.from, rule.value) && under(a.to, rule.value) : under(a.path, rule.value);
        case 'verb': return verb === rule.value;
        case 'site': {
            if (!String(verb).startsWith('browser.')) return false;
            /* Opening: the address it goes to. Acting in a tab: the site of the page in it, as the keeper read it from
               the connector (`tabSite`, never the agent's word: check() keeps no such argument). */
            const h = verb === 'browser.open' ? hostOf(a.url) : String(a.tabSite ?? '').toLowerCase();
            return siteMatches(h, rule.value);
        }
        default: return false;
    }
}

/* THE DECISION for one call: { go: 'yes' | 'ask' | 'no', because, rule?, risk? }.
 *   because: 'read' (a read verb), 'free', 'rule' (an allow rule covers it),
 *   'safe' (a terminal line the read-only parser accepts, at frame: commands.mjs),
 *   'destructive' (a terminal line that erases, wipes a disk, powers off...: asked at EVERY level,
 *   free included; `risk` says what), 'level' (asked, or refused, by the level). */
const TERMINAL_ACTS = ['terminal.type', 'terminal.run'];
export function decide(level, verb, a = {}, rules = []) {
    if (!isLevel(level)) return { go: 'no', because: 'level' };
    if (reads(verb)) return { go: 'yes', because: 'read' };
    if (level === 'watch') return { go: 'no', because: 'level' };
    if (TERMINAL_ACTS.includes(verb)) {
        const risk = destructive(lineOf(verb, a));
        if (risk) return { go: 'ask', because: 'destructive', risk };
    }
    if (level === 'free') return { go: 'yes', because: 'free' };
    if (level === 'frame') {
        if (TERMINAL_ACTS.includes(verb) && readOnly(lineOf(verb, a)).ok) return { go: 'yes', because: 'safe' };
        const rule = rules.find((r) => covers(r, verb, a));
        if (rule) return { go: 'yes', because: 'rule', rule };
    }
    return { go: 'ask', because: 'level' };
}

/* The rule "Always" adds, built from what was asked: the narrowest that still
 * covers it again. Null when no rule fits (typing in a terminal: a rule for it
 * would cover any keys, so it is asked each time).
 *   terminal.run "sudo apt upgrade -y"   command "sudo apt upgrade"
 *   terminal.run "cat notes.txt"         command "cat"
 *   files.write "~/site/a.html"          path "~/site"
 */
export function ruleFrom(verb, a = {}) {
    switch (verb) {
        case 'terminal.run': {
            if (CONTROL.test(a.command ?? '')) return null;
            const w = words(a.command);
            const out = [];
            if (w[0] === 'sudo') out.push(w.shift());
            if (!w[0] || w[0].startsWith('-')) return null;
            out.push(w[0]);
            if (w[1] && /^[a-z][a-z0-9_-]*$/i.test(w[1])) out.push(w[1]);
            return { kind: 'command', value: out.join(' ') };
        }
        case 'files.write': case 'files.delete': {
            const p = normalPath(a.path);
            return p === null ? null : { kind: 'path', value: parentOf(p) };
        }
        case 'files.move': {
            const f = normalPath(a.from); const t = normalPath(a.to);
            if (f === null || t === null) return null;
            let top = parentOf(f);
            while (!under(t, top)) { const up = parentOf(top); if (up === top) return null; top = up; }
            return { kind: 'path', value: top };
        }
        case 'terminal.open': return { kind: 'verb', value: verb };
        case 'screen.move': case 'screen.click': case 'screen.drag': case 'screen.scroll': case 'screen.type': case 'screen.key': return { kind: 'verb', value: verb };
        case 'browser.open': { const h = hostOf(a.url); return h ? { kind: 'site', value: h } : null; }
        /* Acting in a tab: its page's site, when the keeper knows it. */
        case 'browser.click': case 'browser.type': case 'browser.key': case 'browser.scroll': case 'browser.drag': case 'browser.eval': case 'browser.upload': {
            const h = String(a.tabSite ?? '').toLowerCase();
            return h && cleanRule({ kind: 'site', value: h }).kind ? { kind: 'site', value: h } : null;
        }
        default: return null;
    }
}
const parentOf = (p) => {
    if (p === '~' || p === '/') return p;
    const at = p.lastIndexOf('/');
    if (p.startsWith('~/') && at === 1) return '~';
    return at <= 0 ? '/' : p.slice(0, at);
};

/* ---- THE TOOLS OF AN EXTERNAL MCP SERVER (a target of kind `mcp`) ----
 *
 * Each tool has a CLASS, read from what the server declares of it (its annotations,
 * standard hints): trusted as declared, a person can still set one tool otherwise.
 *
 *   read          readOnlyHint true
 *   write         not read-only, and destructiveHint false
 *   destructive   not read-only, and destructiveHint true OR NOT SAID
 *   + open        openWorldHint true or not said: it reaches out (sends, publishes)
 *
 * A tool that declares nothing is destructive and open: the strictest, as the
 * protocol's own defaults say.
 *
 * A READ GUESS (16-11): many servers declare nothing (Slack's...), so at Read an agent
 * would see none of their tools. A tool that says neither readOnlyHint nor
 * destructiveHint, whose name holds a reading verb (READ_VERBS) and whose name and
 * description hold no acting word (ACT_WORDS), is marked `guess: 'read'`. It stays
 * destructive (never run without a person): at Read (watch) it is OFFERED, and each
 * call asked, instead of hidden. At every other level it goes by its class, as before.
 * Conservative on purpose: a word missed hides a tool (as before), never runs one.
 *
 * The LEVEL of the grant says, class by class, yes / ask / no:
 *
 *   (no grant)  Off             no tool at all: the agent does not even see them
 *   watch       Read            read yes, write no,  destructive no
 *   propose     All, approved   read yes, write ask, destructive ask
 *   free        All             read yes, write yes, destructive ask
 *   frame       Custom          the grant's own `classes` (propose's where unsaid)
 *
 * A TOOL'S OWN SETTING (`tools: { name: yes | ask | no }`) wins over its class, at
 * any level: "delete_contact: no", "create_issue: yes". Yes for a destructive tool
 * is only ever set so, by a person, tool by tool: never by a class preset, never by
 * "Always" on a card. `askOpen` (custom): a write tool that reaches out is asked
 * even where its class says yes. */
export const CLASSES = Object.freeze(['read', 'write', 'destructive']);
export const GOES = Object.freeze(['yes', 'ask', 'no']);
export const CLASS_PRESETS = Object.freeze({
    watch: Object.freeze({ read: 'yes', write: 'no', destructive: 'no' }),
    propose: Object.freeze({ read: 'yes', write: 'ask', destructive: 'ask' }),
    free: Object.freeze({ read: 'yes', write: 'yes', destructive: 'ask' }),
});

/* The words of a read guess, whole words of a name (snake, kebab, dots, camelCase) or a description. */
export const READ_VERBS = Object.freeze(['read', 'list', 'search', 'get', 'find', 'view', 'history', 'lookup', 'fetch']);
export const ACT_WORDS = Object.freeze(['send', 'post', 'write', 'create', 'update', 'delete', 'remove', 'edit', 'add', 'put', 'patch', 'publish',
    'reply', 'respond', 'react', 'invite', 'archive', 'move', 'rename', 'upload', 'schedule', 'mark', 'join', 'leave', 'kick', 'submit', 'approve',
    'cancel', 'exec', 'execute', 'merge', 'push', 'share', 'pin', 'unpin', 'star', 'assign', 'forward', 'draft', 'save', 'clear',
    'reset', 'purge', 'drop', 'insert', 'modify', 'change', 'revoke', 'grant', 'transfer', 'pay', 'buy', 'trigger', 'deploy', 'install',
    'kill', 'restore', 'import', 'export', 'sync', 'notify', 'invoke', 'enable', 'disable', 'ban']);
/* In a name only (short, precise), words a description uses for other things too (« in order », « a set of »). */
const NAME_ACTS = ['set', 'run', 'start', 'stop', 'call', 'close', 'open', 'lock', 'unlock', 'block', 'apply', 'message', 'order', 'book'];
/* A word or one of its plain forms (sends, deleted, posting, updates). */
const acts = (w, list) => [w, w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/ed$/, ''), w.replace(/d$/, ''), w.replace(/ing$/, ''), w.replace(/ing$/, 'e')].some((x) => x && list.includes(x));
const wordsOf = (text) => String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/* 'read' when a tool that declares nothing of its kind seems by its words to only read; else ''. */
export function readGuess(name, description, annotations) {
    const a = annotations && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : {};
    if (typeof a.readOnlyHint === 'boolean' || typeof a.destructiveHint === 'boolean') return '';
    const own = wordsOf(name);
    if (!own.some((w) => READ_VERBS.includes(w))) return '';
    if (own.some((w) => acts(w, ACT_WORDS) || acts(w, NAME_ACTS)) || wordsOf(description).some((w) => acts(w, ACT_WORDS))) return '';
    return 'read';
}

/* A tool's class from its annotations: { class, open, idempotent }. */
export function classOf(annotations) {
    const a = annotations && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : {};
    const open = a.openWorldHint !== false;
    const idempotent = a.idempotentHint === true;
    if (a.readOnlyHint === true) return { class: 'read', open, idempotent };
    if (a.destructiveHint === false) return { class: 'write', open, idempotent };
    return { class: 'destructive', open, idempotent };
}

/* The classes a grant applies: its level's preset, or (frame) its own. */
export function classesOf(grant) {
    if (!grant || !isLevel(grant.level)) return { read: 'no', write: 'no', destructive: 'no' };
    if (grant.level !== 'frame') return { ...CLASS_PRESETS[grant.level] };
    const own = grant.classes && typeof grant.classes === 'object' ? grant.classes : {};
    return Object.fromEntries(CLASSES.map((c) => [c, GOES.includes(own[c]) ? own[c] : CLASS_PRESETS.propose[c]]));
}

/* THE DECISION for one tool of a catalog ({ name, class, open }): { go, because }.
 *   because: 'tool' (its own setting), 'class' (its class at this level), 'level' (no grant). */
export function toolDecide(grant, tool) {
    if (!grant || !isLevel(grant.level) || !tool) return { go: 'no', because: 'level' };
    /* A tool new on its server, or whose annotations changed (07-11, the owner's choice): asked, whatever
       its class or its own setting says, until a person has seen it once (approved a call, or "seen"). */
    const own = grant.tools?.[tool.name];
    if (GOES.includes(own)) return own === 'yes' && tool.fresh === true ? { go: 'ask', because: 'fresh' } : { go: own, because: 'tool' };
    let go = classesOf(grant)[CLASSES.includes(tool.class) ? tool.class : 'destructive'] ?? 'no';
    if (go === 'yes' && grant.level === 'frame' && grant.askOpen === true && tool.open && tool.class !== 'read') go = 'ask';
    if (go === 'yes' && tool.fresh === true) return { go: 'ask', because: 'fresh' };
    /* Seems to read, says nothing (above): offered at Read, each call asked. */
    if (go === 'no' && grant.level === 'watch' && tool.guess === 'read' && tool.class === 'destructive') return { go: 'ask', because: 'guess' };
    return { go, because: 'class' };
}
