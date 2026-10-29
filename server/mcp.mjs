#!/usr/bin/env node
/* THE ASKING SIDE: how an agent, or a script, acts on the targets it was
 * given. One file, no dependency.
 *
 *   a command    `tether targets`, `tether run TARGET "cmd"`... (bin/cli.mjs imports this file)
 *   MCP          `node mcp.mjs [--dir FOLDER]`: the same verbs as tools,
 *                over standard input and output (JSON-RPC 2.0, one message per line)
 *
 * IT ASKS, IT NEVER CONNECTS. No key, no password, no connection is here: the
 * keeper (the application, or `serve`) holds them, checks the rights, asks a
 * person when it must, runs the call, and answers. Here, the agent's folder:
 *
 *   asks.jsonl      the agent's: what it asks, one line each
 *   answers.jsonl   the keeper's: "held for a person until ...", then the answer, by ask id
 *
 * The keeper says who asks by the folder the ask came from: an agent cannot
 * speak as another one, nor as a person. See docs/protocol.md.
 */
import { appendFileSync, readFileSync, mkdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { NAME, VERSION, FOLDER, ENV_DIR } from './name.mjs';

export { VERSION, FOLDER };
/* How long an ask waits for the keeper's answer. Most verbs answer in a second or
   two, but a real action can take longer -- a mailbox opened over IMAP and read can
   be ~20s -- so the wait is generous; a stuck connection still fails fast, because
   the connector's own idle timeout turns it into a refusal the keeper sends back. */
export const WAIT_MS = 60_000;
/* Past the time a person had, how long more to wait for the keeper's word. */
export const GRACE_MS = 30_000;
export const NO_KEEPER = `No answer: nobody keeps these targets right now (their application, or "${NAME} serve", is not running). Nothing was done.`;
export const NOT_ANSWERED = 'No answer came in time. Nothing is known to have been done.';

const parsed = (line) => { try { const j = JSON.parse(line); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
export function lines(file) {
    try { if (lstatSync(file).isSymbolicLink()) return []; return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(parsed).filter(Boolean); } catch { return []; }
}
const isFolder = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/* The folder: `dir`, else $TETHER_DIR, else the nearest .tether from `from` up. */
export function findFolder({ dir, env = process.env, from = process.cwd() } = {}) {
    if (dir) return resolve(from, dir);
    if (env[ENV_DIR]) return resolve(from, env[ENV_DIR]);
    for (let at = resolve(from); ; at = dirname(at)) {
        if (isFolder(join(at, FOLDER))) return join(at, FOLDER);
        if (dirname(at) === at) return null;
    }
}

/* One ask, and its answer: { ok, text, data?, held?, nokeeper?, late? }.
 * `onHeld(until)` is told when a person has to decide first. */
export async function ask(dir, verb, args = {}, { wait = WAIT_MS, grace = GRACE_MS, every = 150, onHeld } = {}) {
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    appendFileSync(join(dir, 'asks.jsonl'), `${JSON.stringify({ id, at: new Date().toISOString(), op: verb, args })}\n`);
    let until = Date.now() + wait;
    let held = false;
    for (;;) {
        const mine = lines(join(dir, 'answers.jsonl')).filter((a) => a.ask === id);
        const answer = mine.find((a) => a.held !== true);
        if (answer) return { ok: answer.ok === true, text: String(answer.text ?? ''), ...(answer.data !== undefined ? { data: answer.data } : {}), ...(held ? { held } : {}) };
        const hold = mine.find((a) => a.held === true);
        if (hold && !held) {
            held = true;
            const end = Date.parse(hold.until);
            until = (Number.isFinite(end) ? end : Date.now()) + grace;
            try { onHeld?.(hold.until); } catch { /* the caller's */ }
        }
        if (Date.now() >= until) return held ? { ok: false, text: NOT_ANSWERED, held, late: true } : { ok: false, text: NO_KEEPER, nokeeper: true };
        await new Promise((r) => setTimeout(r, every));
    }
}

/* ---- MCP ---- */
const S = (description) => ({ type: 'string', description });
const CATS = { type: 'array', description: 'personal Outlook categories (colour labels, invisible to the other participants), e.g. ["Internal"]; on update, [] clears them', items: { type: 'string' } };
const TARGET = S('a target you were given (see targets)');
const WHY = S('one short line for the person: why you do this');
const TAB = { type: 'number', description: 'which granted tab (its id from browser-tabs); your active one by default' };
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required } });
/* Tool names use "-" where a verb has ".": terminal-run is terminal.run. */
export const TOOLS = [
    tool('targets', 'What you were given: each target, its kind, your level on it and its allow rules.'),
    tool('terminal-open', 'Open a terminal on a target (a computer or a machine reached by SSH).', { target: TARGET, why: WHY }, ['target']),
    tool('terminal-read', 'Read the screen of the terminal you opened on a target.', { target: TARGET, lines: { type: 'number', description: 'how many lines back (40 by default)' } }, ['target']),
    tool('terminal-type', 'Type keys in the terminal you opened on a target (a person may have to approve).', { target: TARGET, text: { type: 'string' }, enter: { type: 'boolean', description: 'press Enter after' }, why: WHY }, ['target', 'text']),
    tool('terminal-run', 'Run one command on a target and get its output and exit code. Depending on your level, a person approves it first: say why.', { target: TARGET, command: { type: 'string' }, timeout: { type: 'number', description: 'seconds, 60 by default, 600 at most' }, why: WHY }, ['target', 'command']),
    tool('files-list', 'List a folder on a target.', { target: TARGET, path: S('a folder; the target\'s own by default') }, ['target']),
    tool('files-read', 'Read a text file on a target.', { target: TARGET, path: { type: 'string' } }, ['target', 'path']),
    tool('files-search', 'Find files whose name or text holds a word, under a folder of a target.', { target: TARGET, text: { type: 'string' }, path: S('where to look; the whole folder by default') }, ['target', 'text']),
    tool('files-write', 'Write a text file on a target (made, or replaced).', { target: TARGET, path: { type: 'string' }, text: { type: 'string' }, why: WHY }, ['target', 'path', 'text']),
    tool('files-move', 'Move or rename a file or folder on a target.', { target: TARGET, from: { type: 'string' }, to: { type: 'string' }, why: WHY }, ['target', 'from', 'to']),
    tool('files-delete', 'Delete a file, or an empty folder, on a target.', { target: TARGET, path: { type: 'string' }, why: WHY }, ['target', 'path']),
    tool('browser-tabs', 'The browser tabs a person granted you (id, title, address).', { target: TARGET }, ['target']),
    tool('browser-open', 'Open a web address: in a granted tab (give tab), or a new tab. A person may approve: say why.', { target: TARGET, url: S('the address to open'), tab: TAB, why: WHY }, ['target', 'url']),
    tool('browser-shot', 'A screenshot of a granted tab (returned as a data: image URL).', { target: TARGET, tab: TAB }, ['target']),
    tool('browser-html', 'The HTML of a granted tab, or of one element (selector), or a readable text extract.', { target: TARGET, tab: TAB, selector: S('a CSS selector; the whole page by default'), readable: { type: 'boolean', description: 'a readable text extract instead of HTML' } }, ['target']),
    tool('browser-console', 'Recent console messages captured in a granted tab.', { target: TARGET, tab: TAB, lines: { type: 'number', description: 'how many back' } }, ['target']),
    tool('browser-eval', 'Run a JavaScript snippet in a granted tab and get its result. A person may approve: say why.', { target: TARGET, tab: TAB, script: S('JavaScript; its last value comes back'), why: WHY }, ['target', 'script']),
    tool('browser-click', 'Click in a granted tab, by CSS selector or by x,y. A person may approve: say why.', { target: TARGET, tab: TAB, selector: S('a CSS selector'), x: { type: 'number' }, y: { type: 'number' }, button: S('left (default), middle, right'), why: WHY }, ['target']),
    tool('browser-type', 'Type text in a granted tab (into the focused field, or a selector first). A person may approve: say why.', { target: TARGET, tab: TAB, text: { type: 'string' }, selector: S('a field to focus first'), why: WHY }, ['target', 'text']),
    tool('browser-key', 'Press a key or chord in a granted tab (Enter, ctrl+a). A person may approve: say why.', { target: TARGET, tab: TAB, key: { type: 'string' }, selector: S('an element to focus first'), why: WHY }, ['target', 'key']),
    tool('browser-scroll', 'Scroll a granted tab by dx,dy (or an element, by selector). A person may approve: say why.', { target: TARGET, tab: TAB, dx: { type: 'number' }, dy: { type: 'number' }, selector: S('an element to scroll'), why: WHY }, ['target']),
    tool('browser-drag', 'Drag in a granted tab from one point or element to another ("x,y" or a selector). A person may approve: say why.', { target: TARGET, tab: TAB, from: { type: 'string' }, to: { type: 'string' }, why: WHY }, ['target', 'from', 'to']),
    tool('mail-list', 'Recent messages of a mailbox target: who, subject, when — newest first. By default the last 30 days; give since and/or before (ISO date or date-time) to look at any past window, e.g. a given week or month.', { target: TARGET, mailbox: S('a folder; INBOX by default'), since: S('only messages on or after this date (ISO), optional'), before: S('only messages before this date (ISO), optional') }, ['target']),
    tool('mail-read', 'One message in full (headers and body) by its number (uid). An invitation also shows its date.', { target: TARGET, uid: S('the message id from a list (a number for IMAP, a long id for Microsoft)'), mailbox: S('a folder; INBOX by default') }, ['target', 'uid']),
    tool('mail-source', 'The raw source of a message (every header, both text and HTML bodies, attachments inline) — for when the readable view is not enough.', { target: TARGET, uid: S('the message id from a list'), mailbox: S('a folder; INBOX by default') }, ['target', 'uid']),
    tool('mail-attachment', "Download one of a message's attachments as base64, by its file name or its 1-based number.", { target: TARGET, uid: S('the message id from a list'), which: S('the attachment file name, or its number (1, 2, …)'), mailbox: S('a folder; INBOX by default') }, ['target', 'uid', 'which']),
    tool('mail-search', 'Messages whose text matches, briefly.', { target: TARGET, text: { type: 'string' }, mailbox: S('a folder; INBOX by default') }, ['target', 'text']),
    tool('mail-move', 'Move a message to another folder. A person may approve: say why.', { target: TARGET, uid: S('the message id from a list'), mailbox: S('the destination folder'), why: WHY }, ['target', 'uid', 'mailbox']),
    tool('mail-flag', 'Mark a message read/unread or flagged/unflagged. A person may approve: say why.', { target: TARGET, uid: S('the message id from a list'), flag: S('read, unread, flagged or unflagged'), why: WHY }, ['target', 'uid', 'flag']),
    tool('mail-delete', 'Delete a message (to Trash / Deleted Items) by its number (uid). A person may approve: say why.', { target: TARGET, uid: S('the message id from a list'), mailbox: S('a folder; INBOX by default'), why: WHY }, ['target', 'uid']),
    tool('mail-send', 'Send a message from the mailbox, optionally with one or more files joined (all of them go, or the send is refused). A person may approve: say why.', { target: TARGET, to: S('recipients, comma-separated'), subject: { type: 'string' }, body: { type: 'string' }, cc: S('cc recipients, comma-separated, optional'), attachments: { type: 'array', description: 'files to join, each { name, bytes } with bytes base64-encoded', items: { type: 'object', properties: { name: S('the file name'), bytes: S('the file as base64') }, required: ['bytes'] } }, attach: S("a single file to join, as base64 bytes (shorthand for one attachment)"), attachName: S('the file name, with attach'), why: WHY }, ['target', 'to', 'subject', 'body']),
    tool('calendar-list', 'Events of a calendar target, soonest first. By default from now on; give from and/or to (ISO date or date-time) to look at any past or future window, e.g. a given week or month. Each event shows its categories. Give category to keep only one category\'s events (Microsoft).', { target: TARGET, from: S('start of the window, ISO date or date-time; now by default'), to: S('end of the window, ISO; a year after "from" by default'), category: S('only the events of this category (Microsoft)') }, ['target']),
    tool('calendar-categories', "The calendar mailbox's own categories — their names and colours (Microsoft). A read. A category is a personal label, invisible to the other participants.", { target: TARGET }, ['target']),
    tool('calendar-read', 'One event in full by its id.', { target: TARGET, id: { type: 'string' } }, ['target', 'id']),
    tool('calendar-freebusy', "See when other people are busy, to find a time together (Microsoft). Returns only busy/free blocks over the window, never their calendar contents. A read.", { target: TARGET, who: S('the people, comma-separated email addresses (up to 20)'), from: S('start of the window, local ISO date or date-time; now by default'), to: S('end of the window, local ISO; 7 days after "from" by default') }, ['target', 'who']),
    tool('calendar-create', 'Create an event, with notes and invitees. Times are the person\'s local time. A person may approve: say why.', { target: TARGET, title: { type: 'string' }, start: S('local ISO date-time, or a date for all-day'), end: S('local ISO date-time, or a date'), where: S('a place, optional'), notes: S('the event body/notes, optional'), with: S('invitees, comma-separated emails, optional (they get an invitation)'), categories: CATS, why: WHY }, ['target', 'title', 'start', 'end']),
    tool('calendar-attach', 'Join a file to an event (Microsoft). It reaches every participant on the next invitation update/resend; the result says who. Refused if a participant is external, unless share:true. A person may approve: say why.', { target: TARGET, id: S('the event id from a list'), attach: S('the file as base64 bytes'), attachName: S('the file name'), share: { type: 'boolean', description: 'attach even though a participant is external' }, why: WHY }, ['target', 'id', 'attach']),
    tool('calendar-detach', 'Remove an attachment from an event (Microsoft), by its file name or 1-based number. A person may approve: say why.', { target: TARGET, id: S('the event id from a list'), which: S('the attachment file name, or its number'), why: WHY }, ['target', 'id', 'which']),
    tool('calendar-delete', 'Delete an event. A person may approve: say why.', { target: TARGET, id: S('the event id from a list'), why: WHY }, ['target', 'id']),
    tool('calendar-respond', 'Answer a meeting invitation — accept, decline or tentative (Microsoft). A person may approve: say why.', { target: TARGET, id: S('the event id from a list'), answer: S('accept, decline or tentative'), comment: S('a short note to the organiser, optional'), why: WHY }, ['target', 'id', 'answer']),
    tool('calendar-update', 'Change an event — any of title, start, end, where, notes, invitees (Microsoft). A person may approve: say why.', { target: TARGET, id: S('the event id from a list'), title: S('new title, optional'), start: S('new start, local ISO, optional'), end: S('new end, local ISO, optional'), where: S('new place, optional'), notes: S('new body/notes, optional'), with: S('invitees, comma-separated emails, optional'), categories: CATS, why: WHY }, ['target', 'id']),
    tool('contacts-list', 'The contacts of an address-book target: name, emails, phones.', { target: TARGET }, ['target']),
    tool('contacts-search', 'Contacts whose name or email matches a word, briefly.', { target: TARGET, text: S('a name or part of one to look for') }, ['target', 'text']),
    tool('contacts-read', 'One contact in full by its id.', { target: TARGET, id: { type: 'string' } }, ['target', 'id']),
    tool('contacts-create', 'Create a contact (Microsoft). A person may approve: say why.', { target: TARGET, name: S('the full name'), email: S('an email address, optional'), phone: S('a phone number, optional'), why: WHY }, ['target']),
    tool('contacts-update', 'Change a contact — name, email or phone (Microsoft). A person may approve: say why.', { target: TARGET, id: S('the contact id from a list'), name: S('new name, optional'), email: S('new email, optional'), phone: S('new phone, optional'), why: WHY }, ['target', 'id']),
    tool('contacts-delete', 'Delete a contact (Microsoft). A person may approve: say why.', { target: TARGET, id: S('the contact id from a list'), why: WHY }, ['target', 'id']),
    tool('contacts-attach', "Set a contact's photo (Microsoft). A person may approve: say why.", { target: TARGET, id: S('the contact id from a list'), attach: S('the photo as base64 bytes'), attachName: S('the file name, optional'), why: WHY }, ['target', 'id', 'attach']),
];
/* A tool's arguments as the keeper reads them: [verb, args], or null. */
export function asked(name, a = {}) {
    if (!TOOLS.some((t) => t.name === name)) return null;
    const verb = name === 'targets' ? 'targets' : name.replace('-', '.');
    const keys = Object.keys(TOOLS.find((t) => t.name === name).inputSchema.properties);
    return [verb, Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))];
}
export function serve(dir, { input = process.stdin, output = process.stdout, wait } = {}) {
    const reply = (id, result, error) => output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`);
    const rl = createInterface({ input });
    rl.on('line', async (line) => {
        const m = parsed(line);
        if (!m || m.id === undefined) return;
        if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } });
        if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS });
        if (m.method === 'ping') return reply(m.id, {});
        if (m.method === 'tools/call') {
            const { name, arguments: a = {} } = m.params ?? {};
            const what = asked(name, a);
            if (!what) return reply(m.id, undefined, { code: -32601, message: `no tool ${name}` });
            const r = await ask(dir, what[0], what[1], wait ? { wait } : {});
            return reply(m.id, { content: [{ type: 'text', text: r.ok ? r.text : `Not done: ${r.text}` }], ...(r.ok ? {} : { isError: true }) });
        }
        return reply(m.id, undefined, { code: -32601, message: `no method ${m.method}` });
    });
    return rl;
}

const HERE = fileURLToPath(import.meta.url);
const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(HERE); } catch { return false; } })();
if (main) {
    const at = process.argv.indexOf('--dir');
    const dir = findFolder({ dir: at >= 0 ? process.argv[at + 1] : undefined });
    if (!dir) { process.stderr.write(`No ${FOLDER} folder: give --dir FOLDER.\n`); process.exit(2); }
    serve(dir);
}
