/* FLASH A DEVICE FROM THIS BROWSER: a device plugged into this computer (or this
 * Android phone or tablet) by USB gets its firmware, then its Wi-Fi, by the same
 * cable. Nothing is installed: Web Serial (Chrome, Edge), or WebUSB where only
 * that exists (Chrome on Android), with esptool-js; then Improv Wi-Fi (improv.js).
 *
 *   const r = await run(args, { root, words })    // called from a click: the browser
 *                                                 // only lets a click choose a port
 *   args: { firmware: an address of this site, name, wifi: true|false,
 *           app: { url, room, code } }            // optional: what the device joins
 *   r:    { ok, text }                            // said back to the agent as it is
 *
 * It draws its own few lines in `root`: the steps, a progress bar, the Wi-Fi to choose.
 * The Wi-Fi password goes to the device, and nowhere else.
 */
import { command, reader, result, TYPE, STATE, ERROR, CMD } from './improv.js';

const ESPRESSIF = 0x303a;   // the USB vendor of ESP32-S3's own USB port
const WORDS = {
    'choose-port': 'Choose the device in the list the browser shows.',
    'no-serial': 'This browser cannot reach a USB device: use Chrome or Edge on a computer, or Chrome on Android.',
    'download': 'Getting the firmware…',
    'connect': 'Connecting to the device…',
    'flash': 'Writing the firmware: {pct} %',
    'restart': 'Restarting the device…',
    'reopen': 'The device restarted. Choose it again in the list.',
    'reopen-button': 'Choose the device',
    'wifi': 'Which Wi-Fi should it use?',
    'password': 'Wi-Fi password',
    'join': 'Connect',
    'skip': 'Not now',
    'joining': 'The device joins the Wi-Fi…',
    'done': 'Done: the device is flashed{wifi}.',
    'done-wifi': ' and connected',
    'failed-connect': 'The device could not join this Wi-Fi: check the password.',
    'failed-pairing': 'The device joined the Wi-Fi, but the pairing was refused: ask for a new code.',
    'rescan': 'Look again',
};

export async function run(args = {}, { root = null, words = {} } = {}) {
    const w = (k, v = {}) => String(words[k] ?? WORDS[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => v[x] ?? m);
    const view = paneIn(root);
    const say = (text) => view.line(text);
    let port;
    try {
        const serial = await serialApi();
        if (!serial) return fail(w('no-serial'));
        say(w('choose-port'));
        port = await serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF }] });

        say(w('download'));
        const response = await fetch(String(args.firmware), { credentials: 'same-origin' });
        if (!response.ok) return fail(`firmware not found (${response.status})`);
        const image = new Uint8Array(await response.arrayBuffer());

        say(w('connect'));
        const { ESPLoader, Transport } = await import('./vendor/esptool-0.6.1.js');
        const transport = new Transport(port, false);
        const loader = new ESPLoader({ transport, baudrate: 460800, terminal: { clean() {}, writeLine() {}, write() {} } });
        const chip = await loader.main();
        await loader.writeFlash({
            fileArray: [{ data: image, address: 0 }], flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
            eraseAll: false, compress: true,
            reportProgress: (i, written, total) => { const pct = Math.floor(written * 100 / total); view.progress(pct); view.line(w('flash', { pct })); },
        });
        say(w('restart'));
        await loader.after('hard_reset');
        await transport.disconnect().catch(() => {});
        view.progress(null);

        if (args.wifi === false) return done(`${args.name ?? 'The device'} (${chip}) flashed with ${image.length} bytes.`);
        port = await reopen(port, serial, view, w);
        const joined = await provision(port, args, view, w);
        return done(`${args.name ?? 'The device'} (${chip}) flashed with ${image.length} bytes${joined ? `; joined the Wi-Fi ${joined}${args.app ? ' and paired' : ''}` : '; Wi-Fi not given'}.`);
    } catch (error) {
        return fail(error?.name === 'NotFoundError' ? 'no device was chosen' : String(error?.message ?? error));
    } finally {
        try { await port?.close(); } catch { /* closed already */ }
    }

    function done(text) { view.line(w('done', { wifi: text.includes('joined') ? w('done-wifi') : '' })); return { ok: true, text }; }
    function fail(text) { view.line(text, true); return { ok: false, text }; }
}

/* navigator.serial, or the same API over WebUSB (Chrome on Android). */
async function serialApi() {
    if (globalThis.navigator?.serial) return navigator.serial;
    if (globalThis.navigator?.usb) return (await import('./vendor/web-serial-polyfill-1.0.15.js')).serial;
    return null;
}

/* After its restart the device comes back on USB: the same port object when the browser
   keeps it, else a person chooses it again (a click: the browser asks for one). */
async function reopen(port, serial, view, w) {
    for (let i = 0; i < 20; i++) {
        await sleep(500);
        try { await port.open({ baudRate: 115200 }); return port; } catch { /* not back yet */ }
    }
    view.line(w('reopen'));
    await view.button(w('reopen-button'));
    const again = await serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF }] });
    await again.open({ baudRate: 115200 });
    return again;
}

