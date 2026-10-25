/* THE WEBDAV CONNECTOR, against an in-memory WebDAV server (no network). The
 * `fetch` is injected (`webdav({ fetch })`); a tiny store backs PROPFIND / GET /
 * PUT / MKCOL / MOVE / DELETE, so list/read/search/write/move/delete run their
 * real code. The base URL is cloud.example.com on purpose: nothing here names a
 * real server, and the host is a placeholder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { webdav, READ_MAX } from '../host/connectors/webdav.mjs';
import { keeper } from '../host/keeper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-dav-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
const BASE = 'https://cloud.example.com/dav';
const USER = 'alice';
const PASS = 'app-password-token-long-enough-to-mask';

const enc = (abs) => abs.split('/').map(encodeURIComponent).join('/');
const xmlResponse = (status, body) => new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });

/* An in-memory WebDAV server behind one `fetch(url, opts)`. */
function server({ password = PASS, nodes: seed } = {}) {
    const basePath = new URL(BASE).pathname.replace(/\/+$/, '');
    const nodes = new Map([['/', { dir: true }]]);
    for (const [p, v] of Object.entries(seed ?? {})) nodes.set(p, v.dir ? { dir: true } : { dir: false, content: v });
    const toAbs = (url) => {
        let p = new URL(url).pathname;
        p = p.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
        if (p === basePath || p.startsWith(`${basePath}/`)) p = p.slice(basePath.length);
        p = p.replace(/\/+$/, '');
        return p === '' ? '/' : p;
    };
    const kidsOf = (dir) => [...nodes.keys()].filter((k) => k !== dir && posix.dirname(k) === dir);
    const propEntry = (abs, node) => {
        const href = basePath + enc(abs) + (node.dir ? '/' : '');
        return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${node.dir ? '<d:collection/>' : ''}</d:resourcetype>`
            + `${node.dir ? '' : `<d:getcontentlength>${Buffer.byteLength(node.content ?? '')}</d:getcontentlength>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    };
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        const abs = toAbs(url);
        calls.push({ method, abs });
        const auth = opts.headers?.Authorization || '';
        const ok = auth === `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`;
        if (!ok) return new Response('no', { status: 401 });
        const node = nodes.get(abs);
        if (method === 'PROPFIND') {
            if (!node) return new Response('', { status: 404 });
            const parts = [propEntry(abs, node)];
            if ((opts.headers?.Depth ?? '0') !== '0' && node.dir) for (const k of kidsOf(abs)) parts.push(propEntry(k, nodes.get(k)));
            return xmlResponse(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`);
        }
        if (method === 'GET') {
            if (!node) return new Response('', { status: 404 });
            if (node.dir) return new Response('', { status: 405 });
            return new Response(node.content, { status: 200, headers: { 'content-length': String(Buffer.byteLength(node.content)) } });
        }
        if (method === 'MKCOL') { if (node) return new Response('', { status: 405 }); if (!nodes.get(posix.dirname(abs))?.dir) return new Response('', { status: 409 }); nodes.set(abs, { dir: true }); return new Response('', { status: 201 }); }
        if (method === 'PUT') { const parent = nodes.get(posix.dirname(abs)); if (!parent?.dir) return new Response('', { status: 409 }); if (node?.dir) return new Response('', { status: 405 }); nodes.set(abs, { dir: false, content: String(opts.body) }); return new Response('', { status: 201 }); }
        if (method === 'MOVE') {
            if (!node) return new Response('', { status: 404 });
            const dest = toAbs(opts.headers.Destination);
            if (nodes.has(dest) && (opts.headers.Overwrite ?? 'T') === 'F') return new Response('', { status: 412 });
            nodes.set(dest, node); nodes.delete(abs); return new Response('', { status: 201 });
        }
        if (method === 'DELETE') { if (!node) return new Response('', { status: 404 }); for (const k of [...nodes.keys()]) if (k === abs || k.startsWith(`${abs}/`)) nodes.delete(k); return new Response(null, { status: 204 }); }
        return new Response('', { status: 405 });
    };
    return { fetchImpl, nodes, calls };
}

const target = (over = {}) => ({ id: 'box', title: 'Cloud', kind: 'files', connector: 'webdav', config: { url: BASE, user: USER, root: '/work', ...over.config }, secrets: { password: 'dav-pass' }, ...over });
const ctxOf = (password = PASS) => ({ agent: BOT.id, secret: async (k) => (k === 'password' ? password : '') });

