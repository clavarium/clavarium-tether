/* REAL INPUT ON CHROME (0.1.0-next.60): the CDP driver (extension/lib/cdp.js)
 * against a mocked chrome.debugger and a fake clock, and the hand that chooses
 * (extension/lib/act.js): CDP where the debugger is, synthetic events on
 * Firefox. Plus browser.upload through the keeper's checks, and a tab granted
 * by its site that navigates elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriver, keyOf, chordOf, IDLE_MS } from '../extension/lib/cdp.js';
import { makeActs } from '../extension/lib/act.js';
import { dispatch } from '../extension/lib/protocol.js';
import { grants } from '../extension/lib/scope.js';
import { check, detail } from '../server/verbs.mjs';
import { ruleFrom, covers } from '../server/rights.mjs';

/* A mocked chrome.debugger: it records attach / sendCommand / detach. */
function fakeDebugger({ evaluate } = {}) {
    const log = []; const detachFns = [];
    return {
        log,
        closeBanner(tabId) { for (const fn of detachFns) fn({ tabId }, 'canceled_by_user'); },
        attach: async (t, v) => { log.push(['attach', t.tabId, v]); },
        detach: async (t) => { log.push(['detach', t.tabId]); },
        sendCommand: async (t, method, params) => { log.push(['send', t.tabId, method, params]); return method === 'Runtime.evaluate' ? (evaluate ? evaluate(params) : { result: { type: 'number', value: 42 } }) : {}; },
        onDetach: { addListener: (fn) => detachFns.push(fn) },
    };
}
/* A fake clock: timers fire only when told; sleeps are recorded, not waited. */
function fakeClock() {
    let next = 1; const timers = new Map(); const slept = [];
    return {
        slept,
        setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
        clearTimer: (id) => { timers.delete(id); },
        sleep: async (ms) => { slept.push(ms); },
        fire: () => { const all = [...timers.values()]; timers.clear(); for (const t of all) t.fn(); return all.map((t) => t.ms); },
        pending: () => timers.size,
    };
}
const driverWith = (dbg, clock, random = () => 0.5) => createDriver({ dbg, setTimer: clock.setTimer, clearTimer: clock.clearTimer, sleep: clock.sleep, random });
const sends = (dbg, method) => dbg.log.filter((l) => l[0] === 'send' && (!method || l[2] === method));
const flush = () => new Promise((r) => setImmediate(r));

test('cdp: attached once on the first command, kept while acting, detached after the idle time', async () => {
    const dbg = fakeDebugger(); const clock = fakeClock(); const d = driverWith(dbg, clock);
    assert.equal(d.available, true);
    await d.click(7, 100, 200);
    await d.key(7, 'Enter');
    assert.deepEqual(dbg.log.filter((l) => l[0] === 'attach'), [['attach', 7, '1.3']], 'one attach, protocol 1.3');
    assert.equal(d.isAttached(7), true);
    assert.equal(clock.pending(), 1, 'one idle timer, re-armed by each command');
    assert.deepEqual(clock.fire(), [IDLE_MS]);
    await flush();
    assert.deepEqual(dbg.log.at(-1), ['detach', 7], 'detached after the idle time: the banner goes');
    assert.equal(d.isAttached(7), false);
    await d.key(7, 'a');
    assert.equal(dbg.log.filter((l) => l[0] === 'attach').length, 2, 'the next act attaches again');
});

test('cdp: two Clavarium acting at once on two tabs attach each tab once, and do not wait on each other', async () => {
    const dbg = fakeDebugger(); const clock = fakeClock(); const d = driverWith(dbg, clock);
    let release; const gate = new Promise((r) => { release = r; });
    const attach = dbg.attach; dbg.attach = async (t, v) => { await attach(t, v); if (t.tabId === 7) await gate; };
    const a1 = d.key(7, 'a'); const a2 = d.key(7, 'b');           // one Clavarium, twice on its tab 7, the attach slow
    await d.key(9, 'c');                                           // the other, on its tab 9: not held up by tab 7
    assert.equal(d.isAttached(9), true);
    release(); await Promise.all([a1, a2]);
    assert.deepEqual(dbg.log.filter((l) => l[0] === 'attach').map((l) => l[1]).sort(), [7, 9], 'tab 7 attached once, tab 9 once');
    assert.ok(sends(dbg, 'Input.dispatchKeyEvent').some((l) => l[1] === 9) && sends(dbg, 'Input.dispatchKeyEvent').some((l) => l[1] === 7));
});

