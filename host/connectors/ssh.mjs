/* THE SSH CONNECTOR: a machine the person already runs an SSH server on,
 * reached by the keeper as an ordinary SSH client. Nothing is installed on the
 * far machine: this is only a client, like ansible or a deploy script.
 *
 *   target.config.host    the machine to reach
 *   target.config.port    its SSH port (22 by default)
 *   target.config.user    the user to log in as
 *   target.config.pin     optional: the server's host key, to check its identity
 *                         ("SHA256:…" fingerprint, a known-hosts line, or the
 *                         base64 key). An unknown server is then refused.
 *   target.config.root    optional: a folder files.* may not leave
 *   target.secrets.key    the NAME of the private key in the host's secret store
 *   target.secrets.passphrase   optional: the NAME of its passphrase
 *
 * THE KEY NEVER TOUCHES THIS CODE'S OUTPUT. It is fetched at connect time from
 * the host, through `ctx.secret("key")`, handed straight to ssh2, and kept in
 * the connection. It is never returned to the agent, never journalled, never
 * logged: the keeper also masks any secret it handed out, as a second lock.
 *
 * ONE CONNECTION PER TARGET, reused across calls (and across agents that share
 * the target); it reconnects on demand if it dropped. terminal.* run over one
 * SSH channel each, files.* over SFTP. close(agent) takes an agent's shells and
 * running commands down; shutdown() ends every connection.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { no, Refused } from '../../server/verbs.mjs';
import { normalPath } from '../../server/rights.mjs';

export const OUTPUT_MAX = 64 * 1024;
export const READ_MAX = 512 * 1024;
export const RUN_TIMEOUT_S = 60;
export const READY_TIMEOUT_MS = 20_000;
const SHELL_SCREEN_MAX = 256 * 1024;
const LIST_MAX = 500;
const HITS_MAX = 100;
const WALK_MAX = 5000;

let realClient = null;
async function defaultClient() {
    if (!realClient) ({ Client: realClient } = await import('ssh2'));
    return realClient;
}

/* The server's host key as OpenSSH writes a fingerprint: "SHA256:…" (no padding). */
const fingerprint = (keyBuf) => `SHA256:${createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')}`;
/* Does the pin the target set match the key the server presented? A pin may be
 * a "SHA256:…" fingerprint, a known-hosts line (fields, the key is the base64
 * one), or the bare base64 key. */
function pinMatches(pin, keyBuf) {
    const want = String(pin).trim();
    if (!want) return true;
    if (/^SHA256:/i.test(want)) return want.replace(/=+$/, '').toLowerCase() === fingerprint(keyBuf).toLowerCase();
    const b64 = keyBuf.toString('base64');
    for (const field of want.split(/\s+/)) if (field === b64 || field.replace(/=+$/, '') === b64.replace(/=+$/, '')) return true;
    return false;
}

const ANSI = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const isBinary = (buf) => buf.includes(0);
const keep = (agent, map, item) => { if (!map.has(agent)) map.set(agent, new Set()); map.get(agent).add(item); };

