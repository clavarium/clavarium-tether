/* THE VERBS: what an agent may ask of a target, shared by the command, the MCP
 * server and the keeper. One table, so the three never disagree on a name, on
 * which verbs only read, or on what a verb needs.
 *
 * A verb is the same across kinds wherever the action is the same: `files.read`
 * reads a file on a computer, over SSH or in an online folder alike. A kind is
 * reached by a connector; adding one adds only "how to connect".
 *
 * READS are what a target at level `watch` allows without asking: they change
 * nothing. Everything else ACTS.
 */

export const KINDS = ['computer', 'ssh', 'browser', 'files', 'screen'];
const SHELLS = ['computer', 'ssh'];
const FOLDERS = ['computer', 'ssh', 'files'];

/* Sizes an agent may send. What a target sends back is capped by its connector. */
export const COMMAND_MAX = 4000;
export const TEXT_MAX = 1_000_000;
export const PATH_MAX = 1000;
export const WHY_MAX = 300;

/* name: { reads, kinds, needs: [arg names], done: false when declared only } */
export const VERBS = Object.freeze({
    targets: { reads: true, kinds: null, needs: [] },
    'terminal.open': { reads: false, kinds: SHELLS, needs: [] },
    'terminal.read': { reads: true, kinds: SHELLS, needs: [] },
    'terminal.type': { reads: false, kinds: SHELLS, needs: ['text'] },
    'terminal.run': { reads: false, kinds: SHELLS, needs: ['command'] },
    'files.list': { reads: true, kinds: FOLDERS, needs: [] },
    'files.read': { reads: true, kinds: FOLDERS, needs: ['path'] },
    'files.search': { reads: true, kinds: FOLDERS, needs: ['text'] },
    'files.write': { reads: false, kinds: FOLDERS, needs: ['path', 'text'] },
    'files.move': { reads: false, kinds: FOLDERS, needs: ['from', 'to'] },
    'files.delete': { reads: false, kinds: FOLDERS, needs: ['path'] },
    /* Declared, so names and rights are settled; their connector comes in a later version. */
    'browser.tabs': { reads: true, kinds: ['browser'], needs: [], done: false },
    'browser.open': { reads: false, kinds: ['browser'], needs: ['url'], done: false },
    'browser.shot': { reads: true, kinds: ['browser'], needs: [], done: false },
    'browser.html': { reads: true, kinds: ['browser'], needs: [], done: false },
    'browser.console': { reads: true, kinds: ['browser'], needs: [], done: false },
    'browser.eval': { reads: false, kinds: ['browser'], needs: ['script'], done: false },
    'browser.click': { reads: false, kinds: ['browser'], needs: ['selector'], done: false },
    'browser.type': { reads: false, kinds: ['browser'], needs: ['text'], done: false },
    'browser.key': { reads: false, kinds: ['browser'], needs: ['key'], done: false },
    'browser.scroll': { reads: false, kinds: ['browser'], needs: [], done: false },
    'browser.drag': { reads: false, kinds: ['browser'], needs: ['from', 'to'], done: false },
    /* THE SCREEN OF A MACHINE, A SLOT: these verbs and their rights are settled here,
       but Tether writes no engine for them. A host plugs one in (connectors: { screen }),
       speaking a standard such as VNC/RFB; without one, a screen target says its
       connector is off. See docs/protocol.md, "Plug in a screen engine". */
    'screen.shot': { reads: true, kinds: ['screen'], needs: [] },
    'screen.move': { reads: false, kinds: ['screen'], needs: ['x', 'y'] },
    'screen.click': { reads: false, kinds: ['screen'], needs: [] },
    'screen.drag': { reads: false, kinds: ['screen'], needs: ['from', 'to'] },
    'screen.scroll': { reads: false, kinds: ['screen'], needs: [] },
    'screen.type': { reads: false, kinds: ['screen'], needs: ['text'] },
    'screen.key': { reads: false, kinds: ['screen'], needs: ['key'] },
});

export class Refused extends Error {}
export const no = (why) => { throw new Refused(why); };

const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const oneLine = (text, max) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').replace(/\s+/g, ' ').trim().slice(0, max);

export const isVerb = (verb) => Object.hasOwn(VERBS, verb);
export const reads = (verb) => VERBS[verb]?.reads === true;

/* A verb's arguments, checked and cleaned: what the keeper works with. */
export function check(verb, a = {}) {
    if (!isVerb(verb)) no(`there is no verb ${oneLine(verb, 40)}`);
    const v = VERBS[verb];
    const out = {};
    if (v.kinds) { out.target = oneLine(a.target, 100); if (!out.target) no('say which target'); }
    const why = oneLine(a.why, WHY_MAX); if (why) out.why = why;
    const str = (k, max, keep = false) => {
        if (a[k] === undefined || a[k] === null) return;
        const s = keep ? String(a[k]) : oneLine(a[k], max + 1);
        if (s.length > max) no(`${k} is too long (${max} characters at most)`);
        out[k] = s;
    };
    switch (verb) {
        case 'terminal.read': if (a.lines !== undefined) out.lines = Math.max(1, Math.min(2000, Math.trunc(Number(a.lines)) || 0)); break;
        case 'terminal.type': str('text', COMMAND_MAX, true); out.enter = a.enter === true; break;
        case 'terminal.run':
            str('command', COMMAND_MAX);
            if (a.timeout !== undefined) { const t = Number(a.timeout); if (!(t > 0)) no('timeout is a number of seconds'); out.timeout = Math.min(600, t); }
            break;
        case 'files.list': str('path', PATH_MAX); if (!out.path) out.path = '.'; break;
        case 'files.read': case 'files.delete': str('path', PATH_MAX); break;
        case 'files.search': str('path', PATH_MAX); if (!out.path) out.path = '.'; str('text', 200); break;
        case 'files.write': str('path', PATH_MAX); str('text', TEXT_MAX, true); break;
        case 'files.move': str('from', PATH_MAX); str('to', PATH_MAX); break;
        default: for (const k of v.needs) str(k, COMMAND_MAX, true);
    }
    for (const k of v.needs) if (out[k] === undefined || out[k] === '') no(`${verb} needs ${k}`);
    return out;
}

/* The one line that says what is asked: what a person approves, and what the
 * journal keeps. A file's content is never in it: its size is. */
export function detail(verb, a = {}) {
    switch (verb) {
        case 'terminal.run': return a.command;
        case 'terminal.type': return `${a.text}${a.enter ? '⏎' : ''}`;
        case 'terminal.open': case 'terminal.read': return '';
        case 'files.write': return `${a.path} (${Buffer.byteLength(a.text ?? '')} bytes)`;
        case 'files.move': return `${a.from} → ${a.to}`;
        case 'files.search': return `${a.path}: ${a.text}`;
        case 'files.list': case 'files.read': case 'files.delete': return a.path;
        case 'browser.open': return a.url;
        case 'browser.eval': return a.script;
        case 'screen.move': return `${a.x},${a.y}`;
        case 'screen.click': return a.x !== undefined ? `${a.x},${a.y}` : 'click';
        case 'screen.drag': return `${a.from} → ${a.to}`;
        case 'screen.type': return a.text;
        case 'screen.key': return a.key;
        default: return '';
    }
}
