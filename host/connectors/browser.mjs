/* THE BROWSER CONNECTOR: tabs a person grants to an agent through the Tether
 * WebExtension (Chrome and Firefox, one codebase). Unlike `local` and `ssh`,
 * the keeper does not reach out: the extension connects OUT to the keeper over
 * a WebSocket and this connector answers on the socket the extension opened.
 * So nothing is installed, no port is opened for the browser to find, and the
 * browser can sit behind any firewall.
 *
 * THE SOCKET IS GIVEN TO THIS CONNECTOR AS A CHANNEL, not as a raw WebSocket:
 *
 *   channel.send(obj)         send one JSON message to the extension
 *   channel.onMessage(fn)     a JSON message arrived from the extension
 *   channel.onClose(fn)       the socket dropped
 *   channel.close()           drop it
 *
 * The keeper's `serve` wraps a real WebSocket as a channel (host/serve.mjs);
 * the tests pass a fake channel. The connector never speaks the wire format.
 *
 * PAIRING. An extension with no token connects and sends { t:"pair", code }
 * showing a short code in its popup. A person reads that code and types it in
 * the keeper page; the keeper calls `pair(code)`, which mints a long-lived
 * token, hands it to the extension ({ t:"paired", token }) and remembers it.
 * On every later connection the extension sends { t:"hello", token } and is
 * trusted at once. The token is never journalled and never returned to an
 * agent; it is held only here (in the `tokens` store the host gives) and in
 * the extension's own storage.
 *
 * TAB SCOPING. The extension pushes { t:"tabs", tabs:[{id,url,title,site}] }:
 * the tabs the person granted, and only those. A verb that names a tab the
 * person did not grant is refused HERE, before anything is sent — the same
 * refusal the extension enforces on its side, as a second lock. `browser.open`
 * with no tab opens a new tab (the extension grants what it opened).
 *
 * The rights (watch / propose / frame / free) and a person's approval are
 * applied by the keeper BEFORE it calls this connector, exactly as for ssh and
 * local; this connector only carries an already-allowed call to the extension.
 */
import { randomBytes } from 'node:crypto';
import { no, Refused } from '../../server/verbs.mjs';

export const CALL_TIMEOUT_MS = 30_000;
const TABS_MAX = 200;

/* A token store the host may replace (serve backs it with a file). In memory
 * by default: tokens live as long as the keeper does. */
export function memTokens() {
    const set = new Set();
    return {
        has: (t) => set.has(t),
        add: (t) => { set.add(t); },
        remove: (t) => set.delete(t),
        list: () => [...set],
    };
}
const mintToken = () => randomBytes(32).toString('base64url');

