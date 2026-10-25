/* THE SSH CONNECTOR, against a fake ssh2 client (no network, no real server).
 * The fake is injected (`ssh({ Client })`); a small in-memory filesystem backs
 * its SFTP, so list/read/write/move/delete run their real code. The remote
 * paths are /srv/... on purpose: nothing here names a home directory.
 *
 * One real end-to-end against a throwaway sshd is in test/ssh-e2e.test.mjs; it
 * skips itself where no sshd is to be found. This file is what matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { ssh, OUTPUT_MAX } from '../host/connectors/ssh.mjs';
import { keeper } from '../host/keeper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-ssh-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
/* A key-looking string, long enough for the keeper's mask to take it. */
const KEY = '-----BEGIN KEY-----\nMBOGUS-private-key-material-abcdef0123456789\n-----END KEY-----';

/* ---- an in-memory SFTP filesystem ---- */
const norm = (p) => { const n = posix.normalize(p.startsWith('/') ? p : `/${p}`); return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n; };
const attrs = (node) => ({ size: node.dir ? 0 : Buffer.byteLength(node.content ?? ''), mode: node.dir ? 0o40755 : 0o100644, isDirectory: () => !!node.dir, isFile: () => !node.dir && !node.link, isSymbolicLink: () => !!node.link });
const err = (code, msg) => Object.assign(new Error(msg), { code });

function fakeFs(dirs = [], files = {}) {
    const nodes = new Map([['/', { dir: true }]]);
    for (const d of dirs) nodes.set(norm(d), { dir: true });
    for (const [p, content] of Object.entries(files)) nodes.set(norm(p), { dir: false, content });
    const soon = (cb, ...a) => setImmediate(() => cb(...a));
    return {
        nodes,
        readdir(p, cb) { const n = nodes.get(norm(p)); if (!n) return soon(cb, err(2, 'No such file')); if (!n.dir) return soon(cb, err('ENOTDIR', 'Not a directory')); const base = norm(p); const out = []; for (const [k, v] of nodes) if (k !== base && posix.dirname(k) === base) out.push({ filename: posix.basename(k), longname: posix.basename(k), attrs: attrs(v) }); soon(cb, null, out); },
        stat(p, cb) { const n = nodes.get(norm(p)); soon(cb, n ? null : err(2, 'No such file'), n ? attrs(n) : undefined); },
        lstat(p, cb) { this.stat(p, cb); },
        readFile(p, cb) { const n = nodes.get(norm(p)); if (!n || n.dir) return soon(cb, err(2, 'No such file')); soon(cb, null, Buffer.from(n.content ?? '')); },
        writeFile(p, data, cb) { const at = norm(p); if (!nodes.has(posix.dirname(at))) return soon(cb, err(2, 'No such file')); nodes.set(at, { dir: false, content: String(data) }); soon(cb, null); },
        rename(from, to, cb) { const f = norm(from); if (!nodes.has(f)) return soon(cb, err(2, 'No such file')); nodes.set(norm(to), nodes.get(f)); nodes.delete(f); soon(cb, null); },
        unlink(p, cb) { const at = norm(p); if (!nodes.has(at)) return soon(cb, err(2, 'No such file')); nodes.delete(at); soon(cb, null); },
        rmdir(p, cb) { const at = norm(p); for (const k of nodes.keys()) if (k !== at && posix.dirname(k) === at) return soon(cb, err('ENOTEMPTY', 'Directory not empty')); nodes.delete(at); soon(cb, null); },
        mkdir(p, cb) { const at = norm(p); if (nodes.has(at)) return soon(cb, err(4, 'Already exists')); nodes.set(at, { dir: true }); soon(cb, null); },
        realpath(p, cb) { const at = norm(p); soon(cb, nodes.has(at) ? null : err(2, 'No such file'), nodes.has(at) ? at : undefined); },
    };
}

