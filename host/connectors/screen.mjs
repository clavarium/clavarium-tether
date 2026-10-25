/* THE SCREEN CONNECTOR: an envelope around an operator-provided screen engine.
 *
 * Tether settles the screen.* verbs and their rights; it writes no capture or
 * injection code. A host plugs an engine in, and THIS file is the thin, safe
 * wrapper the keeper talks to: it holds one session per (target + agent), reads
 * the target's URL and secret, maps the verbs to engine calls, keeps a token
 * out of every answer, clamps the numbers, and rate-limits the actions.
 *
 *   target.config.url     the engine's endpoint (NEVER taken from the agent's args)
 *   target.config.user    optional: a user name the engine logs in as
 *   target.config.node    optional: which machine, when the engine fronts several
 *   target.secrets.token  the NAME of the login token in the host's secret store
 *   target.secrets.key    optional: the NAME of a login key, for engines that use one
 *
 * THE ENGINE IS INJECTED, never imported here. `engine` is a factory shaped like
 * the reference one: calling it returns a session with
 *   connect({ url, token, user?, key?, node?, signal? })
 *   shot() -> { dataUrl, width, height }
 *   move(x, y), click(x, y, button?), drag(from, to), scroll(dx, dy)
 *   type(text), key(vk, code?), keyDown(vk), keyUp(vk), close()
 * A host wires it in with `connectors: { screen: screen({ engine: createScreen }) }`.
 * With no engine, every call says the connector has no engine, like one that is off.
 *
 * THE TOKEN NEVER TOUCHES THIS CODE'S OUTPUT. It is fetched at connect time
 * through `ctx.secret('token')`, handed straight to the engine, and kept in the
 * session. It is never returned, never journalled, never in an error (the keeper
 * also masks any secret it handed out, as a second lock). A `Refused` the engine
 * throws is passed through to the agent as is.
 */
import { no } from '../../server/verbs.mjs';

/* At most this many actions a second, per session: a run-away agent cannot
   flood the far machine with clicks and keys. */
export const RATE_MAX = 30;
export const RATE_WINDOW_MS = 1000;

/* THE KEY MAP: a key name or chord ("Enter", "ctrl+c") to Windows virtual-key
   codes, the codes the reference engine wants. Modest on purpose; an unknown
   key is refused rather than guessed. A single letter or digit maps to its own
   code. A chord holds its modifiers down around the main key. */
export const VK = Object.freeze({
    enter: 0x0D, return: 0x0D, ret: 0x0D,
    escape: 0x1B, esc: 0x1B,
    tab: 0x09,
    backspace: 0x08, bksp: 0x08,
    delete: 0x2E, del: 0x2E,
    space: 0x20, spacebar: 0x20,
    left: 0x25, arrowleft: 0x25,
    up: 0x26, arrowup: 0x26,
    right: 0x27, arrowright: 0x27,
    down: 0x28, arrowdown: 0x28,
    home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
    insert: 0x2D, ins: 0x2D,
    ctrl: 0x11, control: 0x11,
    alt: 0x12, option: 0x12,
    shift: 0x10,
    win: 0x5B, meta: 0x5B, cmd: 0x5B, super: 0x5B,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
    f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
});
/* The names that only hold while another key is struck. */
const MODIFIER = new Set(['ctrl', 'control', 'alt', 'option', 'shift', 'win', 'meta', 'cmd', 'super']);

/* One key name to its VK code; a lone letter or digit is itself; else refused. */
export function vkOf(name) {
    const raw = String(name ?? '').trim();
    if (!raw) no('no key given');
    const low = raw.toLowerCase();
    if (Object.hasOwn(VK, low)) return VK[low];
    if (/^[a-z]$/.test(low)) return low.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(low)) return low.charCodeAt(0);
    no(`unknown key "${raw}": a key is a name ("Enter") or a chord ("ctrl+c")`);
}

const finite = (v, what) => { const n = Number(v); if (!Number.isFinite(n)) no(`${what} must be a number`); return Math.trunc(n); };
/* A point, as the agent gives it: an object { x, y } or a string "12,40". */
function pointOf(v, what) {
    if (v && typeof v === 'object') return { x: finite(v.x, `${what} x`), y: finite(v.y, `${what} y`) };
    const parts = String(v ?? '').split(',');
    if (parts.length !== 2) no(`${what} is a point like "12,40"`);
    return { x: finite(parts[0], `${what} x`), y: finite(parts[1], `${what} y`) };
}
/* left / middle / right (or 0 / 1 / 2), as the reference engine numbers them. */
function buttonOf(b) {
    if (b === undefined || b === null || b === '') return 0;
    const map = { left: 0, middle: 1, right: 2, 0: 0, 1: 1, 2: 2 };
    const key = String(b).toLowerCase();
    if (Object.hasOwn(map, key)) return map[key];
    no(`unknown button "${b}": left, middle or right`);
}

