/* A REAL END TO END (run by hand, not part of `npm test`): load the built
 * Chrome extension in Chromium, pair it to an in-process keeper, grant a tab,
 * then drive browser.shot and browser.eval through the keeper and save the
 * captured screenshot. Needs the repo's Playwright and its Chromium.
 *
 *   node test/browser-e2e.mjs
 *
 * It uses the repo's Playwright at a fixed path and never touches the network.
 */
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../host/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/* The repo's Playwright: $TETHER_PLAYWRIGHT, else the tools folder in your home. */
const PLAYWRIGHT = process.env.TETHER_PLAYWRIGHT || join(homedir(), 'clavarium-outils', 'node_modules', 'playwright', 'index.js');
const EXT = resolve(HERE, '../extension/.output/chrome-mv3');
const SHOT_OUT = '/work/repetition/tether-browser-1.png';
const BOT = { id: 'agent:assistant', kind: 'agent', name: 'Assistant' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(step); } };

async function main() {
    const pw = await import(PLAYWRIGHT);
    const chromium = pw.chromium ?? pw.default?.chromium;

    /* A tiny page to act on (no network). */
    const pageServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Tether test page</title><body style="font:40px system-ui;padding:40px"><h1 id="h">Hello from the test page</h1><button id="b" onclick="document.getElementById(\'h\').textContent=\'clicked\'">Press</button><script>console.log("page ready")</script>'); });
    await new Promise((ok) => pageServer.listen(0, '127.0.0.1', ok));
    const pagePort = pageServer.address().port;
    const pageUrl = `http://127.0.0.1:${pagePort}/`;

    /* The keeper, in process, with the browser target at level free and a side. */
    const store = mkdtempSync(join(tmpdir(), 'tether-e2e-store-'));
    const side = mkdtempSync(join(tmpdir(), 'tether-e2e-side-'));
    const o = { store, port: 8787, sides: [{ dir: side, who: BOT }], lang: 'en', local: null, timeout: 10, ssh: null, browser: { title: 'Browser', level: 'free' } };
    const keeperRun = await start(o, { quiet: true });
    const k = keeperRun.keeper;

    const userDir = mkdtempSync(join(tmpdir(), 'tether-e2e-profile-'));
    const context = await chromium.launchPersistentContext(userDir, {
        /* headless:false + --headless=new runs the new headless (no display) while
           Playwright still loads the extension (old headless cannot). */
        headless: false,
        args: ['--headless=new', '--disable-gpu', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });

    try {
        const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
        const extId = new URL(sw.url()).host;
        console.log('extension id:', extId);

        /* Open the test page in a tab. */
        const page = await context.newPage();
        await page.goto(pageUrl);
        await page.bringToFront();

        /* Read the pairing code from the popup, then pair through the keeper page API. */
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extId}/popup.html`);
        const code = await until(async () => { const t = await popup.locator('#code').textContent().catch(() => ''); return t && /\d{6}/.test(t) ? t.trim() : null; });
        console.log('pairing code:', code);
        const pair = await fetch(`http://127.0.0.1:8787/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pair', args: { code } }) }).then((r) => r.json());
        console.log('pair:', pair);
        if (!pair.ok) throw new Error(`pairing failed: ${pair.text}`);

        /* Grant the test tab, from the popup context (the person's toggle). */
        const tabId = await popup.evaluate(async (u) => {
            const tabs = await chrome.tabs.query({});
            const t = tabs.find((x) => x.url && x.url.startsWith(u));
            await chrome.runtime.sendMessage({ op: 'toggleTab', id: t.id, on: true });
            return t.id;
        }, pageUrl);
        console.log('granted tab id:', tabId);
        await sleep(500); // let the extension push its tab list

        /* Drive the agent's verbs through the keeper. */
        const tabsList = await k.act('browser.tabs', { target: 'browser' }, BOT);
        console.log('browser.tabs ->', JSON.stringify(tabsList.text));
        if (!tabsList.text.includes(String(tabId))) throw new Error('the granted tab is not listed');

        const title = await k.act('browser.eval', { target: 'browser', tab: tabId, script: 'document.title', why: 'read the title' }, BOT);
        console.log('browser.eval document.title ->', JSON.stringify(title.text));
        if (!title.text.includes('Tether test page')) throw new Error(`unexpected title: ${title.text}`);

        /* A verb on a tab that was NOT granted must be refused. */
        const refused = await k.act('browser.eval', { target: 'browser', tab: 999999, script: '1', why: 'should fail' }, BOT);
        console.log('ungranted tab ->', refused.ok, JSON.stringify(refused.text));
        if (refused.ok) throw new Error('an ungranted tab was not refused');

        const shot = await k.act('browser.shot', { target: 'browser', tab: tabId }, BOT);
        if (!shot.ok || !shot.text.startsWith('data:image/png;base64,')) throw new Error(`shot failed: ${shot.text.slice(0, 80)}`);
        mkdirSync(dirname(SHOT_OUT), { recursive: true });
        writeFileSync(SHOT_OUT, Buffer.from(shot.text.slice('data:image/png;base64,'.length), 'base64'));
        console.log('shot saved to', SHOT_OUT, `(${shot.data?.size ?? shot.text.length} bytes)`);

        console.log('\nE2E OK: paired, granted, listed, eval, scoping refusal, shot.');
    } finally {
        await context.close().catch(() => {});
        await keeperRun.close().catch(() => {});
        pageServer.close();
    }
}

main().then(() => process.exit(0), (e) => { console.error('E2E FAILED:', e); process.exit(1); });