test('cdp: a person closing the banner detaches it; the next command attaches again', async () => {
    const dbg = fakeDebugger(); const clock = fakeClock(); const d = driverWith(dbg, clock);
    await d.key(3, 'Tab');
    dbg.closeBanner(3);
    assert.equal(d.isAttached(3), false);
    await d.key(3, 'Tab');
    assert.equal(dbg.log.filter((l) => l[0] === 'attach').length, 2);
});

test('cdp: a click moves the pointer on a short path, then presses and releases where asked', async () => {
    const dbg = fakeDebugger(); const clock = fakeClock(); const d = driverWith(dbg, clock);
    await d.click(7, 300, 150);
    const ev = sends(dbg, 'Input.dispatchMouseEvent').map((l) => l[3]);
    const moves = ev.filter((e) => e.type === 'mouseMoved');
    assert.ok(moves.length >= 4 && moves.length <= 7, `a few moves (${moves.length})`);
    assert.deepEqual([moves.at(-1).x, moves.at(-1).y], [300, 150], 'the last move is on the target');
    const tail = ev.slice(-2);
    assert.deepEqual(tail.map((e) => [e.type, e.x, e.y, e.button, e.clickCount]), [['mousePressed', 300, 150, 'left', 1], ['mouseReleased', 300, 150, 'left', 1]]);
    const hold = clock.slept.at(-1);
    assert.ok(hold >= 50 && hold <= 120, `a press held 50-120 ms (${hold})`);
    assert.ok(clock.slept.reduce((a, b) => a + b, 0) < 1000, 'a click stays under a second');
    /* The next click starts where the pointer is. */
    const before = clock.slept.length;
    await d.click(7, 310, 150, { delay: 0 });
    assert.equal(clock.slept.length, before, 'delay: 0 is as fast as it goes: no pause at all');
});

test('cdp: type goes key by key with pauses; fast inserts the text at once; a long text too', async () => {
    const dbg = fakeDebugger(); const clock = fakeClock(); const d = driverWith(dbg, clock);
    await d.type(1, 'Hi!');
    const keys = sends(dbg, 'Input.dispatchKeyEvent').map((l) => l[3]);
    assert.deepEqual(keys.filter((k) => k.type === 'keyDown').map((k) => k.text), ['H', 'i', '!']);
    assert.equal(keys.filter((k) => k.type === 'keyUp').length, 3);
    assert.equal(sends(dbg, 'Input.insertText').length, 0);
    const gaps = clock.slept.filter((ms) => ms >= 30);
    assert.ok(gaps.length === 2 && gaps.every((ms) => ms <= 120), 'two pauses of 30-120 ms between three keys');
    assert.equal(await d.type(1, 'all at once', { fast: true }), 'fast');
    assert.deepEqual(sends(dbg, 'Input.insertText').at(-1)[3], { text: 'all at once' });
    assert.equal(await d.type(1, 'x'.repeat(1000)), 'long', 'too long to type key by key: at once');
});

