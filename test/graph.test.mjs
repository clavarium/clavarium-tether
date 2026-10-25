/* THE GRAPH CONNECTOR, against an in-memory Microsoft Graph drive (no network).
 * The `fetch` is injected (`graph({ fetch })`); a tiny store backs the drive's
 * item endpoints, so list/read/search/write/move/delete run their real code.
 * The ids and tenant below are placeholders: nothing here names a real tenant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graph, READ_MAX } from '../host/connectors/graph.mjs';
import { keeper } from '../host/keeper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-graph-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
const DRIVE = 'b!drive-id';
const TOKEN = 'graph-bearer-token-long-enough-to-mask';
const API = 'https://graph.microsoft.com/v1.0';

const parentKey = (k) => (k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '');

/* An in-memory Graph drive behind one `fetch(url, opts)`. Paths are drive
 * relative, '' is the drive root. */
function server({ token = TOKEN, clientSecret, nodes: seed } = {}) {
    const base = `${API}/drives/${DRIVE}`;
    const nodes = new Map([['', { dir: true }]]);
    for (const [p, v] of Object.entries(seed ?? {})) nodes.set(p, v.dir ? { dir: true } : { dir: false, content: v });
    const calls = [];
    const kidsOf = (dir) => [...nodes.keys()].filter((k) => k !== dir && parentKey(k) === dir);
    const itemOf = (path) => {
        const node = nodes.get(path);
        const name = path === '' ? 'root' : path.split('/').pop();
        return node.dir ? { id: `id/${path}`, name, folder: { childCount: kidsOf(path).length } } : { id: `id/${path}`, name, size: Buffer.byteLength(node.content), file: { mimeType: 'application/octet-stream' } };
    };
    const ref = (key) => ({ path: key ? `/drives/${DRIVE}/root:/${key}` : `/drives/${DRIVE}/root:` });
    const route = (url) => {
        const p = new URL(url).pathname;
        let r = p.slice(p.indexOf('/drives/') + '/drives/'.length);
        r = r.slice(r.indexOf('/') + 1); // past the drive id
        if (r === 'root' || r.startsWith('root/')) return { path: '', tail: r === 'root' ? '' : r.slice('root'.length) };
        if (r.startsWith('root:/')) { const end = r.indexOf(':', 'root:/'.length); return { path: r.slice('root:/'.length, end).split('/').map((s) => decodeURIComponent(s)).join('/'), tail: r.slice(end + 1) }; }
        return { path: '', tail: '' };
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        if (/\/oauth2\/v2\.0\/token$/.test(new URL(url).pathname)) {
            calls.push({ token: true });
            const got = new URLSearchParams(opts.body);
            if (got.get('client_secret') !== clientSecret) return json({ error: 'invalid_client' }, 401);
            return json({ access_token: token, expires_in: 3600 });
        }
        if ((opts.headers?.Authorization || '') !== `Bearer ${token}`) return json({ error: { message: 'bad token' } }, 401);
        const { path, tail } = route(url);
        calls.push({ method, path, tail });
        const node = nodes.get(path);
        if (tail === '/children') {
            if (method === 'POST') { const body = JSON.parse(opts.body); const dest = path ? `${path}/${body.name}` : body.name; if (nodes.has(dest)) return json({ error: { message: 'exists' } }, 409); nodes.set(dest, { dir: true }); return json(itemOf(dest), 201); }
            if (!node?.dir) return json({ error: { message: 'not a folder' } }, 404);
            return json({ value: kidsOf(path).map(itemOf) });
        }
        if (tail.startsWith('/search(')) {
            const q = decodeURIComponent(/q='([^']*)'/.exec(tail)?.[1] ?? '').toLowerCase();
            const hits = [...nodes.keys()].filter((k) => k !== path && (path === '' || k.startsWith(`${path}/`)) && (k.split('/').pop().toLowerCase().includes(q) || (!nodes.get(k).dir && String(nodes.get(k).content).toLowerCase().includes(q))));
            return json({ value: hits.map((k) => ({ name: k.split('/').pop(), ...(nodes.get(k).dir ? { folder: {} } : {}), parentReference: ref(parentKey(k)) })) });
        }
        if (tail === '/content') {
            if (method === 'PUT') { if (!nodes.get(parentKey(path))?.dir) return json({ error: { message: 'parent missing' } }, 409); nodes.set(path, { dir: false, content: String(opts.body) }); return json(itemOf(path), 201); }
            if (!node || node.dir) return json({ error: { message: 'not a file' } }, 404);
            return new Response(node.content, { status: 200, headers: { 'content-length': String(Buffer.byteLength(node.content)) } });
        }
        if (tail === '') {
            if (method === 'GET') { if (!node) return json({ error: { message: 'not found' } }, 404); return json(itemOf(path)); }
            if (method === 'DELETE') { if (!node) return json({ error: { message: 'not found' } }, 404); for (const k of [...nodes.keys()]) if (k === path || k.startsWith(`${path}/`)) nodes.delete(k); return new Response(null, { status: 204 }); }
            if (method === 'PATCH') {
                if (!node) return json({ error: { message: 'not found' } }, 404);
                const body = JSON.parse(opts.body);
                const destParent = /root:\/?(.*)$/.exec(body.parentReference.path)[1];
                const dest = destParent ? `${destParent}/${body.name}` : body.name;
                nodes.set(dest, node); nodes.delete(path);
                return json(itemOf(dest));
            }
        }
        return json({ error: { message: 'no route' } }, 400);
    };
    return { fetchImpl, nodes, calls };
}

