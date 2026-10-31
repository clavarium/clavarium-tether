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

export const KINDS = ['computer', 'ssh', 'browser', 'files', 'screen', 'mail', 'calendar', 'contacts', 'device'];
const SHELLS = ['computer', 'ssh'];
const FOLDERS = ['computer', 'ssh', 'files'];

/* Sizes an agent may send. What a target sends back is capped by its connector. */
export const COMMAND_MAX = 4000;
export const TEXT_MAX = 1_000_000;
/* The total base64 of a message's attachments (~22 MB of real files). Over it, the send is refused, not sent short. */
export const ATTACH_MAX = 30 * 1024 * 1024;
export const PATH_MAX = 1000;
/* A firmware handed over, as base64 (16 MB of image). */
export const IMAGE_B64_MAX = Math.ceil(16 * 1024 * 1024 / 3) * 4;
export const WHY_MAX = 300;

/* name: { reads, kinds, needs: [arg names], done: false when declared only } */
export const VERBS = Object.freeze({
    targets: { reads: true, kinds: null, needs: [] },
    pending: { reads: true, kinds: null, needs: [] },
    withdraw: { reads: true, kinds: null, needs: ['id'] },
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
    /* The browser: tabs a person grants to an agent through the Tether extension.
       Reached by the `browser` connector, which the extension connects out to. */
    'browser.tabs': { reads: true, kinds: ['browser'], needs: [] },
    'browser.open': { reads: false, kinds: ['browser'], needs: ['url'] },
    'browser.shot': { reads: true, kinds: ['browser'], needs: [] },
    'browser.html': { reads: true, kinds: ['browser'], needs: [] },
    'browser.console': { reads: true, kinds: ['browser'], needs: [] },
    'browser.eval': { reads: false, kinds: ['browser'], needs: ['script'] },
    'browser.click': { reads: false, kinds: ['browser'], needs: [] },
    'browser.type': { reads: false, kinds: ['browser'], needs: ['text'] },
    'browser.key': { reads: false, kinds: ['browser'], needs: ['key'] },
    'browser.scroll': { reads: false, kinds: ['browser'], needs: [] },
    'browser.drag': { reads: false, kinds: ['browser'], needs: ['from', 'to'] },
    /* THE SCREEN OF A MACHINE, A SLOT: these verbs and their rights are settled here,
       but Tether writes no engine for them. A host plugs one in (connectors: { screen }),
       speaking a standard such as VNC/RFB; without one, a screen target says its
       connector is off. See docs/protocol.md, "Plug in a screen engine". */
    /* A device plugged into a person's computer: done in that person's browser (connectors/device.mjs). */
    'device.flash': { reads: false, kinds: ['device'], needs: [] },
    'screen.shot': { reads: true, kinds: ['screen'], needs: [] },
    'screen.move': { reads: false, kinds: ['screen'], needs: ['x', 'y'] },
    'screen.click': { reads: false, kinds: ['screen'], needs: [] },
    'screen.drag': { reads: false, kinds: ['screen'], needs: ['from', 'to'] },
    'screen.scroll': { reads: false, kinds: ['screen'], needs: [] },
    'screen.type': { reads: false, kinds: ['screen'], needs: ['text'] },
    'screen.key': { reads: false, kinds: ['screen'], needs: ['key'] },
    /* MAIL (and later agenda, contacts): a mailbox reached by the keeper over IMAP
       with a token the agent never holds. Reads at level watch; send/move/flag act. */
    'mail.list': { reads: true, kinds: ['mail'], needs: [] },
    'mail.read': { reads: true, kinds: ['mail'], needs: ['uid'] },
    'mail.source': { reads: true, kinds: ['mail'], needs: ['uid'] },
    'mail.attachment': { reads: true, kinds: ['mail'], needs: ['uid', 'which'] },
    'mail.search': { reads: true, kinds: ['mail'], needs: ['text'] },
    'mail.move': { reads: false, kinds: ['mail'], needs: ['uid', 'mailbox'] },
    'mail.flag': { reads: false, kinds: ['mail'], needs: ['uid', 'flag'] },
    'mail.delete': { reads: false, kinds: ['mail'], needs: ['uid'] },
    'mail.send': { reads: false, kinds: ['mail'], needs: ['to', 'subject', 'body'] },
    'mail.reply': { reads: false, kinds: ['mail'], needs: ['uid', 'body'] },
    'mail.forward': { reads: false, kinds: ['mail'], needs: ['uid', 'to'] },
    'calendar.list': { reads: true, kinds: ['calendar'], needs: [] },
    'calendar.read': { reads: true, kinds: ['calendar'], needs: ['id'] },
    'calendar.freebusy': { reads: true, kinds: ['calendar'], needs: ['who'] },
    'calendar.create': { reads: false, kinds: ['calendar'], needs: ['title', 'start', 'end'] },
    'calendar.attach': { reads: false, kinds: ['calendar'], needs: ['id', 'attach'] },
    'calendar.detach': { reads: false, kinds: ['calendar'], needs: ['id', 'which'] },
    'calendar.delete': { reads: false, kinds: ['calendar'], needs: ['id'] },
    'calendar.respond': { reads: false, kinds: ['calendar'], needs: ['id', 'answer'] },
    'calendar.update': { reads: false, kinds: ['calendar'], needs: ['id'] },
    'calendar.categories': { reads: true, kinds: ['calendar'], needs: [] },
    'calendar.category-add': { reads: false, kinds: ['calendar'], needs: ['name'] },
    'calendar.category-rename': { reads: false, kinds: ['calendar'], needs: ['name'] },
    'calendar.category-delete': { reads: false, kinds: ['calendar'], needs: ['name'] },
    'contacts.list': { reads: true, kinds: ['contacts'], needs: [] },
    'contacts.search': { reads: true, kinds: ['contacts'], needs: ['text'] },
    'contacts.read': { reads: true, kinds: ['contacts'], needs: ['id'] },
    'contacts.create': { reads: false, kinds: ['contacts'], needs: [] },
    'contacts.update': { reads: false, kinds: ['contacts'], needs: ['id'] },
    'contacts.delete': { reads: false, kinds: ['contacts'], needs: ['id'] },
    'contacts.attach': { reads: false, kinds: ['contacts'], needs: ['id', 'attach'] },
});

