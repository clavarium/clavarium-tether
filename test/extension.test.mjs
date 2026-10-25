/* THE EXTENSION'S CORE, with nothing built: the pure modules that decide what
 * the agent may touch (lib/scope.js) and that turn a keeper message into one
 * action (lib/protocol.js), plus the reconnecting link (lib/link.js) against a
 * fake WebSocket and a fake clock. The browser work is a recording fake, so the
 * MESSAGE MAPPING and the TAB-SCOPING are what is checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grants } from '../extension/lib/scope.js';
import { dispatch } from '../extension/lib/protocol.js';
import { createLink } from '../extension/lib/link.js';

/* A fake browser: it records every call and answers from a tiny tab world. */
function fakeActions(world) {
    const calls = [];
    const info = (id) => world.get(String(id)) ?? null;
    const record = (name, tabId, extra) => { calls.push({ name, tabId: String(tabId), ...extra }); };
    return {
        calls,
        async tabs(g) { const on = [...world.entries()].filter(([id, t]) => g.isGranted(id, t.url)); return { text: on.map(([id, t]) => `${id}  ${t.title}`).join('\n'), size: on.length }; },
        async openTab(url, g) { const id = 'new1'; world.set(id, { url, title: 'new' }); g.grantTab(id); record('openTab', id, { url }); return { text: `opened ${url} in a new tab`, tabId: id }; },
        async activeGrantedTab(g) { for (const [id, t] of world) if (g.isGranted(id, t.url)) return id; return null; },
        async tabInfo(id) { return info(id); },
        async navigate(tabId, url) { record('navigate', tabId, { url }); return { text: `went to ${url}` }; },
        async shot(tabId) { record('shot', tabId); return { text: 'data:image/png;base64,AAAA', size: 4 }; },
        async html(tabId, a) { record('html', tabId, { selector: a.selector }); return { text: `<html>${a.selector ?? ''}</html>` }; },
        async console(tabId, a) { record('console', tabId, { lines: a.lines }); return { text: 'log: hi' }; },
        async eval(tabId, script) { record('eval', tabId, { script }); return { text: '42' }; },
        async click(tabId, a) { record('click', tabId, { selector: a.selector, x: a.x, y: a.y }); return { text: 'clicked' }; },
        async type(tabId, a) { record('type', tabId, { text: a.text }); return { text: 'typed' }; },
        async key(tabId, a) { record('key', tabId, { key: a.key }); return { text: 'pressed' }; },
        async scroll(tabId, a) { record('scroll', tabId, { dy: a.dy }); return { text: 'scrolled' }; },
        async drag(tabId, a) { record('drag', tabId, { from: a.from, to: a.to }); return { text: 'dragged' }; },
    };
}
const world = () => new Map([['7', { url: 'https://example.com/a', title: 'A' }], ['9', { url: 'https://other.example.org/b', title: 'B' }]]);

test('scope: a tab is granted by its id or by its site; nothing else', () => {
    const g = grants({ tabs: ['7'], sites: ['shop.example'] });
    assert.equal(g.isGranted('7', 'https://example.com/a'), true, 'tab turned on');
    assert.equal(g.isGranted('9', 'https://other.example.org/b'), false, 'another tab is not');
    assert.equal(g.isGranted('42', 'https://www.shop.example/x'), true, 'a tab on an allowed site');
    assert.equal(g.isGranted('42', 'https://evil.test/x'), false);
    g.setTab('7', false);
    assert.equal(g.isGranted('7', 'https://example.com/a'), false, 'turned back off');
    assert.deepEqual(g.toJSON(), { tabs: [], sites: ['shop.example'] });
});

test('protocol: tabs lists only granted tabs', async () => {
    const actions = fakeActions(world());
    const g = grants({ tabs: ['7'] });
    const r = await dispatch({ id: '1', verb: 'tabs' }, { grants: g, actions });
    assert.equal(r.ok, true);
    assert.match(r.text, /^7 /);
    assert.doesNotMatch(r.text, /\n9/);
});

test('protocol: every verb maps to its action with the right arguments', async () => {
    const actions = fakeActions(world());
    const g = grants({ tabs: ['7', '9'] });
    const run = (verb, args) => dispatch({ id: 'x', verb, args: { tab: '7', ...args } }, { grants: g, actions });
    assert.equal((await run('shot')).text, 'data:image/png;base64,AAAA');
    await run('html', { selector: '#main' });
    await run('console', { lines: 20 });
    await run('eval', { script: '1+1' });
    await run('click', { selector: '.buy' });
    await run('type', { text: 'hello' });
    await run('key', { key: 'Enter' });
    await run('scroll', { dy: 300 });
    await run('drag', { from: '1,2', to: '3,4' });
    await run('open', { url: 'https://example.com/z' }); // open WITH a granted tab = navigate
    const seen = Object.fromEntries(actions.calls.map((c) => [c.name, c]));
    assert.equal(seen.html.selector, '#main');
    assert.equal(seen.eval.script, '1+1');
    assert.equal(seen.click.selector, '.buy');
    assert.equal(seen.type.text, 'hello');
    assert.equal(seen.key.key, 'Enter');
    assert.equal(seen.scroll.dy, 300);
    assert.deepEqual([seen.drag.from, seen.drag.to], ['1,2', '3,4']);
    assert.equal(seen.navigate.url, 'https://example.com/z');
    assert.equal(seen.navigate.tabId, '7');
});