/* ---- the fake ssh2 Client: a class closing over shared test state ---- */
function fakeClient(state) {
    return class FakeClient extends EventEmitter {
        connect(config) {
            state.connects.push(config);
            setImmediate(() => {
                if (config.hostVerifier) {
                    const ok = config.hostVerifier(state.hostKey);
                    if (!ok) { this.emit('error', new Error('host key verification failed')); return; }
                }
                this.emit('ready');
            });
            return this;
        }
        exec(command, cb) {
            const res = state.exec ? state.exec(command) : { code: 0, stdout: '' };
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            stream.signal = () => { state.signalled = true; };
            stream.close = () => setImmediate(() => stream.emit('close', null, 'KILL'));
            stream.destroy = () => {};
            setImmediate(() => {
                if (res.stdout) stream.emit('data', Buffer.from(res.stdout));
                if (res.stderr) stream.stderr.emit('data', Buffer.from(res.stderr));
                if (!res.hang) stream.emit('close', res.code ?? 0, res.signal);
            });
            cb(null, stream);
        }
        shell(opts, cb) {
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            stream.destroyed = false;
            stream.write = (d) => stream.emit('data', Buffer.from(d)); // a terminal that echoes
            stream.end = () => { stream.destroyed = true; stream.emit('close'); };
            stream.close = stream.end;
            state.shells.push(stream);
            cb(null, stream);
        }
        sftp(cb) { cb(null, state.sftp); }
        end() { this.emit('close'); }
    };
}

const newState = (over = {}) => ({ connects: [], shells: [], hostKey: Buffer.from('a-real-host-key'), sftp: fakeFs(['/srv', '/srv/app']), ...over });
const ctxOf = (agent = BOT.id) => ({ agent, secret: async (k) => (k === 'key' ? KEY : '') });
const target = (over = {}) => { const { config: cfg, ...rest } = over; return { id: 'srv', title: 'Server', kind: 'ssh', connector: 'ssh', config: { host: '127.0.0.1', port: 22, user: 'deploy', root: '/srv/app', ...cfg }, secrets: { key: 'srv-key' }, ...rest }; };

test('ssh: a command runs, its output and exit code come back', async () => {
    const state = newState({ exec: () => ({ code: 7, stdout: 'built ok\n' }) });
    const c = ssh({ Client: fakeClient(state) });
    const r = await c.run('terminal.run', target(), { command: 'make' }, ctxOf());
    assert.match(r.text, /built ok/);
    assert.match(r.text, /\[exit 7\]$/);
    assert.equal(r.exit, 7);
    assert.equal(state.connects.length, 1, 'one connection opened');
    await c.run('terminal.run', target(), { command: 'ls' }, ctxOf());
    assert.equal(state.connects.length, 1, 'and reused for the next call');
    await c.shutdown();
});

test('ssh: output over the cap keeps the tail and says how much was left out', async () => {
    const big = 'x'.repeat(OUTPUT_MAX + 500);
    const state = newState({ exec: () => ({ code: 0, stdout: big }) });
    const c = ssh({ Client: fakeClient(state) });
    const r = await c.run('terminal.run', target(), { command: 'dump' }, ctxOf());
    assert.equal(r.size, big.length, 'the full size is reported');
    assert.match(r.text, /^\(the first 500 bytes are left out\)/);
    assert.ok(r.text.length < big.length + 200, 'the text itself is capped');
    await c.shutdown();
});

test('ssh: a time limit stops a command that will not end', async () => {
    const state = newState({ exec: () => ({ hang: true }) });
    const c = ssh({ Client: fakeClient(state) });
    const r = await c.run('terminal.run', target(), { command: 'tail -f log', timeout: 0.2 }, ctxOf());
    assert.match(r.text, /stopped after 0.2 s/);
    assert.equal(state.signalled, true, 'the channel was signalled');
    await c.shutdown();
});