export class Refused extends Error {}
export const no = (why) => { throw new Refused(why); };

const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const oneLine = (text, max) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').replace(/\s+/g, ' ').trim().slice(0, max);

export const isVerb = (verb) => Object.hasOwn(VERBS, verb);
export const reads = (verb) => VERBS[verb]?.reads === true;

/* A date argument (mail since/before, calendar from/to) as a Date, or undefined
   if absent. Accepts a day (2026-01-31) or a full ISO instant. */
export function asDate(v, name) {
    if (v === undefined || v === null || v === '') return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) no(`${name} must be a date like 2026-01-31`);
    return d;
}

/* A verb's arguments, checked and cleaned: what the keeper works with. */
export function check(verb, a = {}) {
    if (!isVerb(verb)) no(`there is no verb ${oneLine(verb, 40)}`);
    const v = VERBS[verb];
    const out = {};
    if (v.kinds) { out.target = oneLine(a.target, 100); if (!out.target) no('say which target'); }
    /* What the agent writes is kept whole or refused, never cut in the middle: told its length and
       the limit, it shortens and asks again (the "why" is what a person reads before deciding). */
    const tooLong = (k, n, max) => no(`${k} is ${n} characters; ${max} at most -- nothing was done: shorten it and ask again`);
    const why = oneLine(a.why, Infinity); if (why.length > WHY_MAX) tooLong('why', why.length, WHY_MAX); if (why) out.why = why;
    const str = (k, max, keep = false) => {
        if (a[k] === undefined || a[k] === null) return;
        const s = keep ? String(a[k]) : oneLine(a[k], Infinity);
        if (s.length > max) tooLong(k, s.length, max);
        out[k] = s;
    };
    /* Which granted tab a browser verb acts on (optional: none means the agent's active one). */
    const tab = () => { if (a.tab !== undefined && a.tab !== null && a.tab !== '') out.tab = typeof a.tab === 'number' ? Math.trunc(a.tab) : oneLine(a.tab, 100); };
    /* Event categories: a clean list, up to 25, each short. An empty list is kept
       (it clears the categories on an update); undefined leaves them untouched. */
    const cats = () => { if (a.categories === undefined || a.categories === null) return; out.categories = (Array.isArray(a.categories) ? a.categories : [a.categories]).map((c) => oneLine(c, 200)).filter(Boolean).slice(0, 25); };
    const num = (k) => { if (a[k] !== undefined && a[k] !== null && a[k] !== '') { const n = Number(a[k]); if (Number.isFinite(n)) out[k] = Math.trunc(n); } };
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
        case 'device.flash': {
            str('firmware', PATH_MAX); str('name', 60); str('room', 40);
            if (a.image !== undefined && a.image !== null) { const b64 = String(a.image).replace(/\s+/g, ''); if (b64.length > IMAGE_B64_MAX) tooLong('image', b64.length, IMAGE_B64_MAX); out.image = b64; }
            if (a.pair === true) out.pair = true;
            if (a.wifi === false) out.wifi = false;
            if (a.app && typeof a.app === 'object') out.app = { url: oneLine(a.app.url, 200), room: oneLine(a.app.room ?? '', 40), code: oneLine(a.app.code, 20) };
            break;
        }
        case 'browser.tabs': break;
        case 'browser.open': tab(); str('url', PATH_MAX); break;
        case 'browser.shot': tab(); break;
        case 'browser.html': tab(); str('selector', PATH_MAX); if (a.readable === true || a.readable === 'true') out.readable = true; break;
        case 'browser.console': tab(); if (a.lines !== undefined) out.lines = Math.max(1, Math.min(1000, Math.trunc(Number(a.lines)) || 0)); break;
        case 'browser.eval': tab(); str('script', COMMAND_MAX, true); break;
        case 'browser.click':
            tab(); str('selector', PATH_MAX); num('x'); num('y');
            if (a.button) out.button = oneLine(a.button, 10);
            if (out.selector === undefined && (out.x === undefined || out.y === undefined)) no('click needs a selector or x and y');
            break;
        case 'browser.type': tab(); str('text', COMMAND_MAX, true); str('selector', PATH_MAX); break;
        case 'browser.key': tab(); str('key', 60); str('selector', PATH_MAX); break;
        case 'browser.scroll': tab(); num('dx'); num('dy'); str('selector', PATH_MAX); break;
        case 'browser.drag': tab(); str('from', PATH_MAX); str('to', PATH_MAX); break;
        /* The screen of a machine: coordinates are numbers, a drag's ends are points
           like "12,40", a key is a name or chord. The engine clamps to the screen. */
        case 'screen.shot': break;
        case 'screen.move': num('x'); num('y'); break;
        case 'screen.click': num('x'); num('y'); if (a.button) out.button = oneLine(a.button, 10); break;
        case 'screen.drag': str('from', 100); str('to', 100); break;
        case 'screen.scroll': num('dx'); num('dy'); break;
        case 'screen.type': str('text', COMMAND_MAX, true); break;
        case 'screen.key': str('key', 60); break;
        case 'mail.list': str('mailbox', 200); str('since', 64); str('before', 64); break;
        case 'mail.read': str('uid', 1024); str('mailbox', 200); break;
        case 'mail.source': str('uid', 1024); str('mailbox', 200); break;
        case 'mail.attachment': str('uid', 1024); str('which', 400); str('mailbox', 200); break;
        case 'mail.search': str('text', 400); str('mailbox', 200); break;
        case 'mail.move': str('uid', 1024); str('mailbox', 200); break;
        case 'mail.flag': str('uid', 1024); str('flag', 40); break;
        case 'mail.delete': str('uid', 1024); str('mailbox', 200); break;
        case 'mail.send': case 'mail.reply': case 'mail.forward': {
            if (verb !== 'mail.send') { str('uid', 1024); str('mailbox', 200); }
            if (verb !== 'mail.reply') str('to', 1000);
            if (verb === 'mail.send') str('subject', 400);
            if (verb === 'mail.reply' && (a.all === true || a.all === 'true')) out.all = true;
            if (verb === 'mail.forward') str('keep', 1000);
            str('body', TEXT_MAX, true); str('cc', 1000); str('bcc', 1000); str('attach', TEXT_MAX, true); str('attachName', 200);
            if (a.format !== undefined && a.format !== null && a.format !== '') {
                const f = oneLine(a.format, 20).toLowerCase();
                if (f !== 'markdown' && f !== 'text') no('format is markdown (the default) or text');
                out.format = f;
            }
            if (a.draft === true || a.draft === 'true') out.draft = true;
            str('at', 64);
            if (a.signature === false || a.signature === 'false') out.signature = false;
            if (Array.isArray(a.attachments)) {
                let total = 0;
                /* More than kept: refused whole, never some dropped in silence (#51). */
                if (a.attachments.length > 50) no(`${a.attachments.length} attachments; 50 at most -- nothing was done: send them in several mails`);
                const files = a.attachments.map((f) => ({ name: oneLine(f?.name, 200) || 'attachment', bytes: String(f?.bytes ?? '') })).filter((f) => f.bytes);
                for (const f of files) total += f.bytes.length;
                if (total > ATTACH_MAX) no(`the attachments are too large to send together (over ${Math.round(ATTACH_MAX / 1024 / 1024)} MB of files)`);
                if (files.length) out.attachments = files;
            }
            break;
        }
        case 'withdraw': str('id', 100); str('reason', 300); break;
        case 'calendar.list': str('from', 64); str('to', 64); str('category', 200); break;
        case 'calendar.category-add': str('name', 200); str('color', 40); break;
        case 'calendar.category-rename': str('name', 200); str('to', 200); str('color', 40); break;
        case 'calendar.category-delete': str('name', 200); break;
        case 'calendar.read': str('id', 1024); break;
        case 'calendar.freebusy': str('who', 2000); str('from', 64); str('to', 64); break;
        case 'calendar.create': str('title', 400); str('start', 64); str('end', 64); str('where', 400); str('notes', TEXT_MAX, true); str('with', 1000); str('online', 20); cats(); break;
        case 'calendar.attach': str('id', 1024); str('attach', TEXT_MAX, true); str('attachName', 200); if (a.share === true || a.share === 'true') out.share = true; break;
        case 'calendar.detach': str('id', 1024); str('which', 400); break;
        case 'calendar.delete': str('id', 1024); break;
        case 'calendar.respond': str('id', 1024); str('answer', 40); str('comment', 400); break;
        case 'calendar.update': str('id', 1024); str('title', 400); str('start', 64); str('end', 64); str('where', 400); str('notes', TEXT_MAX, true); str('with', 1000); str('online', 20); cats(); break;
        case 'contacts.attach': str('id', 1024); str('attach', TEXT_MAX, true); str('attachName', 200); break;
        case 'contacts.search': str('text', 200); break;
        case 'contacts.read': str('id', 1024); break;
        case 'contacts.create': str('name', 200); str('email', 200); str('phone', 60); break;
        case 'contacts.update': str('id', 1024); str('name', 200); str('email', 200); str('phone', 60); break;
        case 'contacts.delete': str('id', 1024); break;
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
        case 'browser.html': return a.selector ?? '';
        case 'browser.click': return a.selector ?? (a.x !== undefined ? `${a.x},${a.y}` : 'click');
        case 'browser.type': return a.selector ? `${a.selector}: ${a.text}` : a.text;
        case 'browser.key': return a.selector ? `${a.selector}: ${a.key}` : a.key;
        case 'browser.scroll': return `${a.dx ?? 0},${a.dy ?? 0}`;
        case 'browser.drag': return `${a.from} → ${a.to}`;
        case 'device.flash': return `${a.name ? `${a.name}: ` : ''}${a.image !== undefined ? `${Math.round(String(a.image).length * 3 / 4 / 1024)} KB` : a.firmware}${a.pair ? ', then paired' : ''}`;
        case 'screen.move': return `${a.x},${a.y}`;
        case 'screen.click': return a.x !== undefined ? `${a.x},${a.y}` : 'click';
        case 'screen.drag': return `${a.from} → ${a.to}`;
        case 'screen.type': return a.text;
        case 'screen.key': return a.key;
        case 'mail.list': return a.mailbox ?? '';
        case 'mail.read': return `#${a.uid}`;
        case 'mail.search': return a.text;
        /* Ids from Graph are long and opaque; the approval says the ACTION, and the
           agent's "why" names the thing. So no raw id dumped into the one line. */
        case 'mail.move': return `move a message → ${a.mailbox}`;
        case 'mail.flag': return `mark a message ${a.flag}`;
        case 'mail.delete': return 'delete a message';
        case 'mail.send': case 'mail.reply': case 'mail.forward': {
            const kb = (b64) => Math.max(1, Math.round((String(b64).length * 3 / 4) / 1024));
            const files = Array.isArray(a.attachments) ? a.attachments.map((f) => `${f.name} (${kb(f.bytes)} KB)`) : (a.attach ? [`${a.attachName || 'a file'} (${kb(a.attach)} KB)`] : []);
            const copies = `${a.cc ? `, cc ${a.cc}` : ''}${a.bcc ? `, bcc ${a.bcc}` : ''}`;
            const draft = a.draft ? 'draft: ' : a.at ? `at ${a.at}: ` : '';
            const plus = files.length ? ` + ${files.join(', ')}` : '';
            if (verb === 'mail.reply') return `${draft}reply${a.all ? ' to all' : ''} to a message${copies}${plus}`;
            if (verb === 'mail.forward') {
                const k = String(a.keep ?? '').trim();
                const kept = !k || /^(all|true|yes)$/i.test(k) ? 'with its files' : /^(none|false|no)$/i.test(k) ? 'without its files' : `keeping ${k}`;
                return `${draft}forward a message to ${a.to}${copies} (${kept})${plus}`;
            }
            return `${draft}to ${a.to}${copies}: ${a.subject ?? ''}${plus}`;
        }
        case 'calendar.read': return a.id;
        case 'calendar.freebusy': return a.who;
        case 'calendar.create': return `${a.title} (${a.start})`;
        case 'calendar.attach': return `${a.attachName || 'a file'} → an event`;
        case 'calendar.detach': return `remove ${a.which || 'a file'} from an event`;
        case 'calendar.delete': return 'delete an event';
        case 'calendar.respond': return `${a.answer} an invitation`;
        case 'calendar.update': return `change an event${a.title ? ` → ${a.title}` : ''}`;
        case 'calendar.category-add': return `create the category "${a.name}"${a.color ? ` (${a.color})` : ''}`;
        case 'calendar.category-rename': return `change the category "${a.name}"`;
        case 'calendar.category-delete': return `delete the category "${a.name}"`;
        case 'contacts.read': return a.id;
        case 'contacts.create': return `add ${a.name || a.email || 'a contact'}`;
        case 'contacts.update': return 'change a contact';
        case 'contacts.delete': return 'delete a contact';
        case 'contacts.attach': return "set a contact's photo";
        default: return '';
    }
}
