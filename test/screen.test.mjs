/* THE SCREEN CONNECTOR, against a fake engine (no network, no MeshCentral).
 * The fake records every call and returns a tiny data URL for a shot; the
 * envelope is injected with it (`screen({ engine })`), so all of the wrapper's
 * own code runs: the session, the URL and token, the verb mapping, the key
 * map, the rate limit, and the rights through the keeper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screen, vkOf, VK, RATE_MAX } from '../host/connectors/screen.mjs';
import { keeper } from '../host/keeper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-screen-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
/* A token-looking string, long enough for the keeper's mask to take it. */
const TOKEN = 'screen-login-token-abcdef0123456789-SECRET';
const SHOT = 'data:image/png;base64,AAAA';

/* ---- a fake engine: a factory that records every call it is handed ---- */
function fakeEngine(state) {
    return function createFake() {
        const inst = {
            async connect(args) { state.connects.push(args); if (state.connectThrows) throw state.connectThrows; },
            async shot() { state.calls.push(['shot']); return { dataUrl: SHOT, width: 8, height: 4 }; },
            async move(x, y) { state.calls.push(['move', x, y]); },
            async click(x, y, button) { state.calls.push(['click', x, y, button]); },
            async drag(from, to) { state.calls.push(['drag', from, to]); },
            async scroll(dx, dy) { state.calls.push(['scroll', dx, dy]); },
            async type(text) { state.calls.push(['type', text]); },
            async key(vk) { state.calls.push(['key', vk]); },
            async keyDown(vk) { state.calls.push(['keyDown', vk]); },
            async keyUp(vk) { state.calls.push(['keyUp', vk]); },
            async close() { state.closed++; },
        };
        state.instances.push(inst);
        return inst;
    };
}
const newState = (over = {}) => ({ connects: [], calls: [], instances: [], closed: 0, ...over });
const ctxOf = (agent = BOT.id) => ({ agent, secret: async (k) => (k === 'token' ? TOKEN : '') });
const target = (over = {}) => {
    const { config: cfg, ...rest } = over;
    return { id: 'kiosk', title: 'Kiosk', kind: 'screen', connector: 'screen', config: { url: 'wss://screen.example.com/control', ...cfg }, secrets: { token: 'kiosk-token' }, ...rest };
};

test('screen: the url comes from the target config, never from the agent args', async () => {
    const state = newState();
    const c = screen({ engine: fakeEngine(state) });
    /* The agent tries to smuggle a url in; it is ignored. */
    await c.run('screen.shot', target(), { url: 'wss://evil.example.com/' }, ctxOf());
    assert.equal(state.connects.length, 1);
    assert.equal(state.connects[0].url, 'wss://screen.example.com/control');
    assert.equal(state.connects[0].token, TOKEN, 'the token reached the engine');
    await c.shutdown();
});

test('screen: a session is opened once, reused across verbs, then closed per agent', async () => {
    const state = newState();
    const c = screen({ engine: fakeEngine(state) }); const t = target(); const ctx = ctxOf();
    await c.run('screen.shot', t, {}, ctx);
    await c.run('screen.move', t, { x: 3, y: 4 }, ctx);
    await c.run('screen.type', t, { text: 'hi' }, ctx);
    assert.equal(state.connects.length, 1, 'connected once');
    assert.equal(state.instances.length, 1, 'one engine instance');
    await c.close(BOT.id);
    assert.equal(state.closed, 1, 'the session was closed');
    /* A later verb opens a fresh session. */
    await c.run('screen.shot', t, {}, ctx);
    assert.equal(state.connects.length, 2, 'reopened on demand');
    await c.shutdown();
});

test('screen: each verb maps to the engine call it should', async () => {
    const state = newState();
    const c = screen({ engine: fakeEngine(state) }); const t = target(); const ctx = ctxOf();

    const shot = await c.run('screen.shot', t, {}, ctx);
    assert.equal(shot.text, SHOT);
    assert.equal(shot.size, Buffer.byteLength(SHOT));

    assert.equal((await c.run('screen.move', t, { x: 10, y: 20 }, ctx)).text, 'Done.');
    await c.run('screen.click', t, { x: 5, y: 6, button: 'right' }, ctx);
    await c.run('screen.drag', t, { from: '1,2', to: '3,4' }, ctx);
    await c.run('screen.scroll', t, { dx: 0, dy: -5 }, ctx);
    await c.run('screen.type', t, { text: 'hello' }, ctx);

    assert.deepEqual(state.calls, [
        ['shot'],
        ['move', 10, 20],
        ['click', 5, 6, 2],
        ['drag', { x: 1, y: 2 }, { x: 3, y: 4 }],
        ['scroll', 0, -5],
        ['type', 'hello'],
    ]);
    await c.shutdown();
});

test('screen: a click with no coordinates uses the last pointer position', async () => {
    const state = newState();
    const c = screen({ engine: fakeEngine(state) }); const t = target(); const ctx = ctxOf();
    await c.run('screen.move', t, { x: 42, y: 7 }, ctx);
    await c.run('screen.click', t, {}, ctx);
    assert.deepEqual(state.calls.at(-1), ['click', 42, 7, 0]);
    await c.shutdown();
});