export function browser({ tokens = memTokens(), newToken = mintToken, timeout = CALL_TIMEOUT_MS, now = () => Date.now() } = {}) {
    let live = null;                 // the one authenticated connection, or null
    const unpaired = new Map();      // code -> connection waiting to be paired
    const pending = new Map();       // callId -> { resolve, agent, timer }
    const listeners = new Set();     // notified when the connection or its tabs change
    let seq = 0;
    const announce = () => { for (const fn of listeners) { try { fn(status()); } catch { /* a listener's fault */ } } };

    /* Reject pending calls matching a test (by connection, by agent, or all). */
    function rejectWhere(test, why) {
        for (const [id, p] of pending) if (test(p)) { clearTimeout(p.timer); pending.delete(id); p.reject(new Refused(why)); }
    }

    function accept(channel) {
        const conn = { channel, authed: false, code: null, tabs: new Map() };
        channel.onMessage((msg) => { try { onMessage(conn, msg); } catch { /* a bad message is ignored */ } });
        channel.onClose(() => {
            if (conn.code) unpaired.delete(conn.code);
            if (live === conn) { live = null; announce(); }
            rejectWhere((p) => p.conn === conn, 'the browser disconnected before it answered');
        });
        return conn;
    }

    function onMessage(conn, msg) {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.t) {
            case 'hello':
                if (msg.token && tokens.has(msg.token)) { makeLive(conn); conn.channel.send({ t: 'welcome' }); }
                else conn.channel.send({ t: 'pair-needed' });
                break;
            case 'pair':
                if (typeof msg.code === 'string' && msg.code) { conn.code = msg.code; unpaired.set(msg.code, conn); }
                break;
            case 'tabs':
                conn.tabs = new Map();
                for (const t of Array.isArray(msg.tabs) ? msg.tabs.slice(0, TABS_MAX) : []) if (t && t.id !== undefined) conn.tabs.set(String(t.id), { id: t.id, url: t.url ?? '', title: t.title ?? '', site: t.site ?? '' });
                if (conn === live) announce();
                break;
            case 'result': {
                const p = pending.get(String(msg.id));
                if (p) { clearTimeout(p.timer); pending.delete(String(msg.id)); p.resolve(msg); }
                break;
            }
            case 'ping': conn.channel.send({ t: 'pong' }); break;
            case 'pong': break;
            default: break;
        }
    }

    function makeLive(conn) {
        conn.authed = true;
        if (conn.code) { unpaired.delete(conn.code); conn.code = null; }
        if (live && live !== conn) { try { live.channel.close(); } catch { /* gone */ } }
        live = conn;
        announce();
    }

    /* A person typed the code shown in the extension: mint a token, hand it over. */
    function pair(code) {
        const conn = unpaired.get(String(code ?? '').trim());
        if (!conn) no('no browser is waiting with that code');
        const token = newToken();
        tokens.add(token);
        makeLive(conn);
        conn.channel.send({ t: 'paired', token });
        return { paired: true };
    }

    function status() {
        return {
            connected: !!live,
            tabs: live ? [...live.tabs.values()] : [],
            waiting: [...unpaired.keys()].length > 0,
        };
    }

    function send(verb, a, agent) {
        const id = String(++seq);
        const short = verb.slice('browser.'.length);
        const args = {}; for (const [k, v] of Object.entries(a)) if (k !== 'target' && k !== 'why') args[k] = v;
        return new Promise((resolve, reject2) => {
            const timer = setTimeout(() => { pending.delete(id); reject2(new Refused('the browser did not answer in time')); }, timeout);
            pending.set(id, { resolve, reject: reject2, agent, conn: live, timer });
            try { live.channel.send({ t: 'call', id, verb: short, args }); }
            catch (e) { clearTimeout(timer); pending.delete(id); reject2(new Refused(`the browser could not be reached: ${e?.message ?? e}`)); }
        });
    }

    async function run(verb, target, a, ctx) {
        if (!live || !live.authed) no(`${target.title} is not connected: pair the browser extension in the keeper page`);
        /* The granted tabs are known here (the extension pushes them): list them
           without a round trip. */
        if (verb === 'browser.tabs') {
            const list = [...live.tabs.values()];
            const text = list.length ? list.map((t) => `${t.id}  ${t.title || '(no title)'}  ${t.url || ''}`.trim()).join('\n') : 'No tab granted to the agent.';
            return { text, size: Buffer.byteLength(text) };
        }
        /* Tab scoping: a named tab must be one the person granted. `open` with no
           tab opens a new one, which the extension grants as it opens it. */
        if (a.tab !== undefined && !live.tabs.has(String(a.tab))) no('that tab was not granted to the agent (grant it in the extension)');
        const res = await send(verb, a, ctx.agent);
        if (!res || res.ok === false) no(res?.error || res?.text || 'the browser refused');
        const text = typeof res.text === 'string' ? res.text : '';
        return { text, size: res.size ?? Buffer.byteLength(text) };
    }

    return {
        name: 'browser',
        verbs: ['browser.tabs', 'browser.open', 'browser.shot', 'browser.html', 'browser.console', 'browser.eval', 'browser.click', 'browser.type', 'browser.key', 'browser.scroll', 'browser.drag'],
        run,
        accept,
        pair,
        status,
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        /* A stop for an agent: drop its calls in flight. The socket stays — the
           person may act with another agent — and the keeper refuses that agent
           anyway until a person resumes. */
        close(agent = '*') { rejectWhere((p) => agent === '*' || p.agent === agent, 'a person stopped everything for you: nothing was done'); },
        shutdown() {
            for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Refused('the keeper is shutting down')); }
            pending.clear();
            if (live) { try { live.channel.close(); } catch { /* gone */ } live = null; }
            for (const c of unpaired.values()) { try { c.channel.close(); } catch { /* gone */ } }
            unpaired.clear();
        },
    };
}