test('cdp: a chord presses its modifiers around the key, with no text (ctrl+F9 runs a Colab cell)', async () => {
    const dbg = fakeDebugger(); const clock = fakeClock(); const d = driverWith(dbg, clock);
    await d.key(1, 'ctrl+F9');
    const ev = sends(dbg, 'Input.dispatchKeyEvent').map((l) => [l[3].type, l[3].key, l[3].windowsVirtualKeyCode, l[3].modifiers, l[3].text]);
    assert.deepEqual(ev, [['rawKeyDown', 'Control', 17, 2, undefined], ['rawKeyDown', 'F9', 120, 2, undefined], ['keyUp', 'F9', 120, 2, undefined], ['keyUp', 'Control', 17, 0, undefined]]);
    assert.deepEqual(keyOf('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    assert.deepEqual(chordOf('ctrl+shift+a'), { mods: ['ctrl', 'shift'], bits: 10, main: 'a' });
    assert.equal(chordOf('ctrl++').main, '+');
});

test('cdp: eval through Runtime.evaluate, its value or its exception', async () => {
    const dbg = fakeDebugger({ evaluate: (p) => (p.expression === 'boom()' ? { exceptionDetails: { exception: { description: 'ReferenceError: boom is not defined\n    at <anonymous>' } } } : { result: { type: 'object', value: { a: 1 } } }) });
    const d = driverWith(dbg, fakeClock());
    assert.equal(await d.evaluate(1, 'x'), '{"a":1}');
    assert.equal(await d.evaluate(1, 'boom()'), 'error: ReferenceError: boom is not defined');
    assert.equal(sends(dbg, 'Runtime.evaluate')[0][3].returnByValue, true);
});

/* The page work, faked: points, focus, the synthetic hand, a script that a CSP may refuse. */
function fakePage({ csp = false } = {}) {
    const calls = [];
    const syn = (name) => async (tabId, a) => { calls.push(['synthetic', name, a]); return `${name} (synthetic)`; };
    return {
        calls,
        point: async (_t, where) => (where === '#gone' ? { error: 'no element #gone' } : /,/.test(where) ? { x: 1, y: 2 } : { x: 50, y: 60 }),
        centre: async () => ({ x: 400, y: 300 }),
        focus: async (_t, s) => s !== '#gone',
        synthetic: { click: syn('click'), type: syn('type'), key: syn('key'), scroll: syn('scroll'), drag: syn('drag') },
        evalScript: async (_t, code) => (csp ? "error: EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not allowed" : `ran ${code}`),
        setFiles: async (_t, sel, b64, name) => { calls.push(['setFiles', sel, b64, name]); return `uploaded ${name}`; },
    };
}

test('act on Chrome: a selector click is resolved to its centre and clicked through CDP; nothing synthetic', async () => {
    const dbg = fakeDebugger(); const page = fakePage();
    const acts = makeActs({ driver: driverWith(dbg, fakeClock()), page });
    assert.equal(acts.real, true);
    assert.equal(await acts.click(7, { selector: '.run' }), 'clicked at 50,60');
    assert.deepEqual(sends(dbg, 'Input.dispatchMouseEvent').at(-1)[3].type, 'mouseReleased');
    assert.equal(await acts.type(7, { text: 'ab', selector: '#f' }), 'typed');
    assert.equal(await acts.scroll(7, { dy: 300 }), 'scrolled 0,300');
    assert.deepEqual(sends(dbg, 'Input.dispatchMouseEvent').at(-1)[3], { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 300 });
    assert.equal(await acts.drag(7, { from: '#a', to: '10,20' }), 'dragged #a to 10,20');
    assert.match(await acts.eval(7, '1+1'), /42/);
    assert.equal(page.calls.filter((c) => c[0] === 'synthetic').length, 0);
    await assert.rejects(acts.click(7, { selector: '#gone' }), /no element #gone/);
});

test('act on Chrome: a tab the debugger cannot attach to falls back to synthetic events, and says so', async () => {
    const dbg = fakeDebugger(); dbg.attach = async () => { throw new Error('Cannot access a chrome:// URL'); };
    const page = fakePage();
    const acts = makeActs({ driver: driverWith(dbg, fakeClock()), page });
    assert.match(await acts.key(7, { key: 'Enter' }), /^key \(synthetic\) \(synthetic: the debugger could not act here: Cannot access/);
});

test('act on Firefox: no debugger, the synthetic path; eval under a strict CSP is refused plainly', async () => {
    const page = fakePage({ csp: true });
    const acts = makeActs({ driver: createDriver({ dbg: undefined }), page });
    assert.equal(acts.real, false);
    for (const [verb, a] of [['click', { x: 1, y: 2 }], ['type', { text: 'hi' }], ['key', { key: 'Enter' }], ['scroll', { dy: 1 }], ['drag', { from: '#a', to: '#b' }]]) {
        assert.equal(await acts[verb](7, a), `${verb} (synthetic)`);
    }
    await assert.rejects(acts.eval(7, '1'), /Content Security Policy forbids.*Firefox has no debugger.*nothing was run/);
    assert.equal(await makeActs({ driver: createDriver({}), page: fakePage() }).eval(7, '1'), 'ran 1');
});

test('act: upload sets the file through the page, capped at 25 MB', async () => {
    const page = fakePage();
    const acts = makeActs({ driver: createDriver({}), page });
    assert.equal(await acts.upload(7, { selector: 'input[type=file]', file: 'aGk=', name: 'hi.txt' }), 'uploaded hi.txt');
    assert.deepEqual(page.calls.at(-1), ['setFiles', 'input[type=file]', 'aGk=', 'hi.txt']);
    await assert.rejects(acts.upload(7, { selector: 'input', file: 'A'.repeat(34 * 1024 * 1024) }), /too large/);
    await assert.rejects(acts.upload(7, { file: 'aGk=' }), /selector/);
});

test('protocol: a tab granted by its site, sent to another site, says it is no longer granted; a tab granted by id stays', async () => {
    const world = new Map([['5', { url: 'https://colab.example.com/a' }], ['6', { url: 'https://docs.example.org/b' }]]);
    const actions = {
        tabInfo: async (id) => world.get(String(id)) ?? null,
        navigate: async (id, url) => { world.set(String(id), { url }); return { text: `went to ${url}` }; },
        upload: async (id, a) => ({ text: `uploaded ${a.name}` }),
    };
    const g = grants({ tabs: ['6'], sites: ['colab.example.com'] });
    const left = await dispatch({ id: '1', verb: 'open', args: { tab: '5', url: 'https://elsewhere.example.net/' } }, { grants: g, actions });
    assert.equal(left.ok, true);
    assert.match(left.text, /left the granted site.*grant it again.*or open a new tab/);
    const after = await dispatch({ id: '2', verb: 'upload', args: { tab: '5', selector: 'input', file: 'aGk=' } }, { grants: g, actions });
    assert.equal(after.ok, false, 'the next verb on it is refused');
    const stays = await dispatch({ id: '3', verb: 'open', args: { tab: '6', url: 'https://elsewhere.example.net/' } }, { grants: g, actions });
    assert.equal(stays.text, 'went to https://elsewhere.example.net/', 'granted by its id: no note');
    assert.equal((await dispatch({ id: '4', verb: 'upload', args: { tab: '6', selector: 'input', file: 'aGk=', name: 'a.csv' } }, { grants: g, actions })).text, 'uploaded a.csv');
});

test('verbs: browser.upload is checked (a selector, the file whole, 25 MB), its detail has no content; delay and fast are kept', () => {
    const a = check('browser.upload', { target: 'browser', tab: 5, selector: 'input[type=file]', image: 'aGVsbG8=', name: 'hello.txt' });
    assert.equal(a.file, 'aGVsbG8=', 'the bytes the keeper read from the agent\'s file');
    assert.equal(detail('browser.upload', a), 'input[type=file]: hello.txt (6 bytes)');
    assert.throws(() => check('browser.upload', { target: 'browser', file: 'aGk=' }), /needs selector/);
    assert.throws(() => check('browser.upload', { target: 'browser', selector: 'i', file: 'A'.repeat(34 * 1024 * 1024) }), /too large/);
    assert.equal(check('browser.click', { target: 'browser', x: 1, y: 2, delay: 9999 }).delay, 2000);
    assert.throws(() => check('browser.key', { target: 'browser', key: 'a', delay: 'soon' }), /milliseconds/);
    assert.equal(check('browser.type', { target: 'browser', text: 'x', fast: true }).fast, true);
    /* The same rights as every acting verb: a site rule covers it on that site's tab. */
    assert.deepEqual(ruleFrom('browser.upload', { tabSite: 'colab.example.com' }), { kind: 'site', value: 'colab.example.com' });
    assert.equal(covers({ kind: 'site', value: 'colab.example.com' }, 'browser.upload', { tabSite: 'colab.example.com' }), true);
});
