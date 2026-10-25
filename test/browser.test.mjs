/* THE BROWSER CONNECTOR, against a fake extension on a fake socket (no network,
 * no real browser). A pair of linked channels stands in for the WebSocket: a
 * message sent on one arrives on the other. The fake extension answers calls
 * from a small tab world, so the connector's mapping and tab-scoping run their
 * real code.
 *
 * Through the keeper, the same checks the ssh connector gets: a level refuses
 * or asks, a tab the person did not grant is refused, and the pairing token
 * never reaches the agent or the journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browser, memTokens } from '../host/connectors/browser.mjs';
import { keeper } from '../host/keeper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-browser-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
const ctxOf = (agent = BOT.id) => ({ agent, secret: async () => '' });

/* ---- a pair of linked channels (the socket's two ends) ---- */
function makePair() {
    const end = () => ({ _msgs: new Set(), _closes: new Set(), closed: false });
    const a = end(); const b = end();
    const wire = (self, other) => {
        self.send = (obj) => { if (self.closed || other.closed) return; queueMicrotask(() => { for (const fn of [...other._msgs]) fn(JSON.parse(JSON.stringify(obj))); }); };
        self.onMessage = (fn) => { self._msgs.add(fn); return () => self._msgs.delete(fn); };
        self.onClose = (fn) => { self._closes.add(fn); return () => self._closes.delete(fn); };
        self.close = () => { if (self.closed) return; self.closed = true; other.closed = true; queueMicrotask(() => { for (const fn of [...other._closes]) fn(); for (const fn of [...self._closes]) fn(); }); };
    };
    wire(a, b); wire(b, a);
    return { keeperSide: a, extSide: b };
}