test('screen: a single key maps to its VK, an unknown key is refused', async () => {
    const state = newState();
    const c = screen({ engine: fakeEngine(state) }); const t = target(); const ctx = ctxOf();
    await c.run('screen.key', t, { key: 'Enter' }, ctx);
    assert.deepEqual(state.calls.at(-1), ['key', VK.enter]);
    await c.run('screen.key', t, { key: 'a' }, ctx);
    assert.deepEqual(state.calls.at(-1), ['key', 0x41]);
    await assert.rejects(c.run('screen.key', t, { key: 'wingding' }, ctx), /unknown key/);
    assert.equal(vkOf('ArrowLeft'), VK.left);
    await c.shutdown();
});

test('screen: a chord holds the modifier down, strikes the key, releases it — in order', async () => {
    const state = newState();
    const c = screen({ engine: fakeEngine(state) }); const t = target(); const ctx = ctxOf();
    await c.run('screen.key', t, { key: 'ctrl+c' }, ctx);
    assert.deepEqual(state.calls, [
        ['keyDown', VK.ctrl],
        ['key', 0x43], // 'c'
        ['keyUp', VK.ctrl],
    ]);
    await c.shutdown();
});

test('screen: the per-session rate limit makes a run of actions wait', async () => {
    const state = newState();
    let clock = 0;
    const paused = [];
    const c = screen({ engine: fakeEngine(state), now: () => clock, pause: (ms) => { paused.push(ms); clock += ms; return Promise.resolve(); } });
    const t = target(); const ctx = ctxOf();
    /* RATE_MAX actions at the same instant go straight through; the next must wait. */
    for (let i = 0; i < RATE_MAX; i++) await c.run('screen.move', t, { x: i, y: 0 }, ctx);
    assert.equal(paused.length, 0, 'the first batch is not throttled');
    await c.run('screen.move', t, { x: 99, y: 0 }, ctx);
    assert.equal(paused.length, 1, 'the one over the limit waited');
    assert.ok(paused[0] > 0 && paused[0] <= 1000);
    await c.shutdown();
});

test('screen: with no engine, the connector says it is off', async () => {
    const c = screen({});
    await assert.rejects(c.run('screen.shot', target(), {}, ctxOf()), /no screen engine/);
    await c.shutdown();
});

/* ---- through the keeper: rights, the token, and a Refused from the engine ---- */
const keeperWith = (level, state, opts = {}) => {
    const k = keeper(tmp(), {
        connectors: { screen: screen({ engine: fakeEngine(state) }) },
        secrets: async (name) => (name === 'kiosk-token' ? TOKEN : ''),
        ask: opts.ask ?? (() => undefined),
    });
    k.store.putTarget({ id: 'kiosk', title: 'Kiosk', kind: 'screen', connector: 'screen', config: { url: 'wss://screen.example.com/control' }, secrets: { token: 'kiosk-token' } });
    if (level) k.store.grant('kiosk', BOT.id, level);
    return k;
};

test('screen through the keeper: watch refuses an action, a shot still reads', async () => {
    const k = keeperWith('watch', newState());
    assert.match((await k.act('screen.click', { target: 'kiosk', x: 1, y: 1 }, BOT)).text, /level watch/);
    assert.equal((await k.act('screen.shot', { target: 'kiosk' }, BOT)).ok, true, 'a shot reads at watch');
    await k.close();
});

test('screen through the keeper: propose asks, and "Always" then allows that whole verb', async () => {
    const asked = [];
    const k = keeperWith('propose', newState(), { ask: (r) => { asked.push(r); return undefined; } });
    const p = k.act('screen.click', { target: 'kiosk', x: 2, y: 2, why: 'Press the button.' }, BOT);
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1, 'a person is asked');
    assert.equal(k.approvals().length, 1);
    k.decide(k.approvals()[0].id, 'always', ME);
    assert.equal((await p).ok, true);
    /* "Always" on an action moved the target to frame and allowed the verb; a
       second click of the same verb now goes straight through, unasked. */
    const before = asked.length;
    assert.equal((await k.act('screen.click', { target: 'kiosk', x: 9, y: 9 }, BOT)).ok, true);
    assert.equal(asked.length, before, 'the verb is allowed now, so no new ask');
    await k.close();
});

test('screen through the keeper: the token is never in the result or the journal', async () => {
    const k = keeperWith('free', newState());
    const r = await k.act('screen.shot', { target: 'kiosk' }, BOT);
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.text, /SECRET/, 'no token in the answer');
    const raw = readFileSync(join(k.store.dir, 'journal.jsonl'), 'utf8') + readFileSync(join(k.store.dir, 'state.json'), 'utf8');
    assert.doesNotMatch(raw, /screen-login-token/, 'neither journal nor store holds the token');
    assert.match(raw, /kiosk-token/, 'the store holds only the secret\'s name');
    await k.close();
});

test('screen through the keeper: a Refused from the engine passes through', async () => {
    const { Refused } = await import('../server/verbs.mjs');
    const state = newState({ connectThrows: new Refused('the operator shut this screen') });
    const k = keeperWith('free', state);
    const r = await k.act('screen.move', { target: 'kiosk', x: 1, y: 1 }, BOT);
    assert.equal(r.ok, false);
    assert.match(r.text, /the operator shut this screen/);
    await k.close();
});
