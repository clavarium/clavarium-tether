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

export const HELP = `${NAME}: act on the targets you were given (machines, folders, browsers, mailboxes, calendars, address books).

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
  ${NAME} browser TARGET tabs               the tabs a person granted you
  ${NAME} browser TARGET open URL [--tab N]  open a URL (a granted tab, or a new one)
  ${NAME} browser TARGET shot [--tab N]      a screenshot of a granted tab
  ${NAME} browser TARGET html [--tab N] [--selector S] [--readable]
  ${NAME} browser TARGET console [--tab N] [--lines N]
  ${NAME} browser TARGET eval "script" [--tab N]
  ${NAME} browser TARGET click [SELECTOR | --x N --y N] [--tab N]
  ${NAME} browser TARGET type "text" [--selector S] [--tab N]
  ${NAME} browser TARGET key KEY [--selector S] [--tab N]
  ${NAME} browser TARGET scroll [--dx N] [--dy N] [--selector S] [--tab N]
  ${NAME} browser TARGET drag FROM TO [--tab N]
  ${NAME} mail TARGET list [--mailbox NAME] [--since DATE] [--before DATE]   recent messages (default: last 30 days)
  ${NAME} mail TARGET read UID [--mailbox NAME]        one message in full
  ${NAME} mail TARGET source UID [--mailbox NAME]      the raw source (every header, both bodies)
  ${NAME} mail TARGET attachment UID NAME|N            download one attachment (base64)
  ${NAME} mail TARGET search "text" [--mailbox NAME]
  ${NAME} mail TARGET move UID MAILBOX                 move a message to a folder
  ${NAME} mail TARGET flag UID read|unread|flagged|unflagged
  ${NAME} mail TARGET send --to "a@b,c@d" --subject "..." --body "..." [--cc "..."] [--attach FILE]
  ${NAME} calendar TARGET list [--from DATE] [--to DATE]   events in a window (default: from now on)
  ${NAME} calendar TARGET read ID
  ${NAME} calendar TARGET create --title "..." --start ISO --end ISO [--where "..."]
  ${NAME} calendar TARGET attach EVENT_ID FILE             join a file to an event (Microsoft)
  ${NAME} calendar TARGET detach EVENT_ID NAME|N           remove an attachment from an event (Microsoft)
  ${NAME} calendar TARGET delete EVENT_ID                  delete an event
  ${NAME} calendar TARGET respond EVENT_ID accept|decline|tentative   answer an invitation (Microsoft)
  ${NAME} contacts TARGET list                          name, emails, phones
  ${NAME} contacts TARGET search "name"                 contacts matching a name
  ${NAME} contacts TARGET read ID
  ${NAME} contacts TARGET attach CONTACT_ID FILE           set a contact's photo (Microsoft)
  ${NAME} serve [--store DIR] [--port N] [--side FOLDER=NAME] [--local FOLDER[=TITLE]]
                                       keep targets yourself, with their page (no application)

Add --why "one short line" when you act: a person may read it before deciding.
Depending on your level a person approves first; the command waits for them.
Exit: 0 done, 1 refused, 2 no folder, 3 nobody keeps the targets, 4 not answered in time, 64 not understood.
The folder used is --dir FOLDER, else $${ENV_DIR}, else the nearest ${FOLDER} folder from here up.
${NAME} ${VERSION}`;

const FILE_VERBS = ['list', 'read', 'search', 'write', 'move', 'delete'];
const BROWSER_VERBS = ['tabs', 'open', 'shot', 'html', 'console', 'eval', 'click', 'type', 'key', 'scroll', 'drag'];
const MAIL_VERBS = ['list', 'read', 'source', 'attachment', 'search', 'move', 'flag', 'send'];
const CAL_VERBS = ['list', 'read', 'create', 'attach', 'detach', 'delete', 'respond'];
const CONTACT_VERBS = ['list', 'search', 'read', 'attach'];
const baseName = (p) => String(p).split('/').pop();
const readB64 = (p) => { try { return readFileSync(p).toString('base64'); } catch { return null; } };

