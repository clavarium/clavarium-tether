/* THE RIGHTS: what an agent may do on a target without asking a person.
 *
 * Each target, for each agent, has a LEVEL:
 *
 *   watch     reads only; anything else is refused
 *   propose   reads; each acting verb is asked of a person
 *   frame     reads, and acting verbs an allow rule covers; the rest is asked
 *   free      everything (the journal still says it all)
 *
 * An ALLOW RULE is { kind, value }:
 *
 *   command   terminal.run of a command whose first words are these
 *             ("git status" covers "git status --short", not "git stash")
 *   path      files.write / move / delete at or under this path ("~/Projects")
 *   verb      one verb with nothing to compare (terminal.open)
 *   site      browser.open of this host or one under it
 *
 * A COMMAND WITH SHELL CONTROL IN IT IS NEVER COVERED BY A RULE. "git status;
 * rm -rf ~" starts with "git status"; the rule was given for git status. So a
 * command holding ; & | ` $ < > ( ) { } or a backslash is asked, whatever the rules.
 *
 * Pure functions: no clock, no file, no connector. The keeper applies them.
 */
import { reads, oneLine } from './verbs.mjs';

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

/* A rule, checked and cleaned; a refusal says why. */
export function cleanRule(rule) {
    const kind = String(rule?.kind ?? '');
    if (!RULE_KINDS.includes(kind)) return { refused: `a rule is one of: ${RULE_KINDS.join(', ')}` };
    let value = oneLine(rule?.value, RULE_MAX);
    if (!value) return { refused: 'a rule needs a value' };
    if (kind === 'command') { if (CONTROL.test(value)) return { refused: 'a command rule holds no shell control' }; value = words(value).join(' '); }
    if (kind === 'path') { value = normalPath(value); if (value === null) return { refused: 'that path climbs above its folder' }; }
    if (kind === 'site') value = value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
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
            if (verb !== 'browser.open') return false;
            const h = hostOf(a.url);
            return !!h && (h === rule.value || h.endsWith(`.${rule.value}`));
        }
        default: return false;
    }
}

/* THE DECISION for one call: { go: 'yes' | 'ask' | 'no', because, rule? }.
 *   because: 'read' (a read verb), 'free', 'rule' (an allow rule covers it),
 *   'level' (asked, or refused, by the level). */
export function decide(level, verb, a = {}, rules = []) {
    if (!isLevel(level)) return { go: 'no', because: 'level' };
    if (reads(verb)) return { go: 'yes', because: 'read' };
    if (level === 'free') return { go: 'yes', because: 'free' };
    if (level === 'watch') return { go: 'no', because: 'level' };
    if (level === 'frame') {
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
        default: return null;
    }
}
const parentOf = (p) => {
    if (p === '~' || p === '/') return p;
    const at = p.lastIndexOf('/');
    if (p.startsWith('~/') && at === 1) return '~';
    return at <= 0 ? '/' : p.slice(0, at);
};