test('ssh: files over SFTP — write, read, list, search, move, delete, and the root is not left', async () => {
    const state = newState();
    const c = ssh({ Client: fakeClient(state) }); const t = target(); const ctx = ctxOf();
    await c.run('files.write', t, { path: 'notes/todo.txt', text: 'hello world' }, ctx);
    assert.equal((await c.run('files.read', t, { path: '~/notes/todo.txt' }, ctx)).text, 'hello world');
    assert.match((await c.run('files.list', t, { path: '.' }, ctx)).text, /notes\//);
    assert.match((await c.run('files.search', t, { path: '.', text: 'world' }, ctx)).text, /~\/notes\/todo.txt:1: hello world/);
    await c.run('files.move', t, { from: 'notes/todo.txt', to: 'done.txt' }, ctx);
    assert.match((await c.run('files.list', t, { path: '.' }, ctx)).text, /done.txt/);
    await assert.rejects(c.run('files.read', t, { path: '/etc/passwd' }, ctx), /outside the folder/);
    await assert.rejects(c.run('files.read', t, { path: '../secret' }, ctx), /climbs above/);
    await c.run('files.delete', t, { path: 'done.txt' }, ctx);
    assert.equal(state.sftp.nodes.has('/srv/app/done.txt'), false);
    await assert.rejects(c.run('files.delete', t, { path: '.' }, ctx), /folder itself/);
    await c.shutdown();
});

test('ssh: a terminal opens, takes keys, and reads back the screen', async () => {
    const state = newState();
    const c = ssh({ Client: fakeClient(state) }); const t = target(); const ctx = ctxOf();
    await assert.rejects(c.run('terminal.read', t, {}, ctx), /no terminal open/);
    await c.run('terminal.open', t, {}, ctx);
    await c.run('terminal.type', t, { text: 'echo hi', enter: true }, ctx);
    const screen = (await c.run('terminal.read', t, {}, ctx)).text;
    assert.match(screen, /echo hi/);
    await c.close(BOT.id);
    await assert.rejects(c.run('terminal.read', t, {}, ctx), /no terminal open/);
    await c.shutdown();
});

test('ssh: a pinned host key that matches connects; one that does not is refused', async () => {
    const state = newState();
    const good = `SHA256:${createHash('sha256').update(state.hostKey).digest('base64').replace(/=+$/, '')}`;
    const c1 = ssh({ Client: fakeClient(state) });
    assert.match((await c1.run('terminal.run', target({ config: { pin: good } }), { command: 'id' }, ctxOf())).text, /\[exit 0\]/);
    await c1.shutdown();
    const state2 = newState();
    const c2 = ssh({ Client: fakeClient(state2) });
    await assert.rejects(c2.run('terminal.run', target({ config: { pin: 'SHA256:not-the-right-key-at-all' } }), { command: 'id' }, ctxOf()), /cannot reach|host key/);
    await c2.shutdown();
});

/* ---- through the keeper: rights and the secret ---- */
const keeperWith = (level, state, opts = {}) => {
    const k = keeper(tmp(), { connectors: { ssh: ssh({ Client: fakeClient(state) }) }, secrets: async (name) => (name === 'srv-key' ? KEY : ''), ask: opts.ask ?? (() => undefined) });
    k.store.putTarget({ id: 'srv', title: 'Server', kind: 'ssh', connector: 'ssh', config: { host: '127.0.0.1', port: 22, user: 'deploy', root: '/srv/app' }, secrets: { key: 'srv-key' } });
    if (level) k.store.grant('srv', BOT.id, level);
    return k;
};

test('ssh through the keeper: watch refuses a run, propose asks before running', async () => {
    const watch = keeperWith('watch', newState());
    assert.match((await watch.act('terminal.run', { target: 'srv', command: 'id' }, BOT)).text, /level watch/);
    await watch.close();

    const asked = [];
    const k = keeperWith('propose', newState({ exec: () => ({ code: 0, stdout: 'done' }) }), { ask: (r) => { asked.push(r); return undefined; } });
    const p = k.act('terminal.run', { target: 'srv', command: 'deploy', why: 'Ship it.' }, BOT);
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1, 'a person is asked');
    assert.equal(k.approvals().length, 1);
    k.decide(k.approvals()[0].id, 'yes', ME);
    assert.equal((await p).ok, true);
    await k.close();
});

test('ssh through the keeper: the key is handed to ssh2, never to the agent or the journal', async () => {
    const state = newState({ exec: () => ({ code: 0, stdout: `leaked ${KEY}` }) }); // a command that echoes the key
    const k = keeperWith('free', state);
    const r = await k.act('terminal.run', { target: 'srv', command: 'env' }, BOT);
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.text, /BOGUS-private-key/, 'the key is masked in the returned value');
    assert.match(r.text, /\[secret\]/);
    assert.equal(state.connects[0].privateKey, KEY, 'ssh2 did receive the real key');
    const raw = readFileSync(join(k.store.dir, 'journal.jsonl'), 'utf8') + readFileSync(join(k.store.dir, 'state.json'), 'utf8');
    assert.doesNotMatch(raw, /BOGUS-private-key/, 'neither journal nor store holds the key');
    assert.match(raw, /srv-key/, 'the store holds only the secret\'s name');
    await k.close();
});