/* A command line, read: [verb, args] or { refused }. For `files write`, a --from
   local file is read by run(); other verbs keep --from as a plain value. */
export function read(argv) {
    const flags = {}; const words = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--enter') { flags.enter = true; continue; }
        if (a === '--readable') { flags.readable = true; continue; }
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
        case 'browser': {
            const [what, ...p] = rest;
            if (!target || !BROWSER_VERBS.includes(what)) return { refused: `${NAME} browser TARGET ${BROWSER_VERBS.join('|')} ...` };
            const tab = flags.tab !== undefined ? { tab: Number(flags.tab) } : {};
            const sel = flags.selector !== undefined ? { selector: flags.selector } : {};
            switch (what) {
                case 'tabs': return ['browser.tabs', { target }];
                case 'open': return need(p[0], 'browser TARGET open URL') ?? ['browser.open', { target, url: p[0], ...tab, ...why }];
                case 'shot': return ['browser.shot', { target, ...tab }];
                case 'html': return ['browser.html', { target, ...tab, ...sel, ...(flags.readable ? { readable: true } : {}) }];
                case 'console': return ['browser.console', { target, ...tab, ...(flags.lines !== undefined ? { lines: Number(flags.lines) } : {}) }];
                case 'eval': return need(p.length, 'browser TARGET eval "script"') ?? ['browser.eval', { target, script: p.join(' '), ...tab, ...why }];
                case 'click': return ['browser.click', { target, ...tab, ...(p[0] ? { selector: p[0] } : sel), ...(flags.x !== undefined ? { x: Number(flags.x) } : {}), ...(flags.y !== undefined ? { y: Number(flags.y) } : {}), ...(flags.button ? { button: flags.button } : {}), ...why }];
                case 'type': return need(p.length, 'browser TARGET type "text"') ?? ['browser.type', { target, text: p.join(' '), ...tab, ...sel, ...why }];
                case 'key': return need(p[0], 'browser TARGET key KEY') ?? ['browser.key', { target, key: p[0], ...tab, ...sel, ...why }];
                case 'scroll': return ['browser.scroll', { target, ...tab, ...sel, ...(flags.dx !== undefined ? { dx: Number(flags.dx) } : {}), ...(flags.dy !== undefined ? { dy: Number(flags.dy) } : {}), ...why }];
                default: return need(p.length === 2, 'browser TARGET drag FROM TO') ?? ['browser.drag', { target, from: p[0], to: p[1], ...tab, ...why }];
            }
        }
        case 'mail': {
            const [what, ...p] = rest;
            if (!target || !MAIL_VERBS.includes(what)) return { refused: `${NAME} mail TARGET ${MAIL_VERBS.join('|')} ...` };
            const box = flags.mailbox !== undefined ? { mailbox: flags.mailbox } : {};
            switch (what) {
                case 'list': return ['mail.list', { target, ...box, ...(flags.since !== undefined ? { since: flags.since } : {}), ...(flags.before !== undefined ? { before: flags.before } : {}) }];
                case 'read': return need(p[0], 'mail TARGET read UID [--mailbox NAME]') ?? ['mail.read', { target, uid: p[0], ...box }];
                case 'source': return need(p[0], 'mail TARGET source UID [--mailbox NAME]') ?? ['mail.source', { target, uid: p[0], ...box }];
                case 'attachment': return need(p.length >= 2, 'mail TARGET attachment UID NAME|N [--mailbox NAME]') ?? ['mail.attachment', { target, uid: p[0], which: p.slice(1).join(' '), ...box }];
                case 'search': return need(p.length, 'mail TARGET search "text" [--mailbox NAME]') ?? ['mail.search', { target, text: p.join(' '), ...box }];
                case 'move': return need(p.length === 2, 'mail TARGET move UID MAILBOX') ?? ['mail.move', { target, uid: p[0], mailbox: p[1], ...why }];
                case 'flag': return need(p.length === 2, 'mail TARGET flag UID FLAG') ?? ['mail.flag', { target, uid: p[0], flag: p[1], ...why }];
                default: {
                    const bad = need(flags.to !== undefined && flags.subject !== undefined && flags.body !== undefined, 'mail TARGET send --to "a@b" --subject "..." --body "..." [--cc "..."] [--attach FILE]');
                    if (bad) return bad;
                    let att = {};
                    if (flags.attach !== undefined) { const b = readB64(flags.attach); if (b === null) return { refused: `cannot read the file to attach: ${flags.attach}` }; att = { attach: b, attachName: flags['attach-name'] || baseName(flags.attach) }; }
                    return ['mail.send', { target, to: flags.to, subject: flags.subject, body: flags.body, ...(flags.cc !== undefined ? { cc: flags.cc } : {}), ...att, ...why }];
                }
            }
        }
        case 'calendar': {
            const [what, ...p] = rest;
            if (!target || !CAL_VERBS.includes(what)) return { refused: `${NAME} calendar TARGET ${CAL_VERBS.join('|')} ...` };
            switch (what) {
                case 'list': return ['calendar.list', { target, ...(flags.from !== undefined ? { from: flags.from } : {}), ...(flags.to !== undefined ? { to: flags.to } : {}) }];
                case 'read': return need(p[0], 'calendar TARGET read ID') ?? ['calendar.read', { target, id: p[0] }];
                case 'attach': {
                    if (p.length < 2) return { refused: 'calendar TARGET attach EVENT_ID FILE' };
                    const b = readB64(p[1]); if (b === null) return { refused: `cannot read the file to attach: ${p[1]}` };
                    return ['calendar.attach', { target, id: p[0], attach: b, attachName: flags['attach-name'] || baseName(p[1]), ...why }];
                }
                case 'detach': return need(p.length >= 2, 'calendar TARGET detach EVENT_ID NAME|N') ?? ['calendar.detach', { target, id: p[0], which: p.slice(1).join(' '), ...why }];
                case 'delete': return need(p[0], 'calendar TARGET delete EVENT_ID') ?? ['calendar.delete', { target, id: p[0], ...why }];
                case 'respond': return need(p.length >= 2, 'calendar TARGET respond EVENT_ID accept|decline|tentative [--comment "..."]') ?? ['calendar.respond', { target, id: p[0], answer: p[1], ...(flags.comment !== undefined ? { comment: flags.comment } : {}), ...why }];
                default: return need(flags.title !== undefined && flags.start !== undefined && flags.end !== undefined, 'calendar TARGET create --title "..." --start ISO --end ISO [--where "..."]') ?? ['calendar.create', { target, title: flags.title, start: flags.start, end: flags.end, ...(flags.where !== undefined ? { where: flags.where } : {}), ...why }];
            }
        }
        case 'contacts': {
            const [what, ...p] = rest;
            if (!target || !CONTACT_VERBS.includes(what)) return { refused: `${NAME} contacts TARGET ${CONTACT_VERBS.join('|')} ...` };
            if (what === 'list') return ['contacts.list', { target }];
            if (what === 'search') return need(p.length, 'contacts TARGET search "name"') ?? ['contacts.search', { target, text: p.join(' ') }];
            if (what === 'attach') {
                if (p.length < 2) return { refused: 'contacts TARGET attach CONTACT_ID FILE (a photo)' };
                const b = readB64(p[1]); if (b === null) return { refused: `cannot read the file to attach: ${p[1]}` };
                return ['contacts.attach', { target, id: p[0], attach: b, attachName: flags['attach-name'] || baseName(p[1]), ...why }];
            }
            return need(p[0], 'contacts TARGET read ID') ?? ['contacts.read', { target, id: p[0] }];
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
    /* Only `files write --from LOCAL_FILE` reads a local file. Other verbs use `from`
       for their own thing (a calendar window's start, a move's source, a drag's point),
       so it must not be swallowed as a filename. */
    if (what[0] === 'files.write' && what[1].from !== undefined) {
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
