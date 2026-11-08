/* REAL INPUT ON CHROME, through the DevTools protocol (0.1.0-next.60).
 *
 * Synthetic DOM events (dispatchEvent) are isTrusted=false, and many apps
 * ignore them (Colab, Docs...). Where `chrome.debugger` exists, the acting
 * verbs go through CDP instead: Input.dispatchMouseEvent, Input.insertText,
 * Input.dispatchKeyEvent; eval through Runtime.evaluate, which the page's CSP
 * does not govern. Firefox has no debugger API: it keeps the synthetic path.
 *
 * THE ATTACHMENT. A tab is attached on the first command and stays attached
 * while the agent acts; after IDLE_MS with no command it is detached, so
 * Chrome's "is debugging this browser" banner does not stay up. A person who
 * closes the banner detaches it: the next command attaches again.
 *
 * LIKE A PERSON'S HAND. The pointer moves to its target along a short curve
 * (a few mouseMoved steps, a little jitter), a press is held 50-120 ms, and
 * text is typed key by key, 30-120 ms apart. `delay` (ms) fixes those pauses;
 * `fast: true` types the whole text at once (Input.insertText). Defaults stay
 * quick: a click is well under a second.
 *
 * Pure: the debugger API, the clock and the randomness are injected, so the
 * tests run it with nothing built.
 */
export const IDLE_MS = 30_000;
export const PROTOCOL = '1.3';
/* Text longer than this many keystrokes' time is typed at once, so a call stays well inside its timeout. */
export const TYPE_BUDGET_MS = 12_000;

/* CDP modifier bits. */
const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const MOD_KEYS = { alt: ['Alt', 'AltLeft', 18], ctrl: ['Control', 'ControlLeft', 17], control: ['Control', 'ControlLeft', 17], meta: ['Meta', 'MetaLeft', 91], cmd: ['Meta', 'MetaLeft', 91], command: ['Meta', 'MetaLeft', 91], shift: ['Shift', 'ShiftLeft', 16] };
const NAMED = {
    enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9, ''], escape: ['Escape', 'Escape', 27, ''], esc: ['Escape', 'Escape', 27, ''],
    backspace: ['Backspace', 'Backspace', 8, ''], delete: ['Delete', 'Delete', 46, ''], del: ['Delete', 'Delete', 46, ''], insert: ['Insert', 'Insert', 45, ''],
    space: [' ', 'Space', 32, ' '], ' ': [' ', 'Space', 32, ' '],
    arrowup: ['ArrowUp', 'ArrowUp', 38, ''], up: ['ArrowUp', 'ArrowUp', 38, ''], arrowdown: ['ArrowDown', 'ArrowDown', 40, ''], down: ['ArrowDown', 'ArrowDown', 40, ''],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37, ''], left: ['ArrowLeft', 'ArrowLeft', 37, ''], arrowright: ['ArrowRight', 'ArrowRight', 39, ''], right: ['ArrowRight', 'ArrowRight', 39, ''],
    home: ['Home', 'Home', 36, ''], end: ['End', 'End', 35, ''], pageup: ['PageUp', 'PageUp', 33, ''], pagedown: ['PageDown', 'PageDown', 34, ''],
};

/* One key (a name, a letter, a digit, F1-F24, or any character) as CDP describes it. */
export function keyOf(name) {
    const s = String(name ?? '');
    const low = s.toLowerCase();
    if (NAMED[low]) { const [key, code, keyCode, text] = NAMED[low]; return { key, code, keyCode, text }; }
    const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(low);
    if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]), text: '' };
    if (/^[a-z]$/i.test(s)) return { key: s, code: `Key${s.toUpperCase()}`, keyCode: s.toUpperCase().charCodeAt(0), text: s };
    if (/^[0-9]$/.test(s)) return { key: s, code: `Digit${s}`, keyCode: s.charCodeAt(0), text: s };
    if (s === '\n' || s === '\r') return keyOf('enter');
    return { key: s, code: '', keyCode: 0, text: s };
}

/* "ctrl+shift+F9" -> { mods:[...], bits, main }. A lone "+" is the plus key. */
export function chordOf(chord) {
    const s = String(chord ?? '');
    const parts = s === '+' ? ['+'] : s.split('+').filter((p, i, all) => p !== '' || i === all.length - 1);
    const main = parts.pop() ?? '';
    const mods = parts.map((p) => p.toLowerCase()).filter((p) => MOD[p] !== undefined);
    return { mods, bits: mods.reduce((b, m) => b | MOD[m], 0), main: main === '' ? '+' : main };
}

