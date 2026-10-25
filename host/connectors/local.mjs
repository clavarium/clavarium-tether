/* THE LOCAL CONNECTOR: the keeper's own machine, as a target. A shell in tmux
 * (terminal.*) and one folder (files.*).
 *
 * FOR TESTS AND `serve` ONLY. A target reached this way runs on the machine
 * that holds the keeper, as the keeper's user: an application never gets it
 * unless it asks for it by name (keeper option `local: true`).
 *
 *   target.config.folder   the folder: files.* stay inside it, terminals start in it
 *
 * WHAT THE AGENT'S COMMANDS SEE. Every command and every terminal starts with
 * an environment made here (PATH, HOME, LANG, TERM, USER, SHELL), never the
 * keeper's own: the keeper may hold secrets in its environment, and `env` in
 * a terminal must not print them. Shells start without rc files, for the
 * same reason and so a run says the same thing on any machine.
 *
 * tmux runs on its own socket, so the person's own sessions are never touched;
 * close() takes this connector's sessions and running commands down.
 */
import { spawn, execFile } from 'node:child_process';
import { promises as fs, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { NAME } from '../../server/name.mjs';
import { normalPath } from '../../server/rights.mjs';
import { no, Refused } from '../../server/verbs.mjs';

export const OUTPUT_MAX = 64 * 1024;
export const READ_MAX = 512 * 1024;
export const RUN_TIMEOUT_S = 60;
const LIST_MAX = 500;
const HITS_MAX = 100;
const WALK_MAX = 5000;

export function cleanEnv(from = process.env) {
    const env = { PATH: from.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: from.HOME || '/', LANG: from.LANG || 'C.UTF-8', TERM: 'xterm-256color', SHELL: '/bin/bash', PS1: '\\w\\$ ' };
    for (const k of ['USER', 'LOGNAME']) if (from[k]) env[k] = from[k];
    return env;
}

export function local({ socket = `${NAME}-local`, env = cleanEnv(), shell = 'bash' } = {}) {
    const children = new Map(); // agent -> Set of running commands
    const sessions = new Map(); // agent -> Set of tmux session names
    let socketPath = '';
    const tmux = (args) => new Promise((ok, fail) => execFile('tmux', ['-L', socket, ...args], { env, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => (error ? fail(Object.assign(error, { stderr })) : ok(stdout))));
    const sessionOf = (target, agent) => `${target.id}-${createHash('sha256').update(String(agent)).digest('hex').slice(0, 8)}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const hasSession = async (name) => { try { await tmux(['has-session', '-t', `=${name}`]); return true; } catch { return false; } };

    const folderOf = (target) => {
        const f = target.config?.folder;
        if (!f) no(`${target.title} has no folder set`);
        mkdirSync(f, { recursive: true });
        return realpathSync(f);
    };
    /* A path of the agent's, as a path on this machine, inside the folder; else refused. */
    const place = (target, given) => {
        const top = folderOf(target);
        const p = normalPath(given);
        if (p === null) no('that path climbs above the folder');
        const at = p === '~' ? top : p.startsWith('~/') ? join(top, p.slice(2)) : resolve(p);
        const inside = (x) => x === top || x.startsWith(top + sep);
        if (!inside(at)) no('that path is outside the folder');
        /* A link inside pointing outside is outside: the nearest part that exists is resolved. */
        let probe = at;
        for (;;) { try { const real = realpathSync(probe); if (!inside(real)) no('that path leads outside the folder'); break; } catch (e) { if (e instanceof Refused) throw e; const up = dirname(probe); if (up === probe) break; probe = up; } }
        return at;
    };
    const shown = (target, at) => { const r = relative(folderOf(target), at); return r ? `~/${r.split(sep).join('/')}` : '~'; };
    const isBinary = (buf) => buf.includes(0);
    const keep = (agent, map, item) => { if (!map.has(agent)) map.set(agent, new Set()); map.get(agent).add(item); };

    const verbs = {
        async 'terminal.open'(target, a, ctx) {
            const name = sessionOf(target, ctx.agent);
            if (!(await hasSession(name))) await tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', folderOf(target), shell, '--noprofile', '--norc']);
            /* Where tmux put its socket: it outlives a server that ended with its last session. */
            if (!socketPath) { try { socketPath = (await tmux(['display-message', '-p', '#{socket_path}'])).trim(); } catch { /* asked again next time */ } }
            keep(ctx.agent, sessions, name);
            return { text: `A terminal is open on ${target.title}.`, size: 0 };
        },
        async 'terminal.read'(target, a, ctx) {
            const name = sessionOf(target, ctx.agent);
            if (!(await hasSession(name))) no(`no terminal open on ${target.title}: open one first`);
            const out = (await tmux(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${a.lines ?? 40}`])).replace(/\n+$/, '');
            return { text: out || '(the screen is empty)', size: Buffer.byteLength(out) };
        },
        async 'terminal.type'(target, a, ctx) {
            const name = sessionOf(target, ctx.agent);
            if (!(await hasSession(name))) no(`no terminal open on ${target.title}: open one first`);
            if (a.text) await tmux(['send-keys', '-t', `=${name}:`, '-l', a.text]);
            if (a.enter) await tmux(['send-keys', '-t', `=${name}:`, 'Enter']);
            return { text: 'Typed.', size: 0 };
        },
        'terminal.run'(target, a, ctx) {
            const cwd = folderOf(target);
            const limit = Math.min(600, a.timeout ?? RUN_TIMEOUT_S) * 1000;
            return new Promise((ok) => {
                const child = spawn(shell, ['--noprofile', '--norc', '-c', a.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
                keep(ctx.agent, children, child);
                let out = Buffer.alloc(0); let total = 0; let late = false;
                const take = (b) => { total += b.length; out = Buffer.concat([out, b]); if (out.length > OUTPUT_MAX) out = out.subarray(out.length - OUTPUT_MAX); };
                child.stdout.on('data', take); child.stderr.on('data', take);
                const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
                const timer = setTimeout(() => { late = true; kill(); }, limit);
                child.on('error', (e) => { clearTimeout(timer); children.get(ctx.agent)?.delete(child); ok({ text: `could not start: ${e.message}`, size: 0, exit: 127 }); });
                child.on('close', (code, signal) => {
                    clearTimeout(timer); children.get(ctx.agent)?.delete(child);
                    const text = out.toString('utf8').replace(/\n+$/, '');
                    const head = total > out.length ? `(the first ${total - out.length} bytes are left out)\n` : '';
                    const exit = code ?? 128;
                    const tail = late ? `\n[stopped after ${limit / 1000} s]` : signal ? `\n[ended by ${signal}]` : '';
                    ok({ text: `${head}${text}${tail}\n[exit ${exit}]`.replace(/^\n/, ''), size: total, exit });
                });
            });
        },
        async 'files.list'(target, a) {
            const at = place(target, a.path);
            const all = await fs.readdir(at, { withFileTypes: true }).catch((e) => no(e.code === 'ENOTDIR' ? 'that is a file, not a folder' : e.code === 'ENOENT' ? 'no such folder' : e.message));
            all.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
            const lines = [];
            for (const d of all.slice(0, LIST_MAX)) {
                if (d.isDirectory()) lines.push(`${d.name}/`);
                else { const st = await fs.lstat(join(at, d.name)).catch(() => null); lines.push(`${d.name}${d.isSymbolicLink() ? ' (link)' : st ? `  ${st.size}` : ''}`); }
            }
            if (all.length > LIST_MAX) lines.push(`... and ${all.length - LIST_MAX} more`);
            const text = `${shown(target, at)}: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}${lines.length ? `\n${lines.join('\n')}` : ''}`;
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.read'(target, a) {
            const at = place(target, a.path);
            const st = await fs.stat(at).catch(() => no('no such file'));
            if (st.isDirectory()) no('that is a folder: list it');
            if (st.size > READ_MAX) no(`${st.size} bytes: too big to read here (${READ_MAX} at most)`);
            const buf = await fs.readFile(at);
            if (isBinary(buf)) return { text: `a binary file of ${buf.length} bytes: not shown`, size: buf.length };
            return { text: buf.toString('utf8'), size: buf.length };
        },
        async 'files.search'(target, a) {
            const top = place(target, a.path);
            const q = a.text.toLowerCase();
            const hits = []; let seen = 0;
            const walk = async (dir, depth) => {
                if (depth > 8 || hits.length >= HITS_MAX || seen >= WALK_MAX) return;
                const all = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
                for (const d of all) {
                    if (hits.length >= HITS_MAX || ++seen > WALK_MAX) return;
                    if (d.name === '.git' || d.name === 'node_modules') continue;
                    const at = join(dir, d.name);
                    if (d.name.toLowerCase().includes(q)) hits.push(`${shown(target, at)}${d.isDirectory() ? '/' : ''}`);
                    if (d.isDirectory()) await walk(at, depth + 1);
                    else if (d.isFile()) {
                        const st = await fs.stat(at).catch(() => null);
                        if (!st || st.size > READ_MAX) continue;
                        const buf = await fs.readFile(at).catch(() => null);
                        if (!buf || isBinary(buf)) continue;
                        buf.toString('utf8').split('\n').forEach((line, i) => { if (hits.length < HITS_MAX && line.toLowerCase().includes(q)) hits.push(`${shown(target, at)}:${i + 1}: ${line.trim().slice(0, 200)}`); });
                    }
                }
            };
            await walk(top, 0);
            const text = hits.length ? hits.join('\n') : 'Nothing found.';
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.write'(target, a) {
            const at = place(target, a.path);
            const st = await fs.stat(at).catch(() => null);
            if (st?.isDirectory()) no('that is a folder');
            await fs.mkdir(dirname(at), { recursive: true });
            await fs.writeFile(at, a.text);
            return { text: `Written: ${shown(target, at)} (${Buffer.byteLength(a.text)} bytes).`, size: Buffer.byteLength(a.text) };
        },
        async 'files.move'(target, a) {
            const from = place(target, a.from); const to = place(target, a.to);
            await fs.lstat(from).catch(() => no('nothing there to move'));
            if (await fs.lstat(to).then(() => true, () => false)) no('something is there already');
            await fs.mkdir(dirname(to), { recursive: true });
            await fs.rename(from, to);
            return { text: `Moved: ${shown(target, from)} → ${shown(target, to)}.`, size: 0 };
        },
        async 'files.delete'(target, a) {
            const at = place(target, a.path);
            if (at === folderOf(target)) no('the folder itself is not deleted');
            const st = await fs.lstat(at).catch(() => no('nothing there'));
            if (st.isDirectory()) await fs.rmdir(at).catch((e) => no(e.code === 'ENOTEMPTY' ? 'that folder is not empty' : e.message));
            else await fs.unlink(at);
            return { text: `Deleted: ${shown(target, at)}.`, size: 0 };
        },
    };

    return {
        name: 'local',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        /* An agent's terminals and running commands taken down ("*": everybody's). */
        async close(agent = '*') {
            for (const [who, set] of children) if (agent === '*' || who === agent) { for (const c of set) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } set.clear(); }
            for (const [who, set] of sessions) if (agent === '*' || who === agent) { for (const s of set) { try { await tmux(['kill-session', '-t', `=${s}`]); } catch { /* gone */ } } set.clear(); }
        },
        /* Everything of this connector, its tmux server included. */
        async shutdown() {
            await this.close('*');
            /* tmux leaves its socket file behind: it names this connector, so it goes too. */
            try { await tmux(['kill-server']); } catch { /* none */ }
            if (socketPath) rmSync(socketPath, { force: true });
        },
    };
}