test('protocol: a verb on a non-granted tab is refused, and no action runs', async () => {
    const actions = fakeActions(world());
    const g = grants({ tabs: ['7'] });            // tab 9 is NOT granted
    const r = await dispatch({ id: '2', verb: 'eval', args: { tab: '9', script: 'steal()' } }, { grants: g, actions });
    assert.equal(r.ok, false);
    assert.match(r.error, /not granted/);
    assert.equal(actions.calls.length, 0, 'nothing ran');
});

test('protocol: open with no tab opens and grants a new tab', async () => {
    const w = world();
    const actions = fakeActions(w);
    const g = grants({});
    const r = await dispatch({ id: '3', verb: 'open', args: { url: 'https://example.com/new' } }, { grants: g, actions });
    assert.equal(r.ok, true);
    assert.match(r.text, /opened https:\/\/example\.com\/new/);
    assert.equal(g.isGranted('new1', 'https://example.com/new'), true, 'the opened tab is now granted');
});

test('protocol: the indicator is shown while a tab is acted on, then cleared', async () => {
    const actions = fakeActions(world());
    const g = grants({ tabs: ['7'] });
    const marks = [];
    const mark = async (tabId) => { marks.push(['on', String(tabId)]); return async () => marks.push(['off', String(tabId)]); };
    await dispatch({ id: '4', verb: 'click', args: { tab: '7', selector: '.go' } }, { grants: g, actions, mark });
    assert.deepEqual(marks, [['on', '7'], ['off', '7']]);
});

/* ---- the link: a fake WebSocket and a fake clock ---- */
function fakeSocket() {
    const s = { sent: [], readyState: 0 };
    s.send = (d) => s.sent.push(JSON.parse(d));
    s.close = () => { s.readyState = 3; if (s.onclose) s.onclose(); };
    s.open = () => { s.readyState = 1; if (s.onopen) s.onopen(); };
    s.recv = (obj) => { if (s.onmessage) s.onmessage({ data: JSON.stringify(obj) }); };
    return s;
}

test('link: with no token it says hello and offers a pairing code; a token is stored', () => {
    let made = null;
    let stored = null;
    const link = createLink({
        url: 'ws://127.0.0.1:4190/browser',
        WebSocketImpl: function () { made = fakeSocket(); return made; },
        getToken: () => stored,
        setToken: (t) => { stored = t; },
        pairingCode: () => '123456',
        setInt: () => 0, clearInt: () => {}, setTmo: () => 0, clearTmo: () => {},
    });
    link.start();
    made.open();
    assert.deepEqual(made.sent[0], { t: 'hello' });
    assert.deepEqual(made.sent[1], { t: 'pair', code: '123456' });
    made.recv({ t: 'paired', token: 'secret-token-xyz' });
    assert.equal(stored, 'secret-token-xyz');
    assert.equal(link.status(), 'ready');
});

test('link: a call is dispatched and its result is sent back; a ping is answered', async () => {
    let made = null;
    const link = createLink({
        url: 'ws://127.0.0.1:4190/browser',
        WebSocketImpl: function () { made = fakeSocket(); return made; },
        getToken: () => 'tok',
        onCall: async (m) => ({ t: 'result', id: m.id, ok: true, text: `did ${m.verb}`, size: 3 }),
        setInt: () => 0, clearInt: () => {}, setTmo: () => 0, clearTmo: () => {},
    });
    link.start();
    made.open();
    assert.deepEqual(made.sent[0], { t: 'hello', token: 'tok' });
    made.recv({ t: 'ping' });
    assert.deepEqual(made.sent.at(-1), { t: 'pong' });
    made.recv({ t: 'call', id: '5', verb: 'shot', args: {} });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(made.sent.at(-1), { t: 'result', id: '5', ok: true, text: 'did shot', size: 3 });
});

test('link: a dropped socket reconnects after a backoff', () => {
    const made = [];
    let timer = null;
    const link = createLink({
        url: 'ws://127.0.0.1:4190/browser',
        WebSocketImpl: function () { const s = fakeSocket(); made.push(s); return s; },
        getToken: () => 'tok',
        setInt: () => 0, clearInt: () => {},
        setTmo: (fn) => { timer = fn; return 1; }, clearTmo: () => { timer = null; },
    });
    link.start();
    made[0].open();
    made[0].close();              // dropped -> a reconnect is scheduled
    assert.equal(typeof timer, 'function');
    timer();                      // the backoff fires
    assert.equal(made.length, 2, 'a second socket was opened');
});