/** @param {{ dbg?: any, setTimer?: Function, clearTimer?: Function, sleep?: (ms: number) => Promise<unknown>, random?: () => number, idleMs?: number }} [o] */
export function createDriver({ dbg, setTimer = setTimeout, clearTimer = clearTimeout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, idleMs = IDLE_MS } = {}) {
    const available = !!(dbg && typeof dbg.attach === 'function' && typeof dbg.sendCommand === 'function');
    const attached = new Map();       // tabId -> idle timer
    const pointer = new Map();        // tabId -> last {x, y} the pointer was moved to
    const between = (lo, hi) => lo + random() * (hi - lo);
    const pause = (ms) => (ms > 0 ? sleep(Math.round(ms)) : Promise.resolve());
    /* `delay` given: that pause; else a random one in [lo, hi]. */
    const wait = (delay, lo, hi) => pause(Number.isFinite(delay) ? delay : between(lo, hi));

    if (available && dbg.onDetach?.addListener) {
        dbg.onDetach.addListener((source) => { const id = Number(source?.tabId); const t = attached.get(id); if (t !== undefined) clearTimer(t); attached.delete(id); });
    }

    function arm(tabId) {
        const old = attached.get(tabId);
        if (old !== undefined) clearTimer(old);
        attached.set(tabId, setTimer(() => { detach(tabId).catch(() => {}); }, idleMs));
    }
    async function attach(tabId) {
        if (attached.has(tabId)) return;
        try { await dbg.attach({ tabId }, PROTOCOL); }
        catch (e) { if (!/already attached/i.test(String(e?.message ?? e))) throw e; }
        attached.set(tabId, undefined);
    }
    async function detach(tabId) {
        const id = Number(tabId);
        const t = attached.get(id); if (t !== undefined) clearTimer(t);
        if (!attached.delete(id)) return;
        pointer.delete(id);
        try { await dbg.detach({ tabId: id }); } catch { /* already gone */ }
    }
    /* One CDP command on a tab: attached first if need be, and kept so for IDLE_MS more. */
    async function send(tabId, method, params = {}) {
        if (!available) throw new Error('no debugger here');
        const id = Number(tabId);
        await attach(id);
        arm(id);
        return dbg.sendCommand({ tabId: id }, method, params);
    }

    const mouse = (tabId, type, x, y, extra = {}) => send(tabId, 'Input.dispatchMouseEvent', { type, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, ...extra });

    /* The pointer goes from where it was (or a little off the target) to (x,y): a slight curve, a little jitter, 4-7 steps. */
    async function moveTo(tabId, x, y, { delay, buttons = 0, button = 'none', steps } = {}) {
        const id = Number(tabId);
        const from = pointer.get(id) ?? { x: x - between(40, 120) * (random() < 0.5 ? -1 : 1), y: y - between(20, 80) * (random() < 0.5 ? -1 : 1) };
        const n = steps ?? Math.round(between(4, 7));
        const dx = x - from.x; const dy = y - from.y;
        const bend = between(-0.15, 0.15);                       // the control point, off the straight line
        const cx = from.x + dx / 2 - dy * bend; const cy = from.y + dy / 2 + dx * bend;
        for (let i = 1; i <= n; i++) {
            const t = i / n; const u = 1 - t;
            const last = i === n;
            const px = last ? x : u * u * from.x + 2 * u * t * cx + t * t * x + between(-1.5, 1.5);
            const py = last ? y : u * u * from.y + 2 * u * t * cy + t * t * y + between(-1.5, 1.5);
            await mouse(id, 'mouseMoved', px, py, { button, buttons });
            if (!last) await wait(Number.isFinite(delay) ? delay / n : undefined, 8, 22);
        }
        pointer.set(id, { x, y });
    }

    const BUTTON = { left: [1, 'left'], right: [2, 'right'], middle: [4, 'middle'] };
    async function click(tabId, x, y, { button = 'left', delay, count = 1 } = {}) {
        const [bits, name] = BUTTON[button] ?? BUTTON.left;
        await moveTo(tabId, x, y, { delay });
        for (let c = 1; c <= count; c++) {
            await mouse(tabId, 'mousePressed', x, y, { button: name, buttons: bits, clickCount: c });
            await wait(delay, 50, 120);
            await mouse(tabId, 'mouseReleased', x, y, { button: name, buttons: 0, clickCount: c });
            if (c < count) await wait(delay, 40, 90);
        }
    }

    async function drag(tabId, a, b, { delay } = {}) {
        await moveTo(tabId, a.x, a.y, { delay });
        await mouse(tabId, 'mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
        await wait(delay, 60, 140);
        await moveTo(tabId, b.x, b.y, { delay, buttons: 1, button: 'left', steps: Math.round(between(8, 12)) });
        await wait(delay, 40, 100);
        await mouse(tabId, 'mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    }

    async function scroll(tabId, x, y, dx, dy, { delay } = {}) {
        await moveTo(tabId, x, y, { delay, steps: 2 });
        await mouse(tabId, 'mouseWheel', x, y, { deltaX: dx, deltaY: dy });
    }

    const keyEvent = (tabId, type, k, modifiers, withText) => send(tabId, 'Input.dispatchKeyEvent', {
        type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers,
        ...(withText && k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });

    /* A key or chord: the modifiers down, the key down and up, the modifiers up. A chord with ctrl/alt/meta sends no text (it is a command). */
    async function key(tabId, chord, { delay } = {}) {
        const { mods, bits, main } = chordOf(chord);
        const k = keyOf(main);
        const command = (bits & (MOD.alt | MOD.ctrl | MOD.meta)) !== 0;
        let held = 0;
        for (const m of mods) { const [mk, mc, kc] = MOD_KEYS[m]; held |= MOD[m]; await keyEvent(tabId, 'rawKeyDown', { key: mk, code: mc, keyCode: kc }, held, false); }
        await keyEvent(tabId, !command && k.text ? 'keyDown' : 'rawKeyDown', k, bits, !command);
        await wait(delay, 30, 80);
        await keyEvent(tabId, 'keyUp', k, bits, false);
        for (const m of [...mods].reverse()) { const [mk, mc, kc] = MOD_KEYS[m]; held &= ~MOD[m]; await keyEvent(tabId, 'keyUp', { key: mk, code: mc, keyCode: kc }, held, false); }
    }

    /* Text: key by key, 30-120 ms apart (or `delay`); at once with fast, or when key by key would take too long. Returns how it was typed. */
    async function type(tabId, text, { fast = false, delay } = {}) {
        const chars = [...String(text ?? '')];
        const per = Number.isFinite(delay) ? delay : 75;
        if (fast || chars.length * per > TYPE_BUDGET_MS) { await send(tabId, 'Input.insertText', { text: String(text ?? '') }); return fast ? 'fast' : 'long'; }
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            const k = keyOf(ch);
            /* A character no key makes (an emoji, a CJK sign) is inserted as text. */
            if (ch.length > 1 || (k.keyCode === 0 && /[^\x20-\x7e -ɏ]/.test(ch))) await send(tabId, 'Input.insertText', { text: ch });
            else { await keyEvent(tabId, 'keyDown', k, 0, true); await wait(Number.isFinite(delay) ? Math.min(delay, 30) : undefined, 8, 25); await keyEvent(tabId, 'keyUp', k, 0, false); }
            if (i < chars.length - 1) await wait(delay, 30, 120);
        }
        return 'keys';
    }

    /* A script in the page's main world, out of reach of its CSP. Its value, as text; an exception as "error: ...". */
    async function evaluate(tabId, expression) {
        const r = await send(tabId, 'Runtime.evaluate', { expression: String(expression), returnByValue: true, awaitPromise: true, userGesture: true, replMode: true });
        if (r?.exceptionDetails) {
            const d = r.exceptionDetails;
            return `error: ${d.exception?.description?.split('\n')[0] ?? d.text ?? 'the script threw'}`;
        }
        const v = r?.result;
        if (!v || v.type === 'undefined') return 'undefined';
        if ('value' in v) return typeof v.value === 'string' ? v.value : (JSON.stringify(v.value) ?? String(v.value));
        return v.description ?? String(v.type);
    }

    return {
        available, send, attach, detach,
        detachAll: async () => { for (const id of [...attached.keys()]) await detach(id); },
        isAttached: (tabId) => attached.has(Number(tabId)),
        forget: (tabId) => { const id = Number(tabId); const t = attached.get(id); if (t !== undefined) clearTimer(t); attached.delete(id); pointer.delete(id); },
        moveTo, click, drag, scroll, key, type, evaluate,
    };
}