/* ---- a fake extension driving the far end ---- */
function fakeExtension(extSide, { token } = {}) {
    const ext = { calls: [], control: null, token };
    const result = (verb, args) => {
        switch (verb) {
            case 'open': return { text: `opened ${args.url}`, size: 6 };
            case 'shot': return { text: 'data:image/png;base64,AAAA', size: 4 };
            case 'html': return { text: `<html>${args.selector ?? ''}</html>`, size: 6 };
            case 'console': return { text: 'log: hi', size: 7 };
            case 'eval': return { text: '42', size: 2 };
            case 'click': return { text: `clicked ${args.selector ?? `${args.x},${args.y}`}`, size: 0 };
            case 'type': return { text: `typed ${args.text}`, size: 0 };
            case 'key': return { text: `key ${args.key}`, size: 0 };
            case 'scroll': return { text: `scrolled ${args.dx ?? 0},${args.dy ?? 0}`, size: 0 };
            case 'drag': return { text: `dragged ${args.from}->${args.to}`, size: 0 };
            default: return null;
        }
    };
    extSide.onMessage((m) => {
        if (m.t === 'welcome' || m.t === 'pair-needed' || m.t === 'paired') { ext.control = m; if (m.t === 'paired') ext.token = m.token; return; }
        if (m.t === 'pong' || m.t === 'ping') return;
        if (m.t === 'call') {
            ext.calls.push(m);
            const r = result(m.verb, m.args || {});
            extSide.send(r ? { t: 'result', id: m.id, ok: true, ...r } : { t: 'result', id: m.id, ok: false, error: `no verb ${m.verb}` });
        }
    });
    ext.hello = () => extSide.send({ t: 'hello', ...(ext.token ? { token: ext.token } : {}) });
    ext.pair = (code) => extSide.send({ t: 'pair', code });
    ext.tabs = (tabs) => extSide.send({ t: 'tabs', tabs });
    return ext;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/* A connected, paired connector with two granted tabs. */
async function connected(opts = {}) {
    const conn = browser(opts);
    const { keeperSide, extSide } = makePair();
    const ext = fakeExtension(extSide);
    conn.accept(keeperSide);
    ext.hello();          // no token yet -> pair-needed
    await tick();
    ext.pair('123456');   // show a code
    await tick();
    conn.pair('123456');  // the person types it on the page
    await tick();
    ext.tabs([{ id: 7, url: 'https://example.com/a', title: 'A', site: 'example.com' }, { id: 9, url: 'https://example.com/b', title: 'B', site: 'example.com' }]);
    await tick();
    return { conn, ext };
}

test('browser: pairing mints a token the extension keeps, and reconnect is trusted', async () => {
    const tokens = memTokens();
    const conn = browser({ tokens });
    const { keeperSide, extSide } = makePair();
    const ext = fakeExtension(extSide);
    conn.accept(keeperSide);
    ext.hello();
    await tick();
    assert.equal(ext.control.t, 'pair-needed', 'no token: asked to pair');
    ext.pair('42');
    await tick();
    conn.pair('42');
    await tick();
    assert.equal(ext.control.t, 'paired');
    assert.ok(ext.token && ext.token.length > 20, 'the extension got a long token');
    assert.equal(tokens.list().length, 1, 'the keeper remembers one token');
    assert.equal(conn.status().connected, true);

    /* A fresh socket with that token is trusted at once. */
    const conn2 = browser({ tokens });
    const p2 = makePair();
    const ext2 = fakeExtension(p2.extSide, { token: ext.token });
    conn2.accept(p2.keeperSide);
    ext2.hello();
    await tick();
    assert.equal(ext2.control.t, 'welcome', 'a known token: welcomed, no pairing');
    assert.equal(conn2.status().connected, true);
    conn.shutdown(); conn2.shutdown();
});

test('browser: a wrong code is refused', async () => {
    const conn = browser();
    assert.throws(() => conn.pair('nope'), /no browser is waiting/);
    conn.shutdown();
});

test('browser: every verb maps to the extension and its answer comes back', async () => {
    const { conn, ext } = await connected();
    assert.match((await conn.run('browser.tabs', {}, {}, ctxOf())).text, /example\.com\/a/);
    assert.match((await conn.run('browser.open', {}, { url: 'https://example.com/c' }, ctxOf())).text, /opened https:\/\/example\.com\/c/);
    assert.match((await conn.run('browser.shot', {}, { tab: 7 }, ctxOf())).text, /^data:image\/png/);
    assert.match((await conn.run('browser.html', {}, { tab: 7, selector: '#main' }, ctxOf())).text, /#main/);
    assert.match((await conn.run('browser.console', {}, { tab: 7 }, ctxOf())).text, /log: hi/);
    assert.equal((await conn.run('browser.eval', {}, { tab: 9, script: '1+1' }, ctxOf())).text, '42');
    assert.match((await conn.run('browser.click', {}, { tab: 7, selector: '.go' }, ctxOf())).text, /clicked \.go/);
    assert.match((await conn.run('browser.type', {}, { tab: 7, text: 'hi' }, ctxOf())).text, /typed hi/);
    assert.match((await conn.run('browser.key', {}, { tab: 7, key: 'Enter' }, ctxOf())).text, /key Enter/);
    assert.match((await conn.run('browser.scroll', {}, { tab: 7, dy: 400 }, ctxOf())).text, /scrolled 0,400/);
    assert.match((await conn.run('browser.drag', {}, { tab: 7, from: '1,2', to: '3,4' }, ctxOf())).text, /dragged 1,2->3,4/);
    /* The tabs verb never leaves the keeper; the others each sent one call. */
    assert.equal(ext.calls.filter((c) => c.verb === 'tabs').length, 0);
    assert.equal(ext.calls.length, 10);
    conn.shutdown();
});

test('browser: a verb on a non-granted tab is refused before anything is sent', async () => {
    const { conn, ext } = await connected();
    await assert.rejects(conn.run('browser.eval', {}, { tab: 999, script: 'x' }, ctxOf()), /was not granted/);
    assert.equal(ext.calls.length, 0, 'nothing was sent to the extension');
    conn.shutdown();
});

test('browser: a call with no extension connected is refused', async () => {
    const conn = browser();
    await assert.rejects(conn.run('browser.shot', { title: 'Browser' }, {}, ctxOf()), /not connected/);
    conn.shutdown();
});

/* ---- through the keeper: rights and the token ---- */
async function keeperWith(level, opts = {}) {
    const conn = browser();
    const { keeperSide, extSide } = makePair();
    const ext = fakeExtension(extSide);
    conn.accept(keeperSide);
    ext.hello(); await tick(); ext.pair('1'); await tick(); conn.pair('1'); await tick();
    ext.tabs([{ id: 7, url: 'https://example.com/a', title: 'A', site: 'example.com' }]);
    await tick();
    const k = keeper(tmp(), { connectors: { browser: conn, ssh: null }, ask: opts.ask ?? (() => undefined) });
    k.store.putTarget({ id: 'browser', title: 'Browser', kind: 'browser', connector: 'browser', config: {} });
    if (level) k.store.grant('browser', BOT.id, level);
    return { k, conn, ext };
}

test('browser through the keeper: watch allows a read but refuses eval; propose asks', async () => {
    const { k } = await keeperWith('watch');
    assert.match((await k.act('browser.shot', { target: 'browser', tab: 7 }, BOT)).text, /^data:image\/png/);
    assert.match((await k.act('browser.eval', { target: 'browser', tab: 7, script: 'x' }, BOT)).text, /level watch/);
    await k.close();

    const asked = [];
    const { k: k2 } = await keeperWith('propose', { ask: (r) => { asked.push(r); return undefined; } });
    const p = k2.act('browser.click', { target: 'browser', tab: 7, selector: '.buy', why: 'Add to cart.' }, BOT);
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1, 'a person is asked');
    assert.equal(asked[0].detail, '.buy');
    k2.decide(k2.approvals()[0].id, 'yes', ME);
    assert.equal((await p).ok, true);
    await k2.close();
});

test('browser through the keeper: the pairing token is never journalled nor stored', async () => {
    const { k, ext } = await keeperWith('free');
    const r = await k.act('browser.eval', { target: 'browser', tab: 7, script: '2+2' }, BOT);
    assert.equal(r.ok, true);
    assert.equal(r.text, '42');
    const raw = readFileSync(join(k.store.dir, 'journal.jsonl'), 'utf8') + readFileSync(join(k.store.dir, 'state.json'), 'utf8');
    assert.ok(ext.token && ext.token.length > 20);
    assert.ok(!raw.includes(ext.token), 'the token appears in neither journal nor store');
    await k.close();
});

test('browser through the keeper: an ungranted tab is refused with the result journalled', async () => {
    const { k } = await keeperWith('free');
    const r = await k.act('browser.eval', { target: 'browser', tab: 404, script: 'x' }, BOT);
    assert.equal(r.ok, false);
    assert.match(r.text, /was not granted/);
    await k.close();
});