export function ssh({ Client } = {}) {
    /* target.id -> { state } ; a state is { client, ready: Promise<client>, alive, sftp }. */
    const links = new Map();
    const shells = new Map();   // `${target.id}\n${agent}` -> shell channel
    const running = new Map();  // agent -> Set of exec streams, so a stop ends them

    const newClient = async () => new (Client ?? (await defaultClient()))();

    /* The ready connection for a target, opened once and reused. */
    async function link(target, ctx) {
        const existing = links.get(target.id);
        if (existing && existing.alive) return existing.ready;

        const c = target.config ?? {};
        if (!c.host) no(`${target.title} has no host set`);
        if (!c.user) no(`${target.title} has no user set`);
        const privateKey = await ctx.secret('key');
        if (!privateKey) no(`${target.title}: its key secret is empty`);
        const passphrase = target.secrets?.passphrase ? await ctx.secret('passphrase') : undefined;

        const client = await newClient();
        const state = { client, alive: true, sftp: null };
        const forget = () => { state.alive = false; if (links.get(target.id) === state) links.delete(target.id); };
        client.on('error', forget); client.on('close', forget); client.on('end', forget);

        state.ready = new Promise((ok, fail) => {
            let settled = false;
            client.on('ready', () => { if (!settled) { settled = true; ok(client); } });
            client.on('error', (e) => { if (!settled) { settled = true; fail(new Refused(`cannot reach ${target.title}: ${e?.message ?? e}`)); } });
            const config = {
                host: c.host,
                port: Number(c.port) || 22,
                username: c.user,
                privateKey,
                ...(passphrase ? { passphrase } : {}),
                readyTimeout: READY_TIMEOUT_MS,
                keepaliveInterval: 15_000,
            };
            /* The server's identity, when the target pinned it: an unknown key is refused. */
            if (c.pin) config.hostVerifier = (key, cb) => {
                const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'base64');
                const ok2 = pinMatches(c.pin, keyBuf);
                if (typeof cb === 'function') { cb(ok2); return undefined; }
                return ok2;
            };
            try { client.connect(config); } catch (e) { if (!settled) { settled = true; fail(new Refused(`cannot reach ${target.title}: ${e?.message ?? e}`)); } }
        });
        /* A connection that never became ready must not be kept as if it had. */
        state.ready.catch(forget);
        links.set(target.id, state);
        return state.ready;
    }

    const sftpOf = async (target, ctx) => {
        const client = await link(target, ctx);
        const state = links.get(target.id);
        if (state?.sftp) return state.sftp;
        const sftp = await new Promise((ok, fail) => client.sftp((err, s) => (err ? fail(new Refused(`SFTP not available on ${target.title}: ${err.message}`)) : ok(s))));
        if (state) state.sftp = sftp;
        return sftp;
    };

    /* ---- paths: kept inside config.root when the target set one ---- */
    const rootOf = (target) => {
        const r = target.config?.root;
        if (!r) return null;
        const p = normalPath(r);
        return p && p.startsWith('/') ? p : null; // a root is an absolute remote path
    };
    const realpath = (sftp, p) => new Promise((ok) => sftp.realpath(p, (err, abs) => ok(err ? null : abs)));
    /* A path of the agent's, as a path on the far machine. With a root: inside
     * it or refused (symlinks resolved too). Without a root: as given, "~" and a
     * relative path left for the server to resolve from the login home. */
    async function place(sftp, target, given) {
        const root = rootOf(target);
        const p = normalPath(given);
        if (p === null) no(root ? 'that path climbs above the folder' : 'that path climbs above the home');
        if (!root) return p === '~' ? '.' : p.startsWith('~/') ? p.slice(2) : p;
        const at = p === '~' ? root : p.startsWith('~/') ? posix.join(root, p.slice(2)) : p.startsWith('/') ? posix.normalize(p) : posix.join(root, p);
        const inside = (x) => x === root || x.startsWith(`${root}/`);
        if (!inside(at)) no('that path is outside the folder');
        /* A symlink inside that points outside is outside: resolve the nearest existing part. */
        const realRoot = (await realpath(sftp, root)) ?? root;
        const under = (x) => x === realRoot || x.startsWith(`${realRoot}/`);
        let probe = at;
        for (;;) {
            const real = await realpath(sftp, probe);
            if (real) { if (!under(real)) no('that path leads outside the folder'); break; }
            const up = posix.dirname(probe);
            if (up === probe) break;
            probe = up;
        }
        return at;
    }
    /* The folders leading to a path, made if missing (as the local connector's
     * write does); each mkdir that fails because it is already there is ignored. */
    const mkdirp = async (sftp, dir) => {
        if (!dir || dir === '.' || dir === '/') return;
        const abs = dir.startsWith('/');
        const parts = dir.split('/').filter(Boolean);
        let cur = abs ? '' : '.';
        for (const seg of parts) {
            cur = cur === '' ? `/${seg}` : cur === '.' ? seg : posix.join(cur, seg);
            await new Promise((ok) => sftp.mkdir(cur, () => ok()));
        }
    };
    const shown = (target, at) => {
        const root = rootOf(target);
        if (!root) return at;
        if (at === root) return '~';
        return at.startsWith(`${root}/`) ? `~/${at.slice(root.length + 1)}` : at;
    };

    /* ---- terminal ---- */
    const shellKey = (target, agent) => `${target.id}\n${agent}`;
    async function openShell(target, ctx) {
        const key = shellKey(target, ctx.agent);
        const had = shells.get(key);
        if (had && !had.destroyed) return had;
        const client = await link(target, ctx);
        const stream = await new Promise((ok, fail) => client.shell({ term: 'xterm-256color', rows: 40, cols: 120 }, (err, s) => (err ? fail(new Refused(`no shell on ${target.title}: ${err.message}`)) : ok(s))));
        stream.screen = '';
        const take = (b) => { stream.screen = (stream.screen + b.toString('utf8')).slice(-SHELL_SCREEN_MAX); };
        stream.on('data', take);
        if (stream.stderr) stream.stderr.on('data', take);
        stream.on('close', () => { if (shells.get(key) === stream) shells.delete(key); });
        shells.set(key, stream);
        return stream;
    }

    const verbs = {
        async 'terminal.open'(target, a, ctx) {
            await openShell(target, ctx);
            return { text: `A terminal is open on ${target.title}.`, size: 0 };
        },
        async 'terminal.read'(target, a, ctx) {
            const stream = shells.get(shellKey(target, ctx.agent));
            if (!stream || stream.destroyed) no(`no terminal open on ${target.title}: open one first`);
            const lines = Math.max(1, Math.min(2000, a.lines ?? 40));
            const text = stream.screen.replace(ANSI, '').replace(/\r/g, '').replace(/\n+$/, '').split('\n').slice(-lines).join('\n');
            return { text: text || '(the screen is empty)', size: Buffer.byteLength(text) };
        },
        async 'terminal.type'(target, a, ctx) {
            const stream = shells.get(shellKey(target, ctx.agent));
            if (!stream || stream.destroyed) no(`no terminal open on ${target.title}: open one first`);
            if (a.text) stream.write(a.text);
            if (a.enter) stream.write('\n');
            return { text: 'Typed.', size: 0 };
        },
        async 'terminal.run'(target, a, ctx) {
            const client = await link(target, ctx);
            const limit = Math.min(600, a.timeout ?? RUN_TIMEOUT_S) * 1000;
            const stream = await new Promise((ok, fail) => client.exec(a.command, (err, s) => (err ? fail(new Refused(`could not run on ${target.title}: ${err.message}`)) : ok(s))));
            keep(ctx.agent, running, stream);
            return await new Promise((ok) => {
                let out = Buffer.alloc(0); let total = 0; let late = false; let done = false;
                const take = (b) => { total += b.length; out = Buffer.concat([out, b]); if (out.length > OUTPUT_MAX) out = out.subarray(out.length - OUTPUT_MAX); };
                stream.on('data', take);
                if (stream.stderr) stream.stderr.on('data', take);
                const timer = setTimeout(() => { late = true; try { stream.signal('KILL'); } catch { /* server may refuse signals */ } try { stream.close(); } catch { /* already closing */ } try { stream.destroy(); } catch { /* idem */ } }, limit);
                const finish = (code, signal) => {
                    if (done) return; done = true;
                    clearTimeout(timer); running.get(ctx.agent)?.delete(stream);
                    const text = out.toString('utf8').replace(/\n+$/, '');
                    const head = total > out.length ? `(the first ${total - out.length} bytes are left out)\n` : '';
                    const exit = typeof code === 'number' ? code : 128;
                    const tail = late ? `\n[stopped after ${limit / 1000} s]` : signal ? `\n[ended by ${signal}]` : '';
                    ok({ text: `${head}${text}${tail}\n[exit ${exit}]`.replace(/^\n/, ''), size: total, exit });
                };
                stream.on('close', finish);
                stream.on('error', (e) => finish(128, e?.message));
            });
        },
        async 'files.list'(target, a, ctx) {
            const sftp = await sftpOf(target, ctx);
            const at = await place(sftp, target, a.path);
            const all = await new Promise((ok) => sftp.readdir(at, (err, list) => ok(err ? err : list)));
            if (all instanceof Error) no(all.code === 'ENOTDIR' || /not a directory/i.test(all.message) ? 'that is a file, not a folder' : all.code === 'ENOENT' || all.code === 2 ? 'no such folder' : all.message);
            all.sort((x, y) => (y.attrs.isDirectory() - x.attrs.isDirectory()) || x.filename.localeCompare(y.filename));
            const lines = [];
            for (const d of all.slice(0, LIST_MAX)) {
                if (d.attrs.isDirectory()) lines.push(`${d.filename}/`);
                else if (d.attrs.isSymbolicLink()) lines.push(`${d.filename} (link)`);
                else lines.push(`${d.filename}  ${d.attrs.size}`);
            }
            if (all.length > LIST_MAX) lines.push(`... and ${all.length - LIST_MAX} more`);
            const text = `${shown(target, at)}: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}${lines.length ? `\n${lines.join('\n')}` : ''}`;
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.read'(target, a, ctx) {
            const sftp = await sftpOf(target, ctx);
            const at = await place(sftp, target, a.path);
            const st = await new Promise((ok) => sftp.stat(at, (err, s) => ok(err ? err : s)));
            if (st instanceof Error) no(st.code === 'ENOENT' || st.code === 2 ? 'no such file' : st.message);
            if (st.isDirectory()) no('that is a folder: list it');
            if (st.size > READ_MAX) no(`${st.size} bytes: too big to read here (${READ_MAX} at most)`);
            const buf = await new Promise((ok, fail) => sftp.readFile(at, (err, b) => (err ? fail(new Refused(err.message)) : ok(b))));
            if (isBinary(buf)) return { text: `a binary file of ${buf.length} bytes: not shown`, size: buf.length };
            return { text: buf.toString('utf8'), size: buf.length };
        },
        async 'files.search'(target, a, ctx) {
            const sftp = await sftpOf(target, ctx);
            const top = await place(sftp, target, a.path);
            const q = a.text.toLowerCase();
            const hits = []; let seen = 0;
            const readdir = (dir) => new Promise((ok) => sftp.readdir(dir, (err, list) => ok(err ? [] : list)));
            const readFile = (p) => new Promise((ok) => sftp.readFile(p, (err, b) => ok(err ? null : b)));
            const walk = async (dir, depth) => {
                if (depth > 8 || hits.length >= HITS_MAX || seen >= WALK_MAX) return;
                for (const d of await readdir(dir)) {
                    if (hits.length >= HITS_MAX || ++seen > WALK_MAX) return;
                    if (d.filename === '.git' || d.filename === 'node_modules') continue;
                    const at = posix.join(dir, d.filename);
                    if (d.filename.toLowerCase().includes(q)) hits.push(`${shown(target, at)}${d.attrs.isDirectory() ? '/' : ''}`);
                    if (d.attrs.isDirectory()) await walk(at, depth + 1);
                    else if (d.attrs.isFile()) {
                        if (d.attrs.size > READ_MAX) continue;
                        const buf = await readFile(at);
                        if (!buf || isBinary(buf)) continue;
                        buf.toString('utf8').split('\n').forEach((line, i) => { if (hits.length < HITS_MAX && line.toLowerCase().includes(q)) hits.push(`${shown(target, at)}:${i + 1}: ${line.trim().slice(0, 200)}`); });
                    }
                }
            };
            await walk(top, 0);
            const text = hits.length ? hits.join('\n') : 'Nothing found.';
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.write'(target, a, ctx) {
            const sftp = await sftpOf(target, ctx);
            const at = await place(sftp, target, a.path);
            const st = await new Promise((ok) => sftp.stat(at, (err, s) => ok(err ? null : s)));
            if (st?.isDirectory()) no('that is a folder');
            await mkdirp(sftp, posix.dirname(at));
            await new Promise((ok, fail) => sftp.writeFile(at, a.text, (err) => (err ? fail(new Refused(err.message)) : ok())));
            return { text: `Written: ${shown(target, at)} (${Buffer.byteLength(a.text)} bytes).`, size: Buffer.byteLength(a.text) };
        },
        async 'files.move'(target, a, ctx) {
            const sftp = await sftpOf(target, ctx);
            const from = await place(sftp, target, a.from);
            const to = await place(sftp, target, a.to);
            const there = await new Promise((ok) => sftp.stat(from, (err) => ok(!err)));
            if (!there) no('nothing there to move');
            const taken = await new Promise((ok) => sftp.stat(to, (err) => ok(!err)));
            if (taken) no('something is there already');
            await mkdirp(sftp, posix.dirname(to));
            await new Promise((ok, fail) => sftp.rename(from, to, (err) => (err ? fail(new Refused(err.message)) : ok())));
            return { text: `Moved: ${shown(target, from)} → ${shown(target, to)}.`, size: 0 };
        },
        async 'files.delete'(target, a, ctx) {
            const sftp = await sftpOf(target, ctx);
            const at = await place(sftp, target, a.path);
            if (rootOf(target) && at === rootOf(target)) no('the folder itself is not deleted');
            const st = await new Promise((ok) => sftp.lstat(at, (err, s) => ok(err ? err : s)));
            if (st instanceof Error) no(st.code === 'ENOENT' || st.code === 2 ? 'nothing there' : st.message);
            if (st.isDirectory()) await new Promise((ok, fail) => sftp.rmdir(at, (err) => (err ? fail(new Refused(/not empty|ENOTEMPTY/i.test(err.message) ? 'that folder is not empty' : err.message)) : ok())));
            else await new Promise((ok, fail) => sftp.unlink(at, (err) => (err ? fail(new Refused(err.message)) : ok())));
            return { text: `Deleted: ${shown(target, at)}.`, size: 0 };
        },
    };

    return {
        name: 'ssh',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        /* An agent's shells and running commands taken down ("*": everybody's).
         * With "*", the connections go too. */
        async close(agent = '*') {
            for (const [who, set] of running) if (agent === '*' || who === agent) { for (const s of set) { try { s.close?.(); } catch { /* gone */ } try { s.destroy?.(); } catch { /* gone */ } } set.clear(); }
            for (const [key, stream] of shells) { const who = key.slice(key.indexOf('\n') + 1); if (agent === '*' || who === agent) { try { stream.end?.(); } catch { /* gone */ } try { stream.close?.(); } catch { /* gone */ } shells.delete(key); } }
            if (agent === '*') for (const [id, state] of links) { try { state.client.end(); } catch { /* gone */ } links.delete(id); }
        },
        async shutdown() { await this.close('*'); },
    };
}
