/* THE LINK TO THE KEEPER: an outbound WebSocket, with a heartbeat and a
 * reconnection. The extension connects OUT (the keeper never reaches in), so
 * one socket to 127.0.0.1 or a wss:// keeper is all it takes, through any
 * firewall. Firefox may suspend the background worker despite the heartbeat, so
 * every path reconnects: a closed socket, a missed pong, a worker that woke up.
 *
 * Pairing: with no token the extension says hello and offers the short code it
 * shows in its popup; the keeper answers `paired` with a long-lived token, kept
 * in extension storage (through setToken) and never logged. With a token it
 * says hello and is welcomed.
 *
 * Everything the clock and the socket do is injected, so this runs under test
 * with fakes and in the worker with the real globals.
 */
export function createLink(opts) {
    const {
        url,
        WebSocketImpl = globalThis.WebSocket,
        getToken = () => null,
        setToken = () => {},
        pairingCode = () => '',
        onCall = async () => ({}),
        onStatus = () => {},
        heartbeatMs = 20_000,
        backoffMs = [1000, 2000, 5000, 10_000, 20_000],
        setInt = setInterval,
        clearInt = clearInterval,
        setTmo = setTimeout,
        clearTmo = clearTimeout,
    } = opts;

    let ws = null;
    let hb = null;
    let reconnectTimer = null;
    let tries = 0;
    let alive = false;
    let stopped = false;
    let status = 'idle';

    const setStatus = (s) => { status = s; try { onStatus(s); } catch { /* caller's */ } };
    const sendRaw = (obj) => { try { ws.send(JSON.stringify(obj)); return true; } catch { return false; } };

    function stopHeartbeat() { if (hb) { clearInt(hb); hb = null; } }
    function startHeartbeat() {
        stopHeartbeat();
        alive = true;
        hb = setInt(() => {
            if (!alive) { try { ws.close(); } catch { /* gone */ } return; }
            alive = false;
            sendRaw({ t: 'ping' });
        }, heartbeatMs);
    }

    function schedule() {
        if (stopped || reconnectTimer) return;
        const wait = backoffMs[Math.min(tries, backoffMs.length - 1)];
        tries++;
        reconnectTimer = setTmo(() => { reconnectTimer = null; connect(); }, wait);
    }

    function handle(data) {
        let m; try { m = JSON.parse(data); } catch { return; }
        switch (m.t) {
            case 'pair-needed': sendRaw({ t: 'pair', code: pairingCode() }); break;
            case 'paired': if (m.token) { try { setToken(m.token); } catch { /* storage */ } setStatus('ready'); } break;
            case 'welcome': setStatus('ready'); break;
            case 'pong': alive = true; break;
            case 'ping': sendRaw({ t: 'pong' }); break;
            case 'call': Promise.resolve(onCall(m)).then((res) => sendRaw(res)).catch((e) => sendRaw({ t: 'result', id: m.id, ok: false, error: String(e?.message ?? e) })); break;
            default: break;
        }
    }

    function connect() {
        if (stopped) return;
        setStatus('connecting');
        try { ws = new WebSocketImpl(url); } catch { schedule(); return; }
        ws.onopen = () => {
            tries = 0;
            const token = getToken();
            sendRaw(token ? { t: 'hello', token } : { t: 'hello' });
            if (!token) sendRaw({ t: 'pair', code: pairingCode() });
            startHeartbeat();
            setStatus(token ? 'connected' : 'pairing');
        };
        ws.onmessage = (ev) => handle(typeof ev === 'object' && 'data' in ev ? ev.data : ev);
        ws.onclose = () => { stopHeartbeat(); if (!stopped) { setStatus('disconnected'); schedule(); } };
        ws.onerror = () => { try { ws.close(); } catch { /* gone */ } };
    }

    return {
        start() { stopped = false; tries = 0; connect(); },
        stop() { stopped = true; stopHeartbeat(); if (reconnectTimer) { clearTmo(reconnectTimer); reconnectTimer = null; } try { ws?.close(); } catch { /* gone */ } setStatus('idle'); },
        /* Push the granted tab list (or any message) to the keeper now. */
        send(obj) { return sendRaw(obj); },
        status: () => status,
        _ping() { if (hb) { if (!alive) { try { ws.close(); } catch { /* gone */ } } else { alive = false; sendRaw({ t: 'ping' }); } } },
    };
}
