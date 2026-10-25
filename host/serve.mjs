/* WITHOUT AN APPLICATION: `serve` keeps the targets itself, and shows their
 * page to the person on this machine: the calls waiting, the levels, the
 * journal, Stop.
 *
 *   tether serve [--store DIR] [--port N] [--side FOLDER=NAME]... [--lang fr]
 *                [--local FOLDER[=TITLE]] [--timeout MINUTES]
 *                [--ssh USER@HOST[:PORT] --ssh-key FILE
 *                 [--ssh-title T] [--ssh-pin PIN] [--ssh-root DIR]
 *                 [--ssh-level LEVEL] [--ssh-passphrase-env VAR]]
 *                [--webdav URL --webdav-pass-env VAR [--webdav-user NAME]
 *                 [--webdav-root DIR] [--webdav-title T] [--webdav-level LEVEL]]
 *                [--graph-drive ID --graph-token-env VAR
 *                 [--graph-root DIR] [--graph-title T] [--graph-level LEVEL]]
 *                [--browser [--browser-title T] [--browser-level LEVEL]]
 *                [--screen URL --screen-token-env VAR [--screen-engine MODULE]
 *                 [--screen-user NAME] [--screen-node ID] [--screen-title T]
 *                 [--screen-level LEVEL]]
 *
 * The store is DIR (default: $TETHER_STORE, else ~/.local/share/clavarium-tether):
 * put it where the agents cannot write, since whoever writes the store gives
 * themselves any level. Each --side is an agent's folder and the name it is
 * shown by; without one, the folder's own, as "Agent".
 *
 * --local gives the agents THIS machine as a target, through the local
 * connector: a shell in tmux and FOLDER. Off unless asked for. Given at level
 * "propose" the first time: every action is asked.
 *
 * --ssh declares one SSH target: USER@HOST[:PORT], its private key read from
 * --ssh-key FILE (the FILE's content is the secret; the path is not stored).
 * --ssh-pin checks the server's identity (an "SHA256:…" fingerprint, a
 * known-hosts line, or the base64 key); --ssh-root scopes files.* to a remote
 * folder; --ssh-passphrase-env names an environment variable holding the key's
 * passphrase (never passed on the command line). Given at level "propose".
 *
 * --webdav declares one online-folder target on a WebDAV server (Nextcloud and
 * the like): --webdav URL is the collection, --webdav-user the Basic-auth user,
 * --webdav-pass-env names an environment variable holding the password (an app
 * password / app token), --webdav-root scopes files.* to a sub-folder.
 *
 * --graph-drive declares one online-folder target on SharePoint/OneDrive through
 * Microsoft Graph: the drive id, with --graph-token-env naming an environment
 * variable holding a bearer token the host keeps fresh, and --graph-root a
 * sub-folder. Both are given at level "propose"; their secret is read from the
 * environment, never the command line.
 *
 * --screen declares one `screen` target: URL is the engine's endpoint (stored in
 * the target's config, never taken from the agent). --screen-token-env names an
 * environment variable holding the login token (the secret); --screen-user and
 * --screen-node are passed to the engine when it connects. Tether ships no engine:
 * --screen-engine MODULE points at a module exporting the engine factory
 * (createScreen, or a default export). Without it the target is declared but its
 * connector stays off. Given at level "propose".
 * --browser gives the agents a `browser` target: the Tether extension connects
 * out to ws://127.0.0.1:PORT/browser and is paired by a short code entered on
 * the page. Given at level "propose" (every action asked). --browser-title and
 * --browser-level change its name and level.
 *
 * The page listens on 127.0.0.1 only: who reaches it is the person.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { keeper } from './keeper.mjs';
import { browser as browserConnector } from './connectors/browser.mjs';
import { screen as screenConnector } from './connectors/screen.mjs';
import { wsUpgrade } from './ws.mjs';
import { NAME, PACKAGE, FOLDER, ENV_STORE } from '../server/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, '../ui');
const PERSON = { id: 'person:you', kind: 'person', name: 'You' };
const BODY_MAX = 256 * 1024;
export const PORT = 4190;
const TITLE = NAME.charAt(0).toUpperCase() + NAME.slice(1);

const PAGE = (lang, hasBrowser = false) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE}</title><link rel="stylesheet" href="/ui/ui.css">
<style>html,body{margin:0;background:#faf9f6;color:#1f2328}@media (prefers-color-scheme:dark){html,body{background:#121418;color:#e7e9ee}}
body{font:15px/1.4 system-ui,sans-serif;padding:16px 20px 40px;max-width:1240px;margin:auto;box-sizing:border-box}h1{font-size:1.15rem;margin:0 0 14px}
#pair{border:1px solid #0002;border-radius:10px;padding:10px 14px;margin:0 0 16px;max-width:460px}@media (prefers-color-scheme:dark){#pair{border-color:#fff2}}
#pair h2{font-size:.95rem;margin:0 0 6px}#pair input{font:inherit;padding:4px 8px;width:7em}#pair button{font:inherit;padding:4px 10px}#pair .s{font-size:.85rem;opacity:.75}</style>
<h1>${TITLE}</h1>
${hasBrowser ? '<section id="pair"><h2>Pair a browser</h2><div class="s" id="pstat">…</div><p>Enter the code shown in the Tether extension: <input id="pcode" inputmode="numeric" autocomplete="off"> <button id="pgo">Pair</button></p></section>' : ''}
<div id="app"></div>
<script type="module">
import { mount } from '/ui/ui.js';
const words = await (await fetch('/ui/texts/${lang}.json')).json();
const call = async (op, args) => (await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) })).json();
const s = mount(document.getElementById('app'), { call, words, lang: '${lang}' });
const hasBrowser = ${hasBrowser ? 'true' : 'false'};
async function browserStatus() {
  if (!hasBrowser) return;
  const r = await call('browser', {});
  const d = r.data || {};
  const el = document.getElementById('pstat');
  el.textContent = d.connected ? ('Connected · ' + d.tabs.length + ' tab(s) granted') : (d.waiting ? 'An extension is waiting: enter its code below.' : 'No extension connected yet.');
}
if (hasBrowser) {
  document.getElementById('pgo').onclick = async () => {
    const code = document.getElementById('pcode').value.trim();
    const r = await call('pair', { code });
    document.getElementById('pstat').textContent = r.ok ? 'Paired.' : r.text;
    if (r.ok) document.getElementById('pcode').value = '';
    browserStatus();
  };
  browserStatus();
}
let soon = null;
new EventSource('/api/changes').onmessage = () => { clearTimeout(soon); soon = setTimeout(() => { s.refresh(); browserStatus(); }, 60); };
</script></html>`;

export function options(argv, { env = process.env, cwd = process.cwd() } = {}) {
    const o = { store: env[ENV_STORE] || join(homedir(), '.local', 'share', PACKAGE), port: PORT, sides: [], lang: 'en', local: null, timeout: 10, ssh: null, webdav: null, graph: null, browser: null, screen: null };
    const sshOf = () => (o.ssh ??= { port: 22, title: '', pin: '', root: '', level: 'propose', keyFile: '', passphraseEnv: '' });
    const webdavOf = () => (o.webdav ??= { url: '', user: '', root: '', title: '', level: 'propose', passEnv: '' });
    const graphOf = () => (o.graph ??= { drive: '', root: '', title: '', level: 'propose', tokenEnv: '' });
    const screenOf = () => (o.screen ??= { url: '', user: '', node: '', title: '', level: 'propose', tokenEnv: '', enginePath: '' });
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]; const v = argv[i + 1];
        if (a === '--store' && v) { o.store = resolve(cwd, v); i++; }
        else if (a === '--port' && v) { o.port = Number(v); i++; }
        else if (a === '--lang' && v) { o.lang = v === 'fr' ? 'fr' : 'en'; i++; }
        else if (a === '--timeout' && v) { o.timeout = Number(v); i++; }
        else if (a === '--ssh' && v) {
            const m = /^([^@/]+)@([^@:/]+)(?::(\d+))?$/.exec(v);
            if (!m) throw new Error('--ssh takes USER@HOST[:PORT]');
            const s = sshOf(); s.user = m[1]; s.host = m[2]; if (m[3]) s.port = Number(m[3]); i++;
        }
        else if (a === '--ssh-key' && v) { sshOf().keyFile = resolve(cwd, v); i++; }
        else if (a === '--ssh-title' && v) { sshOf().title = v; i++; }
        else if (a === '--ssh-pin' && v) { sshOf().pin = v; i++; }
        else if (a === '--ssh-root' && v) { sshOf().root = v; i++; }
        else if (a === '--ssh-passphrase-env' && v) { sshOf().passphraseEnv = v; i++; }
        else if (a === '--ssh-level' && v) { sshOf().level = v; i++; }
        else if (a === '--webdav' && v) { webdavOf().url = v; i++; }
        else if (a === '--webdav-user' && v) { webdavOf().user = v; i++; }
        else if (a === '--webdav-root' && v) { webdavOf().root = v; i++; }
        else if (a === '--webdav-title' && v) { webdavOf().title = v; i++; }
        else if (a === '--webdav-level' && v) { webdavOf().level = v; i++; }
        else if (a === '--webdav-pass-env' && v) { webdavOf().passEnv = v; i++; }
        else if (a === '--graph-drive' && v) { graphOf().drive = v; i++; }
        else if (a === '--graph-root' && v) { graphOf().root = v; i++; }
        else if (a === '--graph-title' && v) { graphOf().title = v; i++; }
        else if (a === '--graph-level' && v) { graphOf().level = v; i++; }
        else if (a === '--graph-token-env' && v) { graphOf().tokenEnv = v; i++; }
        else if (a === '--screen' && v) { screenOf().url = v; i++; }
        else if (a === '--screen-token-env' && v) { screenOf().tokenEnv = v; i++; }
        else if (a === '--screen-engine' && v) { screenOf().enginePath = resolve(cwd, v); i++; }
        else if (a === '--screen-user' && v) { screenOf().user = v; i++; }
        else if (a === '--screen-node' && v) { screenOf().node = v; i++; }
        else if (a === '--screen-title' && v) { screenOf().title = v; i++; }
        else if (a === '--screen-level' && v) { screenOf().level = v; i++; }
        else if (a === '--browser') { o.browser ??= { title: 'Browser', level: 'propose' }; }
        else if (a === '--browser-title' && v) { (o.browser ??= { title: 'Browser', level: 'propose' }).title = v; i++; }
        else if (a === '--browser-level' && v) { (o.browser ??= { title: 'Browser', level: 'propose' }).level = v; i++; }
        else if (a === '--local' && v) {
            const at = v.lastIndexOf('='); const folder = resolve(cwd, at > 0 ? v.slice(0, at) : v);
            o.local = { folder, title: at > 0 ? v.slice(at + 1) : basename(folder) }; i++;
        } else if (a === '--side' && v) {
            const at = v.lastIndexOf('='); const dir = resolve(cwd, at > 0 ? v.slice(0, at) : v); const name = at > 0 ? v.slice(at + 1) : 'Agent';
            o.sides.push({ dir, who: { id: `agent:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, kind: 'agent', name } }); i++;
        } else throw new Error(`not understood: ${a}`);
    }
    if (!o.sides.length) o.sides.push({ dir: join(cwd, FOLDER), who: { id: 'agent:agent', kind: 'agent', name: 'Agent' } });
    if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port takes a number');
    if (!(o.timeout > 0)) throw new Error('--timeout takes a number of minutes');
    const levelOk = (level) => ['watch', 'propose', 'frame', 'free'].includes(level);
    if (o.ssh) {
        if (!o.ssh.host || !o.ssh.user) throw new Error('--ssh takes USER@HOST[:PORT]');
        if (!o.ssh.keyFile) throw new Error('--ssh needs --ssh-key FILE');
        if (!levelOk(o.ssh.level)) throw new Error('--ssh-level is one of: watch, propose, frame, free');
        o.ssh.title ||= o.ssh.host;
    }
    if (o.webdav) {
        if (!o.webdav.url) throw new Error('--webdav takes a URL');
        if (!o.webdav.passEnv) throw new Error('--webdav needs --webdav-pass-env VAR');
        if (!levelOk(o.webdav.level)) throw new Error('--webdav-level is one of: watch, propose, frame, free');
        o.webdav.title ||= o.webdav.url;
    }
    if (o.graph) {
        if (!o.graph.drive) throw new Error('--graph-drive takes a drive id');
        if (!o.graph.tokenEnv) throw new Error('--graph-drive needs --graph-token-env VAR');
        if (!levelOk(o.graph.level)) throw new Error('--graph-level is one of: watch, propose, frame, free');
        o.graph.title ||= 'Online folder';
    }
    if (o.browser) {
        if (!['watch', 'propose', 'frame', 'free'].includes(o.browser.level)) throw new Error('--browser-level is one of: watch, propose, frame, free');
        o.browser.title ||= 'Browser';
    }
    if (o.screen) {
        if (!o.screen.url) throw new Error('--screen takes a URL');
        if (!o.screen.tokenEnv) throw new Error('--screen needs --screen-token-env VAR');
        if (!levelOk(o.screen.level)) throw new Error('--screen-level is one of: watch, propose, frame, free');
        o.screen.title ||= 'Screen';
    }
    return o;
}

export function start(o, { quiet = false, screenEngine = null } = {}) {
    for (const s of o.sides) mkdirSync(s.dir, { recursive: true });
    /* The SSH key and its passphrase are read here, when a connector asks for
       them by the name the target gave. Neither is written to the store, the
       journal or the page: only the names "ssh-key" and "ssh-passphrase" are. */
    const secrets = (o.ssh || o.webdav || o.graph || o.screen) ? async (name) => {
        if (o.ssh && name === 'ssh-key') return readFileSync(o.ssh.keyFile, 'utf8');
        if (o.ssh && name === 'ssh-passphrase' && o.ssh.passphraseEnv) return process.env[o.ssh.passphraseEnv] ?? '';
        if (o.webdav && name === 'webdav-pass') return process.env[o.webdav.passEnv] ?? '';
        if (o.graph && name === 'graph-token') return process.env[o.graph.tokenEnv] ?? '';
        if (o.screen && name === 'screen-token') return process.env[o.screen.tokenEnv] ?? '';
        throw new Error(`no secret named ${name}`);
    } : undefined;
    /* The browser connector: the extension connects out to it over a WebSocket
       (the /browser endpoint below). Its tokens are kept in a file of the store,
       never in the journal; only names and tab lists ever leave this process. */
    let browser = null;
    if (o.browser) {
        const file = join(o.store, 'browser-tokens.json');
        const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } };
        let toks = read();
        const save = () => { try { writeFileSync(file, JSON.stringify(toks)); } catch { /* best effort */ } };
        const tokens = { has: (t) => toks.includes(t), add: (t) => { if (!toks.includes(t)) { toks.push(t); save(); } }, remove: (t) => { toks = toks.filter((x) => x !== t); save(); }, list: () => [...toks] };
        browser = browserConnector({ tokens });
    }
    /* The screen connector is the envelope; the engine is the operator's, loaded
       (if any) by serveMain and passed in. With none, the target stays off. */
    const screen = o.screen ? screenConnector({ engine: screenEngine ?? undefined }) : null;
    const connectors = { ...(browser ? { browser } : {}), ...(screen ? { screen } : {}) };
    const k = keeper(o.store, { sides: () => o.sides, local: !!o.local, timeout: o.timeout * 60_000, ...(secrets ? { secrets } : {}), ...(Object.keys(connectors).length ? { connectors } : {}) });
    if (o.browser) {
        const t = k.store.putTarget({ id: 'browser', title: o.browser.title, kind: 'browser', connector: 'browser', config: {} });
        for (const s of o.sides) if (!t.grants[s.who.id]) k.store.grant(t.id, s.who.id, o.browser.level);
    }
    if (o.local) {
        const t = k.store.putTarget({ id: 'local', title: o.local.title, kind: 'computer', connector: 'local', config: { folder: o.local.folder } });
        for (const s of o.sides) if (!t.grants[s.who.id]) k.store.grant(t.id, s.who.id, 'propose');
    }
    if (o.ssh) {
        const config = { host: o.ssh.host, port: o.ssh.port, user: o.ssh.user };
        if (o.ssh.pin) config.pin = o.ssh.pin;
        if (o.ssh.root) config.root = o.ssh.root;
        const sec = { key: 'ssh-key', ...(o.ssh.passphraseEnv ? { passphrase: 'ssh-passphrase' } : {}) };
        const t = k.store.putTarget({ id: 'ssh', title: o.ssh.title, kind: 'ssh', connector: 'ssh', config, secrets: sec });
        for (const s of o.sides) if (!t.grants[s.who.id]) k.store.grant(t.id, s.who.id, o.ssh.level);
    }
    if (o.webdav) {
        const config = { url: o.webdav.url };
        if (o.webdav.user) config.user = o.webdav.user;
        if (o.webdav.root) config.root = o.webdav.root;
        const t = k.store.putTarget({ id: 'webdav', title: o.webdav.title, kind: 'files', connector: 'webdav', config, secrets: { password: 'webdav-pass' } });
        for (const s of o.sides) if (!t.grants[s.who.id]) k.store.grant(t.id, s.who.id, o.webdav.level);
    }
    if (o.graph) {
        const config = { drive: o.graph.drive };
        if (o.graph.root) config.root = o.graph.root;
        const t = k.store.putTarget({ id: 'graph', title: o.graph.title, kind: 'files', connector: 'graph', config, secrets: { token: 'graph-token' } });
        for (const s of o.sides) if (!t.grants[s.who.id]) k.store.grant(t.id, s.who.id, o.graph.level);
    }
    if (o.screen) {
        const config = { url: o.screen.url };
        if (o.screen.user) config.user = o.screen.user;
        if (o.screen.node) config.node = o.screen.node;
        const t = k.store.putTarget({ id: 'screen', title: o.screen.title, kind: 'screen', connector: 'screen', config, secrets: { token: 'screen-token' } });
        for (const s of o.sides) if (!t.grants[s.who.id]) k.store.grant(t.id, s.who.id, o.screen.level);
    }
    const watchers = new Set();
    const nudge = () => { for (const res of watchers) res.write('data: change\n\n'); };
    k.onChange(nudge);
    if (browser) browser.onChange(nudge);
    const pump = setInterval(() => { try { k.pump(); } catch (error) { if (!quiet) process.stderr.write(`${NAME}: ${error.message}\n`); } }, 300);
    const files = { '/ui/ui.js': 'text/javascript', '/ui/ui.css': 'text/css', '/ui/texts/en.json': 'application/json', '/ui/texts/fr.json': 'application/json' };
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://local');
        const send = (code, type, body) => { res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' }); res.end(body); };
        if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html', PAGE(o.lang, !!browser));
        if (req.method === 'GET' && files[url.pathname]) return send(200, files[url.pathname], readFileSync(join(UI, url.pathname.slice('/ui/'.length))));
        if (req.method === 'GET' && url.pathname === '/api/changes') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': on\n\n');
            watchers.add(res); req.on('close', () => watchers.delete(res)); return undefined;
        }
        if (req.method === 'POST' && url.pathname === '/api') {
            /* A page of another site cannot post here: the type it would need is not one a form sends. */
            if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, 'text/plain', 'json only');
            let body = '';
            req.on('data', (c) => { body += c; if (body.length > BODY_MAX) req.destroy(); });
            req.on('end', async () => {
                let q; try { q = JSON.parse(body); } catch { return send(400, 'application/json', JSON.stringify({ ok: false, text: 'not understood' })); }
                const op = String(q?.op ?? '');
                const args = q?.args && typeof q.args === 'object' ? q.args : {};
                /* Pairing and browser status are the connector's, not the keeper store's. */
                if (browser && op === 'pair') { try { return send(200, 'application/json', JSON.stringify({ ok: true, text: 'Paired.', data: browser.pair(args.code) })); } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, text: e.message })); } }
                if (browser && op === 'browser') return send(200, 'application/json', JSON.stringify({ ok: true, text: 'ok', data: browser.status() }));
                const r = await k.act(op, args, PERSON);
                return send(200, 'application/json', JSON.stringify(r));
            });
            return undefined;
        }
        return send(404, 'text/plain', 'not here');
    });
    /* The extension connects out to this endpoint; the raw socket is wrapped as
       a channel and handed to the browser connector. 127.0.0.1 only, like the page. */
    if (browser) server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://local');
        if (url.pathname !== '/browser') { try { socket.destroy(); } catch { /* gone */ } return; }
        const channel = wsUpgrade(req, socket, head);
        if (channel) browser.accept(channel);
    });
    return new Promise((ok) => server.listen(o.port, '127.0.0.1', () => {
        const port = server.address().port;
        if (!quiet) process.stdout.write(`${TITLE} kept in ${o.store}\nPage: http://127.0.0.1:${port}/\nAgents: ${o.sides.map((s) => `${s.who.name} (${s.dir})`).join(', ')}\n${o.local ? `This machine given: ${o.local.folder}\n` : ''}${o.ssh ? `SSH target "${o.ssh.title}": ${o.ssh.user}@${o.ssh.host}:${o.ssh.port} (${o.ssh.level})\n` : ''}${o.webdav ? `WebDAV target "${o.webdav.title}": ${o.webdav.url} (${o.webdav.level})\n` : ''}${o.graph ? `Graph target "${o.graph.title}": drive ${o.graph.drive} (${o.graph.level})\n` : ''}${o.browser ? `Browser target "${o.browser.title}" (${o.browser.level}): pair the extension at ws://127.0.0.1:${port}/browser\n` : ''}${o.screen ? `Screen target "${o.screen.title}" (${o.screen.level}): ${o.screen.url}${screenEngine ? '' : ' — no engine plugged in (connector off); use --screen-engine'}\n` : ''}`);
        ok({ server, keeper: k, port, close: async () => { clearInterval(pump); for (const r of watchers) r.end(); if (browser) browser.shutdown(); server.close(); await k.close(); } });
    }));
}

export async function serveMain(argv) {
    let o;
    try { o = options(argv); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 64; return; }
    /* The screen engine is the operator's, not Tether's: loaded here from the
       module --screen-engine names, so serve has no hard dependency on it. */
    let screenEngine = null;
    if (o.screen?.enginePath) {
        try {
            const mod = await import(pathToFileURL(o.screen.enginePath).href);
            screenEngine = mod.createScreen ?? mod.default;
            if (typeof screenEngine !== 'function') throw new Error('it exports no createScreen (or default) factory');
        } catch (error) { process.stderr.write(`--screen-engine: ${error.message}\n`); process.exitCode = 64; return; }
    }
    const s = await start(o, { screenEngine });
    /* Down within three seconds, whatever a connector is still doing. */
    const down = async () => { setTimeout(() => process.exit(0), 3000).unref(); try { await s.close(); } finally { process.exit(0); } };
    process.on('SIGINT', down); process.on('SIGTERM', down);
}
