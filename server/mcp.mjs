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
/* How long an ask waits for the keeper to take it. It answers, or says it holds it for a person, within a second or two. */
export const WAIT_MS = 20_000;
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