export function screen({ engine = null, pause = (ms) => new Promise((r) => { setTimeout(r, ms); }), now = () => Date.now() } = {}) {
    /* `${target.id}\n${agent}` -> session state. One per target and agent. */
    const sessions = new Map();
    const keyOf = (target, agent) => `${target.id}\n${agent}`;

    /* The connected session for a target and agent, opened once and reused;
       reopened on demand if it dropped. */
    async function sessionFor(target, agent, ctx) {
        const key = keyOf(target, agent);
        const had = sessions.get(key);
        if (had && had.alive) { await had.ready; return had; }

        const url = target.config?.url;
        if (!url) no(`${target.title} has no screen url set`);
        const inst = engine();
        const controller = new AbortController();
        const state = { inst, controller, alive: true, pointer: { x: 0, y: 0 }, hits: [] };
        const forget = () => { state.alive = false; if (sessions.get(key) === state) sessions.delete(key); };

        const args = { url, signal: controller.signal };
        if (target.secrets?.token) args.token = await ctx.secret('token');
        if (target.secrets?.key) args.key = await ctx.secret('key');
        if (target.config?.user) args.user = target.config.user;
        if (target.config?.node) args.node = target.config.node;

        state.ready = Promise.resolve().then(() => inst.connect(args)).then(() => inst);
        state.ready.catch(forget); // a connect that never finished is not kept as if it had
        sessions.set(key, state);
        await state.ready;
        return state;
    }

    /* No more than RATE_MAX actions in any RATE_WINDOW_MS; over that, wait. */
    async function gate(state) {
        const t = now();
        state.hits = state.hits.filter((x) => t - x < RATE_WINDOW_MS);
        if (state.hits.length >= RATE_MAX) { await pause(RATE_WINDOW_MS - (t - state.hits[0])); return gate(state); }
        state.hits.push(now());
    }

    const done = () => ({ text: 'Done.', size: 0 });

    const verbs = {
        async 'screen.shot'(state) {
            const r = await state.inst.shot();
            const dataUrl = String(r?.dataUrl ?? '');
            return { text: dataUrl, size: Buffer.byteLength(dataUrl) };
        },
        async 'screen.move'(state, a) {
            const x = finite(a.x, 'x'); const y = finite(a.y, 'y');
            state.pointer = { x, y };
            await state.inst.move(x, y);
            return done();
        },
        async 'screen.click'(state, a) {
            const x = a.x !== undefined ? finite(a.x, 'x') : state.pointer.x;
            const y = a.y !== undefined ? finite(a.y, 'y') : state.pointer.y;
            state.pointer = { x, y };
            await state.inst.click(x, y, buttonOf(a.button));
            return done();
        },
        async 'screen.drag'(state, a) {
            const from = pointOf(a.from, 'from'); const to = pointOf(a.to, 'to');
            state.pointer = to;
            await state.inst.drag(from, to);
            return done();
        },
        async 'screen.scroll'(state, a) {
            const dx = a.dx !== undefined ? finite(a.dx, 'dx') : 0;
            const dy = a.dy !== undefined ? finite(a.dy, 'dy') : 0;
            await state.inst.scroll(dx, dy);
            return done();
        },
        async 'screen.type'(state, a) {
            await state.inst.type(String(a.text ?? ''));
            return done();
        },
        async 'screen.key'(state, a) {
            const parts = String(a.key ?? '').split('+').map((p) => p.trim()).filter(Boolean);
            if (!parts.length) no('no key given');
            if (parts.length === 1) { await state.inst.key(vkOf(parts[0])); return done(); }
            /* A chord: hold the modifiers down, strike the main key, release them. */
            const mods = parts.slice(0, -1).map(vkOf);
            const main = parts[parts.length - 1];
            if (MODIFIER.has(main.toLowerCase())) no(`"${a.key}": a chord ends on a key, not a modifier`);
            const mainVk = vkOf(main);
            for (const m of mods) await state.inst.keyDown(m);
            try { await state.inst.key(mainVk); }
            finally { for (const m of [...mods].reverse()) await state.inst.keyUp(m); }
            return done();
        },
    };

    return {
        name: 'screen',
        verbs: Object.keys(verbs),
        async run(verb, target, a, ctx) {
            if (!engine) no(`${target.title} has no screen engine: its connector is off`);
            const op = verbs[verb];
            if (!op) no(`${verb} is not done by this connector`);
            const state = await sessionFor(target, ctx.agent, ctx);
            await gate(state);
            return op(state, a);
        },
        /* An agent's session(s) closed ("*": everybody's). */
        async close(agent = '*') {
            for (const [key, state] of sessions) {
                const who = key.slice(key.indexOf('\n') + 1);
                if (agent === '*' || who === agent) {
                    try { state.controller.abort(); } catch { /* already */ }
                    try { await state.inst.close?.(); } catch { /* down anyway */ }
                    sessions.delete(key);
                }
            }
        },
        async shutdown() { await this.close('*'); },
    };
}
