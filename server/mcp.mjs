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
    tool('mail-list', 'Recent messages of a mailbox target: who, subject, when — newest first.', { target: TARGET, mailbox: S('a folder; INBOX by default') }, ['target']),
    tool('mail-read', 'One message in full (headers and body) by its number (uid).', { target: TARGET, uid: S('the message id from a list (a number for IMAP, a long id for Microsoft)'), mailbox: S('a folder; INBOX by default') }, ['target', 'uid']),
    tool('mail-search', 'Messages whose text matches, briefly.', { target: TARGET, text: { type: 'string' }, mailbox: S('a folder; INBOX by default') }, ['target', 'text']),
    tool('mail-move', 'Move a message to another folder. A person may approve: say why.', { target: TARGET, uid: S('the message id from a list'), mailbox: S('the destination folder'), why: WHY }, ['target', 'uid', 'mailbox']),
    tool('mail-flag', 'Mark a message read/unread or flagged/unflagged. A person may approve: say why.', { target: TARGET, uid: S('the message id from a list'), flag: S('read, unread, flagged or unflagged'), why: WHY }, ['target', 'uid', 'flag']),
    tool('mail-send', 'Send a message from the mailbox. A person may approve: say why.', { target: TARGET, to: S('recipients, comma-separated'), subject: { type: 'string' }, body: { type: 'string' }, why: WHY }, ['target', 'to', 'subject', 'body']),
    tool('calendar-list', 'Events of a calendar target, soonest first. By default from now on; give from and/or to (ISO date or date-time) to look at any past or future window, e.g. a given week or month.', { target: TARGET, from: S('start of the window, ISO date or date-time; now by default'), to: S('end of the window, ISO; a year after "from" by default') }, ['target']),
    tool('calendar-read', 'One event in full by its id.', { target: TARGET, id: { type: 'string' } }, ['target', 'id']),
    tool('calendar-create', 'Create an event. A person may approve: say why.', { target: TARGET, title: { type: 'string' }, start: S('ISO date-time, or a date for all-day'), end: S('ISO date-time, or a date'), where: S('a place, optional'), why: WHY }, ['target', 'title', 'start', 'end']),
    tool('contacts-list', 'The contacts of an address-book target: name, emails, phones.', { target: TARGET }, ['target']),
    tool('contacts-read', 'One contact in full by its id.', { target: TARGET, id: { type: 'string' } }, ['target', 'id']),
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
