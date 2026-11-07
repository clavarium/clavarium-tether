/* THE MCP CONNECTOR: Tether as the CLIENT of an external MCP server (a CRM's, a forge's, one of
 * one's own), over Streamable HTTP, with an API key the agent never holds.
 *
 * A target of kind `mcp`:
 *   config   { url, header?, allowHttp?, perMinute?, perDay? }
 *            url: the server's MCP endpoint, https (plain http only when allowHttp is true: a
 *            local network the person chose); header: the header the key goes in, Authorization
 *            (as "Bearer KEY") by default, or a named one (X-API-Key: KEY)
 *   secrets  { token: NAME }   the key, by the NAME of a secret of the application's vault
 *
 * THE KEY NEVER LEAVES THIS PROCESS but in the header of a request to that one address: it is read
 * from the vault per request (ctx.secret: the keeper then masks it wherever it would appear), never
 * written to the store, the journal, an agent's folder or an error. The address is fixed: a redirect
 * is refused, never followed (it could send the key elsewhere).
 *
 * WHAT IT SPEAKS (the 2025 generation of the protocol): initialize (the session id the server gives
 * is sent back), notifications/initialized, tools/list with its pages, tools/call. An answer may be
 * JSON or a stream of events (text/event-stream); a notification in it is read. The server's own
 * stream (a GET on the same address) is listened to, for notifications/tools/list_changed: the keeper
 * is told (hooks.changed) and lists the tools again. A server that offers no such stream is listed
 * again each hour (tick), and whenever a person asks.
 *
 * LIMITS: each request has a time limit (a call 60 s, a list 30 s), an answer a size limit (2 MB),
 * each (server, agent) a rate (60 calls a minute, 1000 a day, unless the target says otherwise).
 * A call that went out and was not answered in time "may have been done": never said "not done".
 *
 * Server requests (elicitation, sampling) are not taken up in this first step: declined.
 */
import { Refused, no, oneLine } from '../../server/verbs.mjs';
import { VERSION, PACKAGE } from '../../server/name.mjs';

export const PROTOCOL = '2025-06-18';
export const CALL_MS = 60_000;
export const LIST_MS = 30_000;
export const BODY_MAX = 2 * 1024 * 1024;
export const PAGES_MAX = 20;
export const PER_MINUTE = 60;
export const PER_DAY = 1000;
/* Listed again past this age, when the server says nothing itself. */
export const TTL_MS = 60 * 60_000;
const RETRY_MS = [5_000, 15_000, 60_000];
const HEADER_OK = /^[A-Za-z0-9-]{1,60}$/;

class Late extends Error {}

