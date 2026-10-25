#!/usr/bin/env node
/* THE COMMAND: the verbs for any agent or script that can run a command. It
 * asks through the same folder as the MCP server (server/mcp.mjs), and prints
 * the keeper's answer. `serve` IS a keeper: the targets, their approvals and
 * their page, for use without an application.
 */
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ask, findFolder } from '../server/mcp.mjs';
import { NAME, VERSION, FOLDER, ENV_DIR } from '../server/name.mjs';

export const HELP = `${NAME}: act on the targets you were given (machines, folders, browsers).

  ${NAME}                                  your targets, your level on each, its rules
  ${NAME} run TARGET "command" [--timeout S]   run a command: its output and exit code
  ${NAME} open TARGET                      open a terminal
  ${NAME} read TARGET [--lines N]          read the terminal's screen
  ${NAME} type TARGET "keys" [--enter]     type in the terminal
  ${NAME} files TARGET list [PATH]
  ${NAME} files TARGET read PATH
  ${NAME} files TARGET search "text" [--in PATH]
  ${NAME} files TARGET write PATH --text "..." | --from LOCAL_FILE
  ${NAME} files TARGET move FROM TO
  ${NAME} files TARGET delete PATH
  ${NAME} serve [--store DIR] [--port N] [--side FOLDER=NAME] [--local FOLDER[=TITLE]]
                                       keep targets yourself, with their page (no application)

Add --why "one short line" when you act: a person may read it before deciding.
Depending on your level a person approves first; the command waits for them.
Exit: 0 done, 1 refused, 2 no folder, 3 nobody keeps the targets, 4 not answered in time, 64 not understood.
The folder used is --dir FOLDER, else $${ENV_DIR}, else the nearest ${FOLDER} folder from here up.
${NAME} ${VERSION}`;

const FILE_VERBS = ['list', 'read', 'search', 'write', 'move', 'delete'];

/* A command line, read: [verb, args] or { refused }. A --from file is read by run(). */
export function read(argv) {
    const flags = {}; const words = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--enter') { flags.enter = true; continue; }
        if (a.startsWith('--')) { if (argv[i + 1] === undefined) return { refused: `${a} needs a value` }; flags[a.slice(2)] = argv[++i]; continue; }
        words.push(a);
    }
    const [verb = 'targets', target, ...rest] = words;
    const why = flags.why !== undefined ? { why: flags.why } : {};
    const need = (ok, usage) => (ok ? null : { refused: `${NAME} ${usage}` });
    switch (verb) {
        case 'targets': return ['targets', {}];
        case 'run': return need(target && rest.length, 'run TARGET "command"') ?? ['terminal.run', { target, command: rest.join(' '), ...(flags.timeout !== undefined ? { timeout: Number(flags.timeout) } : {}), ...why }];
        case 'open': return need(target, 'open TARGET') ?? ['terminal.open', { target, ...why }];
        case 'read': return need(target, 'read TARGET') ?? ['terminal.read', { target, ...(flags.lines !== undefined ? { lines: Number(flags.lines) } : {}) }];
        case 'type': return need(target && rest.length, 'type TARGET "keys"') ?? ['terminal.type', { target, text: rest.join(' '), enter: !!flags.enter, ...why }];
        case 'files': {
            const [what, ...p] = rest;
            if (!target || !FILE_VERBS.includes(what)) return { refused: `${NAME} files TARGET ${FILE_VERBS.join('|')} ...` };
            switch (what) {
                case 'list': return ['files.list', { target, path: p[0] ?? '.' }];
                case 'read': return need(p[0], 'files TARGET read PATH') ?? ['files.read', { target, path: p[0] }];
                case 'search': return need(p.length, 'files TARGET search "text"') ?? ['files.search', { target, text: p.join(' '), path: flags.in ?? '.' }];
                case 'write':
                    if (!p[0] || (flags.text === undefined) === (flags.from === undefined)) return { refused: `${NAME} files TARGET write PATH --text "..." | --from LOCAL_FILE` };
                    return ['files.write', { target, path: p[0], ...(flags.text !== undefined ? { text: flags.text } : { from: flags.from }), ...why }];
                case 'move': return need(p.length === 2, 'files TARGET move FROM TO') ?? ['files.move', { target, from: p[0], to: p[1], ...why }];
                default: return need(p[0], 'files TARGET delete PATH') ?? ['files.delete', { target, path: p[0], ...why }];
            }
        }
        default: return { refused: `Unknown: ${verb}. Run "${NAME} --help".` };
    }
}

/* Runs one command line. Resolves with { code, out, err }: nothing is printed here. */
export async function run(argv, { env = process.env, cwd = process.cwd(), wait, onHeld } = {}) {
    const args = [...argv];
    let dir;
    const at = args.indexOf('--dir');
    if (at >= 0) { dir = args[at + 1]; if (!dir) return { code: 64, out: '', err: '--dir needs a folder.\n' }; args.splice(at, 2); }
    if (['--help', '-h', 'help'].includes(args[0])) return { code: 0, out: `${HELP}\n`, err: '' };
    if (args[0] === '--version') return { code: 0, out: `${VERSION}\n`, err: '' };
    const what = read(args);
    if (what.refused) return { code: 64, out: '', err: `${what.refused}\n` };
    if (what[1].from !== undefined) {
        try { what[1].text = readFileSync(what[1].from, 'utf8'); } catch (e) { return { code: 64, out: '', err: `cannot read ${what[1].from}: ${e.code ?? e.message}\n` }; }
        delete what[1].from;
    }
    const folder = findFolder({ dir, env, from: cwd });
    if (!folder) return { code: 2, out: '', err: `No ${FOLDER} folder here or above. Run it from your work folder, or give --dir FOLDER.\n` };
    const r = await ask(folder, what[0], what[1], { ...(wait ? { wait } : {}), onHeld });
    if (r.ok) return { code: 0, out: `${r.text}\n`, err: '' };
    return { code: r.nokeeper ? 3 : r.late ? 4 : 1, out: '', err: `Not done: ${r.text}\n` };
}

const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (main) {
    const argv = process.argv.slice(2);
    if (argv[0] === 'serve') {
        const { serveMain } = await import('../host/serve.mjs');
        await serveMain(argv.slice(1));
    } else {
        const r = await run(argv, { onHeld: (until) => process.stderr.write(`Waiting for a person (until ${new Date(until).toLocaleTimeString()})...\n`) });
        if (r.out) process.stdout.write(r.out);
        if (r.err) process.stderr.write(r.err);
        process.exitCode = r.code;
    }
}