/* Improv: the networks it sees, a person's choice, then Wi-Fi (and pairing). Resolves with the SSID joined, or ''. */
async function provision(port, args, view, w) {
    const link = improvLink(port);
    try {
        await sleep(1500);   // its Wi-Fi starts
        let networks = await link.scan();
        for (;;) {
            const pick = await view.pickWifi(networks, w);
            if (pick === 'rescan') { networks = await link.scan(); continue; }
            if (!pick) return '';
            if (args.app) await link.ask(CMD.APP, [args.app.url, args.app.room ?? '', args.app.code], 5000);
            view.line(w('joining'));
            const end = await link.wifi(pick.ssid, pick.password);
            if (end === 'ok') return pick.ssid;
            view.line(end === 'pairing' ? w('failed-pairing') : w('failed-connect'), true);
            if (end === 'pairing') throw new Error(w('failed-pairing'));
        }
    } finally {
        await link.close();
    }
}

function improvLink(port) {
    const read = reader();
    const waiting = [];
    let closed = false;
    const reading = port.readable.getReader();
    (async () => {
        try {
            while (!closed) {
                const { value, done } = await reading.read();
                if (done) break;
                for (const p of read.push(value)) for (const wtr of [...waiting]) wtr(p);
            }
        } catch { /* closed */ }
    })();
    const writer = port.writable.getWriter();
    const next = (test, ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(on), 1); reject(new Error('the device did not answer')); }, ms);
        function on(p) { if (test(p)) { clearTimeout(timer); waiting.splice(waiting.indexOf(on), 1); resolve(p); } }
        waiting.push(on);
    });
    return {
        async ask(cmd, strings, ms) {
            const answer = next((p) => (p.type === TYPE.RESULT && result(p.data).cmd === cmd) || (p.type === TYPE.ERROR && p.data[0] !== ERROR.NONE), ms);
            await writer.write(command(cmd, strings));
            const p = await answer;
            if (p.type === TYPE.ERROR) throw new Error(`the device refused (${p.data[0]})`);
            return result(p.data).strings;
        },
        async scan() {
            const list = [];
            const ended = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { waiting.splice(waiting.indexOf(on), 1); reject(new Error('the device did not answer')); }, 20000);
                function on(p) {
                    if (p.type !== TYPE.RESULT) return;
                    const r = result(p.data);
                    if (r.cmd !== CMD.SCAN) return;
                    if (r.strings.length === 0) { clearTimeout(timer); waiting.splice(waiting.indexOf(on), 1); resolve(); return; }
                    list.push({ ssid: r.strings[0], rssi: Number(r.strings[1]), secure: r.strings[2] === 'YES' });
                }
                waiting.push(on);
            });
            await writer.write(command(CMD.SCAN));
            await ended;
            return list;
        },
        async wifi(ssid, password) {
            const end = next((p) => (p.type === TYPE.STATE && p.data[0] === STATE.PROVISIONED) || (p.type === TYPE.ERROR && p.data[0] !== ERROR.NONE), 60000);
            await writer.write(command(CMD.WIFI, [ssid, password ?? '']));
            const p = await end;
            if (p.type === TYPE.STATE) return 'ok';
            return p.data[0] === ERROR.PAIRING ? 'pairing' : 'connect';
        },
        async close() {
            closed = true;
            try { await reading.cancel(); } catch { /* */ }
            reading.releaseLock();
            writer.releaseLock();
        },
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The few lines it draws. Without a root (tests, a host that draws its own), it draws nothing. */
function paneIn(root) {
    if (!root) return { line() {}, progress() {}, button: async () => {}, pickWifi: async () => null };
    const h = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); } el.append(...kids); return el; };
    const text = h('p', { class: 'tether-flash-line', role: 'status' });
    const bar = h('progress', { max: '100', hidden: '' });
    const extra = h('div', { class: 'tether-flash-extra' });
    root.replaceChildren(h('div', { class: 'tether-flash' }, text, bar, extra));
    return {
        line(t, bad = false) { text.textContent = t; text.classList.toggle('tether-flash-bad', bad); },
        progress(pct) { if (pct === null) { bar.hidden = true; return; } bar.hidden = false; bar.value = pct; },
        button(label) { return new Promise((resolve) => { extra.replaceChildren(h('button', { type: 'button', class: 'tether-accept', onclick: () => { extra.replaceChildren(); resolve(); } }, label)); }); },
        pickWifi(networks, w) {
            return new Promise((resolve) => {
                const select = h('select', { 'aria-label': w('wifi') }, ...networks.map((n) => h('option', { value: n.ssid }, `${n.ssid}${n.secure ? ' 🔒' : ''}`)));
                const pass = h('input', { type: 'password', autocomplete: 'off', 'aria-label': w('password'), placeholder: w('password') });
                const go = () => { const v = { ssid: select.value, password: pass.value }; extra.replaceChildren(); resolve(v); };
                extra.replaceChildren(h('label', {}, w('wifi'), select), pass,
                    h('div', { class: 'tether-buttons' },
                        h('button', { type: 'button', class: 'tether-accept', onclick: go }, w('join')),
                        h('button', { type: 'button', class: 'tether-plain', onclick: () => { extra.replaceChildren(); resolve('rescan'); } }, w('rescan')),
                        h('button', { type: 'button', class: 'tether-plain', onclick: () => { extra.replaceChildren(); resolve(null); } }, w('skip'))));
                pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
                select.focus();
            });
        },
    };
}