const target = (over = {}) => ({ id: 'box', title: 'Team drive', kind: 'files', connector: 'graph', config: { drive: DRIVE, root: '/work', ...over.config }, secrets: over.secrets ?? { token: 'graph-token' }, ...(over.rest ?? {}) });
const ctxOf = (over = {}) => ({ agent: BOT.id, secret: async (k) => (k === 'token' ? (over.token ?? TOKEN) : k === 'secret' ? (over.secret ?? '') : '') });

test('graph: write, read, list, search, move, delete, and the root is not left', async () => {
    const s = server({ nodes: { work: { dir: true } } });
    const c = graph({ fetch: s.fetchImpl }); const t = target(); const ctx = ctxOf();
    await c.run('files.write', t, { path: 'notes/todo.txt', text: 'hello world' }, ctx);
    assert.equal(s.nodes.get('work/notes/todo.txt').content, 'hello world');
    assert.equal((await c.run('files.read', t, { path: '~/notes/todo.txt' }, ctx)).text, 'hello world');
    assert.match((await c.run('files.list', t, { path: 'notes' }, ctx)).text, /todo\.txt/);
    assert.match((await c.run('files.search', t, { path: '.', text: 'todo' }, ctx)).text, /~\/notes\/todo\.txt/);
    await c.run('files.move', t, { from: 'notes/todo.txt', to: 'done.txt' }, ctx);
    assert.equal(s.nodes.has('work/done.txt'), true);
    assert.match((await c.run('files.list', t, { path: '.' }, ctx)).text, /done\.txt/);
    await assert.rejects(c.run('files.read', t, { path: '/etc/passwd' }, ctx), /outside the folder/);
    await assert.rejects(c.run('files.read', t, { path: '../secret' }, ctx), /climbs above/);
    await c.run('files.delete', t, { path: 'done.txt' }, ctx);
    assert.equal(s.nodes.has('work/done.txt'), false);
    await assert.rejects(c.run('files.delete', t, { path: '.' }, ctx), /folder itself/);
});