test('webdav: write, read, list, search, move, delete, and the root is not left', async () => {
    const s = server({ nodes: { '/work': { dir: true } } });
    const c = webdav({ fetch: s.fetchImpl }); const t = target(); const ctx = ctxOf();
    await c.run('files.write', t, { path: 'notes/todo.txt', text: 'hello world' }, ctx);
    assert.equal(s.nodes.get('/work/notes/todo.txt').content, 'hello world');
    assert.equal((await c.run('files.read', t, { path: '~/notes/todo.txt' }, ctx)).text, 'hello world');
    assert.match((await c.run('files.list', t, { path: '.' }, ctx)).text, /notes\//);
    assert.match((await c.run('files.search', t, { path: '.', text: 'todo' }, ctx)).text, /~\/notes\/todo\.txt/);
    await c.run('files.move', t, { from: 'notes/todo.txt', to: 'done.txt' }, ctx);
    assert.match((await c.run('files.list', t, { path: '.' }, ctx)).text, /done\.txt/);
    await assert.rejects(c.run('files.read', t, { path: '/etc/passwd' }, ctx), /outside the folder/);
    await assert.rejects(c.run('files.read', t, { path: '../secret' }, ctx), /climbs above/);
    await c.run('files.delete', t, { path: 'done.txt' }, ctx);
    assert.equal(s.nodes.has('/work/done.txt'), false);
    await assert.rejects(c.run('files.delete', t, { path: '.' }, ctx), /folder itself/);
});

test('webdav: a move onto something already there is refused (Overwrite: F)', async () => {
    const s = server({ nodes: { '/work': { dir: true }, '/work/a.txt': 'A', '/work/b.txt': 'B' } });
    const c = webdav({ fetch: s.fetchImpl });
    await assert.rejects(c.run('files.move', target(), { from: 'a.txt', to: 'b.txt' }, ctxOf()), /already/);
});

test('webdav: a file over the read cap is refused by its length', async () => {
    const big = 'x'.repeat(READ_MAX + 500);
    const s = server({ nodes: { '/work': { dir: true }, '/work/big.bin': big } });
    const c = webdav({ fetch: s.fetchImpl });
    await assert.rejects(c.run('files.read', target(), { path: 'big.bin' }, ctxOf()), /too big to read/);
});

test('webdav: a wrong password is a clear Refused, not a crash', async () => {
    const s = server({ nodes: { '/work': { dir: true } } });
    const c = webdav({ fetch: s.fetchImpl });
    await assert.rejects(c.run('files.list', target(), { path: '.' }, ctxOf('the-wrong-password')), /not authorized/);
});

/* ---- through the keeper: rights and the secret ---- */
const keeperWith = (level, s, opts = {}) => {
    const k = keeper(tmp(), { connectors: { webdav: webdav({ fetch: s.fetchImpl }) }, secrets: async (name) => (name === 'dav-pass' ? PASS : ''), ask: opts.ask ?? (() => undefined) });
    k.store.putTarget({ id: 'box', title: 'Cloud', kind: 'files', connector: 'webdav', config: { url: BASE, user: USER, root: '/work' }, secrets: { password: 'dav-pass' } });
    if (level) k.store.grant('box', BOT.id, level);
    return k;
};

test('webdav through the keeper: watch refuses a write, propose asks before writing', async () => {
    const watch = keeperWith('watch', server({ nodes: { '/work': { dir: true } } }));
    assert.match((await watch.act('files.write', { target: 'box', path: 'x.txt', text: 'hi' }, BOT)).text, /level watch/);
    await watch.close();

    const asked = [];
    const k = keeperWith('propose', server({ nodes: { '/work': { dir: true } } }), { ask: (r) => { asked.push(r); return undefined; } });
    const p = k.act('files.write', { target: 'box', path: 'x.txt', text: 'hi', why: 'Save it.' }, BOT);
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1, 'a person is asked');
    assert.equal(k.approvals().length, 1);
    k.decide(k.approvals()[0].id, 'yes', ME);
    assert.equal((await p).ok, true);
    await k.close();
});

test('webdav through the keeper: the password is never in the result or the journal', async () => {
    const s = server({ nodes: { '/work': { dir: true }, '/work/leak.txt': `the password is ${PASS}` } });
    const k = keeperWith('free', s);
    const r = await k.act('files.read', { target: 'box', path: 'leak.txt' }, BOT);
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.text, /app-password-token/, 'the password is masked in the returned value');
    assert.match(r.text, /\[secret\]/);
    const raw = readFileSync(join(k.store.dir, 'journal.jsonl'), 'utf8') + readFileSync(join(k.store.dir, 'state.json'), 'utf8');
    assert.doesNotMatch(raw, /app-password-token/, 'neither journal nor store holds the password');
    assert.match(raw, /dav-pass/, 'the store holds only the secret\'s name');
    await k.close();
});