/* The events of a text/event-stream, as they come: each { event, data }. */
async function* events(body, { max = BODY_MAX, signal } = {}) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = ''; let total = 0;
    try {
        for (;;) {
            if (signal?.aborted) return;
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > max) no(`the server sent more than ${Math.round(max / 1024 / 1024)} MB: the answer was not read`);
            buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
            let at;
            while ((at = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, at); buf = buf.slice(at + 2);
                const data = []; let event = 'message';
                for (const line of block.split('\n')) {
                    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
                    else if (line.startsWith('event:')) event = line.slice(6).trim();
                }
                if (data.length) yield { event, data: data.join('\n') };
            }
        }
    } finally { try { reader.releaseLock(); } catch { /* done */ } }
}
/* A whole body, up to `max` bytes. */
async function capped(res, max = BODY_MAX) {
    const len = Number(res.headers.get('content-length'));
    if (len > max) no(`the server's answer is ${Math.round(len / 1024)} KB; ${Math.round(max / 1024)} KB at most`);
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks = []; let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) { try { await reader.cancel(); } catch { /* gone */ } no(`the server sent more than ${Math.round(max / 1024 / 1024)} MB: the answer was not read`); }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function mcp({ fetch: f = globalThis.fetch, now = () => Date.now(), listen = true, callMs = CALL_MS, listMs = LIST_MS } = {}) {
    const sessions = new Map();     // target id -> { id, version, url }
    const listeners = new Map();    // target id -> { abort: AbortController, url }
    const counts = new Map();       // `${target}\n${agent}` -> [times]
    let hooks = null;               // { changed(id), targets(), ctx(t) } from the keeper
    let down = false;
    let seq = 0;

    function endpoint(t) {
        let u;
        try { u = new URL(String(t.config?.url ?? '')); } catch { no(`${t.title}: its address is not a URL`); }
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && t.config?.allowHttp === true)) no(`${t.title}: the address must be https (plain http only where allowed for a local network)`);
        if (u.username || u.password) no(`${t.title}: no user or password in the address: the key is a secret of the vault`);
        return u.href;
    }
    async function headers(t, ctx, session, extra = {}) {
        const h = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': session?.version ?? PROTOCOL, ...extra };
        if (t.secrets?.token) {
            const key = await ctx.secret('token');
            if (typeof key !== 'string' || !key) no(`${t.title}: its key is empty in the vault`);
            if (/[\r\n]/.test(key)) no(`${t.title}: its key holds a line break`);
            const name = String(t.config?.header || 'Authorization');
            if (!HEADER_OK.test(name)) no(`${t.title}: the header for its key is not a header name`);
            h[name.toLowerCase()] = name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
        }
        if (session?.id) h['mcp-session-id'] = session.id;
        return h;
    }
    const statusSaid = (t, status) => (status === 401 || status === 403 ? `${t.title} refused the key (HTTP ${status}): check the secret it names` : `${t.title} answered HTTP ${status}`);

    /* One JSON-RPC exchange: the result, or a Refused. `sent()` says the request left (a late answer may then mean it was done). */
    async function rpc(t, ctx, method, params, { ms = listMs, session = sessions.get(t.id), notification = false } = {}) {
        const url = endpoint(t);
        const id = notification ? undefined : `t${++seq}`;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(new Late('late')), ms); timer.unref?.();
        let res; let sent = false;
        try {
            const h = await headers(t, ctx, session, { 'content-type': 'application/json' });
            const body = JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params !== undefined ? { params } : {}) });
            try { res = await f(url, { method: 'POST', headers: h, body, redirect: 'manual', signal: abort.signal }); sent = true; }
            catch (e) {
                if (abort.signal.aborted) throw Object.assign(new Refused(`${t.title} did not answer within ${Math.round(ms / 1000)} s`), { late: true, sent: true });
                throw Object.assign(new Refused(`${t.title} cannot be reached (${oneLine(e?.cause?.code ?? e?.message ?? e, 80)})`), { sent: false });
            }
            if (res.status >= 300 && res.status < 400) no(`${t.title} answered with a redirect (HTTP ${res.status}): not followed -- its address is kept as given`);
            if (res.status === 404 && session?.id) throw Object.assign(new Refused(`${t.title}: the session ended`), { expired: true });
            if (notification) { await res.body?.cancel?.().catch?.(() => {}); if (res.status >= 400) no(statusSaid(t, res.status)); return { res }; }
            if (res.status >= 400) { await res.body?.cancel?.().catch?.(() => {}); no(statusSaid(t, res.status)); }
            const type = String(res.headers.get('content-type') ?? '');
            let answer = null;
            if (type.includes('text/event-stream') && res.body) {
                for await (const ev of events(res.body, { signal: abort.signal })) {
                    const m = parse(ev.data);
                    if (!m || typeof m !== 'object') continue;
                    if (m.id === id && (m.result !== undefined || m.error !== undefined)) { answer = m; break; }
                    seen(t, m);
                }
                try { await res.body.cancel(); } catch { /* done */ }
            } else {
                const m = parse(await capped(res));
                answer = Array.isArray(m) ? m.find((x) => x?.id === id) : m;
            }
            if (!answer) no(`${t.title} gave no answer to ${method}`);
            if (answer.error) no(`${t.title} refused ${method}: ${oneLine(answer.error.message ?? answer.error.code, 300)}`);
            return { result: answer.result ?? {}, res };
        } catch (e) {
            if (abort.signal.aborted && !(e instanceof Refused && e.late)) throw Object.assign(new Refused(`${t.title} did not answer within ${Math.round(ms / 1000)} s`), { late: true, sent });
            throw e;
        } finally { clearTimeout(timer); }
    }
    /* A message the server sent of itself, in an answer's stream or its own: its tools changed. */
    function seen(t, m) {
        if (m?.method === 'notifications/tools/list_changed') { try { hooks?.changed(t.id); } catch { /* the keeper's */ } }
    }

    async function open(t, ctx) {
        sessions.delete(t.id);
        const { result, res } = await rpc(t, ctx, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: PACKAGE, version: VERSION } }, { session: null });
        const s = { id: oneLine(res.headers.get('mcp-session-id') ?? '', 200) || null, version: oneLine(result?.protocolVersion ?? PROTOCOL, 40) || PROTOCOL, url: endpoint(t), tools: result?.capabilities?.tools ?? null };
        sessions.set(t.id, s);
        await rpc(t, ctx, 'notifications/initialized', undefined, { session: s, notification: true });
        return s;
    }
    /* A session, opened if none; one that ended is opened again, once. */
    async function withSession(t, ctx, fn) {
        let s = sessions.get(t.id);
        if (s && s.url !== endpoint(t)) { s = null; stopListening(t.id); }
        if (!s) s = await open(t, ctx);
        try { return await fn(s); } catch (e) {
            if (!e?.expired) throw e;
            s = await open(t, ctx);
            return fn(s);
        }
    }

    /* THE TOOLS the server lists, every page: its raw list (the keeper keeps a clean catalog). */
    async function discover(t, ctx) {
        const tools = await withSession(t, ctx, async (s) => {
            const all = []; let cursor;
            for (let page = 0; page < PAGES_MAX; page++) {
                const { result } = await rpc(t, ctx, 'tools/list', cursor ? { cursor } : {}, { session: s });
                if (Array.isArray(result?.tools)) all.push(...result.tools);
                cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
                if (!cursor) break;
            }
            return all;
        });
        if (listen) startListening(t, ctx);
        return tools;
    }

    /* ONE CALL of a tool: the server's result as it gave it. */
    async function call(t, ctx, tool, args) {
        try {
            return await withSession(t, ctx, async (s) => (await rpc(t, ctx, 'tools/call', { name: tool, arguments: args ?? {} }, { session: s, ms: callMs })).result);
        } catch (e) {
            /* Gone out and not answered: it may have run. Never said "not done" (asking again would do it twice). */
            if (e?.late && e?.sent !== false) no(`${e.message} -- the call had gone out: it may have been done; check before calling it again`);
            throw e;
        }
    }

    /* The server's own stream (GET): what it says of itself, its tools changed above all. */
    function stopListening(id) { const l = listeners.get(id); if (l) { listeners.delete(id); l.abort.abort(); clearTimeout(l.timer); } }
    function startListening(t, ctx) {
        if (down || listeners.has(t.id)) return;
        const l = { abort: new AbortController(), url: endpoint(t), tries: 0, timer: null };
        listeners.set(t.id, l);
        const again = () => {
            if (down || listeners.get(t.id) !== l || l.abort.signal.aborted) return;
            const wait = RETRY_MS[Math.min(l.tries++, RETRY_MS.length - 1)];
            l.timer = setTimeout(run, wait); l.timer.unref?.();
        };
        const run = async () => {
            if (down || listeners.get(t.id) !== l) return;
            let res;
            try {
                const s = sessions.get(t.id);
                res = await f(l.url, { method: 'GET', headers: await headers(t, ctx, s), redirect: 'manual', signal: l.abort.signal });
            } catch { return again(); }
            /* No stream offered (405...): not asked again; the hourly list and the person's ask stay. */
            if (res.status === 405 || res.status === 404 || res.status >= 300 || !String(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
                try { await res.body?.cancel(); } catch { /* done */ }
                if (res.status >= 500) return again();
                listeners.delete(t.id); return undefined;
            }
            l.tries = 0;
            try { for await (const ev of events(res.body, { max: Infinity, signal: l.abort.signal })) seen(t, parse(ev.data)); } catch { /* broken: again */ }
            return again();
        };
        void run();
    }

    /* At most so many calls of one agent on one server, a minute and a day: past them, refused (and counted only when let through). */
    function admit(t, agent) {
        const key = `${t.id}\n${agent}`;
        const at = now();
        const list = (counts.get(key) ?? []).filter((x) => at - x < 24 * 60 * 60_000);
        const minute = Number(t.config?.perMinute) > 0 ? Number(t.config.perMinute) : PER_MINUTE;
        const day = Number(t.config?.perDay) > 0 ? Number(t.config.perDay) : PER_DAY;
        if (list.filter((x) => at - x < 60_000).length >= minute) { counts.set(key, list); no(`${t.title}: ${minute} calls a minute at most -- nothing was done: wait a minute`); }
        if (list.length >= day) { counts.set(key, list); no(`${t.title}: ${day} calls a day at most -- nothing was done`); }
        list.push(at); counts.set(key, list);
    }

    return {
        discover,
        call,
        admit,
        /* The keeper's hand: told when a server's tools changed; the targets, to list again hourly. */
        attach(h) { hooks = h; },
        /* Listed again each hour when the server never said its tools changed. */
        tick() {
            if (!hooks) return;
            for (const t of hooks.targets?.() ?? []) {
                const at = Date.parse(t.catalog?.at ?? '');
                if (!Number.isFinite(at) || now() - at >= TTL_MS) { try { hooks.changed(t.id); } catch { /* next hour */ } }
            }
        },
        /* A target removed or changed: its session and stream forgotten. */
        forget(id) { sessions.delete(id); stopListening(id); },
        async run(verb, t, a, ctx) {
            if (verb !== 'mcp.call') no(`${verb} is not for an MCP server`);
            return call(t, ctx, a.tool, a.arguments);
        },
        close() {},
        shutdown() { down = true; for (const id of [...listeners.keys()]) stopListening(id); sessions.clear(); },
        listening: (id) => listeners.has(id),
    };
}