test('graph: a file over the read cap is refused by its reported size', async () => {
    const big = 'x'.repeat(READ_MAX + 500);
    const s = server({ nodes: { work: { dir: true }, 'work/big.bin': big } });
    const c = graph({ fetch: s.fetchImpl });
    await assert.rejects(c.run('files.read', target(), { path: 'big.bin' }, ctxOf()), /too big to read/);
});

test('graph: a move onto something already there is refused', async () => {
    const s = server({ nodes: { work: { dir: true }, 'work/a.txt': 'A', 'work/b.txt': 'B' } });
    const c = graph({ fetch: s.fetchImpl });
    await assert.rejects(c.run('files.move', target(), { from: 'a.txt', to: 'b.txt' }, ctxOf()), /already/);
});

test('graph: a bad token is a clear Refused', async () => {
    const s = server({ nodes: { work: { dir: true } } });
    const c = graph({ fetch: s.fetchImpl });
    await assert.rejects(c.run('files.list', target(), { path: '.' }, ctxOf({ token: 'not-the-token' })), /not authorized/);
});

test('graph: client credentials — a token is fetched once and reused', async () => {
    const s = server({ clientSecret: 'client-secret-value', nodes: { work: { dir: true }, 'work/a.txt': 'A' } });
    const c = graph({ fetch: s.fetchImpl });
    const t = target({ config: { drive: DRIVE, root: '/work', tenant: 'tenant-id', clientId: 'client-id' }, secrets: { secret: 'graph-secret' } });
    const ctx = ctxOf({ secret: 'client-secret-value' });
    await c.run('files.list', t, { path: '.' }, ctx);
    await c.run('files.read', t, { path: 'a.txt' }, ctx);
    assert.equal(s.calls.filter((x) => x.token).length, 1, 'the token endpoint is hit once, then the token is cached');
});

/* ---- through the keeper: rights and the secret ---- */
const keeperWith = (level, s, opts = {}) => {
    const k = keeper(tmp(), { connectors: { graph: graph({ fetch: s.fetchImpl }) }, secrets: async (name) => (name === 'graph-token' ? TOKEN : ''), ask: opts.ask ?? (() => undefined) });
    k.store.putTarget({ id: 'box', title: 'Team drive', kind: 'files', connector: 'graph', config: { drive: DRIVE, root: '/work' }, secrets: { token: 'graph-token' } });
    if (level) k.store.grant('box', BOT.id, level);
    return k;
};

test('graph through the keeper: watch refuses a write, propose asks before writing', async () => {
    const watch = keeperWith('watch', server({ nodes: { work: { dir: true } } }));
    assert.match((await watch.act('files.write', { target: 'box', path: 'x.txt', text: 'hi' }, BOT)).text, /level watch/);
    await watch.close();

    const asked = [];
    const k = keeperWith('propose', server({ nodes: { work: { dir: true } } }), { ask: (r) => { asked.push(r); return undefined; } });
    const p = k.act('files.write', { target: 'box', path: 'x.txt', text: 'hi', why: 'Save it.' }, BOT);
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1, 'a person is asked');
    assert.equal(k.approvals().length, 1);
    k.decide(k.approvals()[0].id, 'yes', ME);
    assert.equal((await p).ok, true);
    await k.close();
});

test('graph through the keeper: the token is never in the result or the journal', async () => {
    const s = server({ nodes: { work: { dir: true }, 'work/leak.txt': `the token is ${TOKEN}` } });
    const k = keeperWith('free', s);
    const r = await k.act('files.read', { target: 'box', path: 'leak.txt' }, BOT);
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.text, /graph-bearer-token/, 'the token is masked in the returned value');
    assert.match(r.text, /\[secret\]/);
    const raw = readFileSync(join(k.store.dir, 'journal.jsonl'), 'utf8') + readFileSync(join(k.store.dir, 'state.json'), 'utf8');
    assert.doesNotMatch(raw, /graph-bearer-token/, 'neither journal nor store holds the token');
    assert.match(raw, /graph-token/, 'the store holds only the secret\'s name');
    await k.close();
});
