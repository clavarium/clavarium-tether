/* THE POPUP: the person's control. It shows the link status, the pairing code
 * to type in the keeper page, and every tab with an on/off toggle and a
 * per-site allow. It only reads and changes grants in the background; it holds
 * no connection and no token.
 */
import { browser } from 'wxt/browser';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const ask = (op: string, extra: object = {}) => browser.runtime.sendMessage({ op, ...extra }) as Promise<any>;

function siteOf(url: string) { try { return new URL(url).hostname; } catch { return ''; } }

async function render() {
    const s = await ask('state');
    $('dot').className = `dot ${s.status}`;
    $('statusText').textContent = s.paired ? `Paired · ${s.status}` : `Not paired · ${s.status}`;
    ($('keeper') as HTMLInputElement).placeholder = s.keeperUrl;
    const pairBox = $('pairBox');
    pairBox.hidden = s.paired;
    $('code').textContent = s.code;

    const sites = new Set<string>(s.sites);
    const box = $('tabs');
    box.textContent = '';
    for (const t of s.tabs) {
        const row = document.createElement('div');
        row.className = 'tab';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!t.on;
        cb.onchange = async () => { await ask('toggleTab', { id: t.id, on: cb.checked }); render(); };
        const label = document.createElement('div');
        label.className = 't';
        label.textContent = t.title || t.url || `tab ${t.id}`;
        label.title = t.url || '';
        const site = siteOf(t.url || '');
        const siteBtn = document.createElement('button');
        siteBtn.className = 'site';
        siteBtn.textContent = sites.has(site) ? `✓ ${site}` : `allow ${site}`;
        siteBtn.disabled = !site;
        siteBtn.onclick = async () => { await ask('allowSite', { site, on: !sites.has(site) }); render(); };
        row.append(cb, label, siteBtn);
        box.append(row);
    }
}

$('saveKeeper').onclick = async () => { const url = ($('keeper') as HTMLInputElement).value.trim(); await ask('setKeeper', { url }); setTimeout(render, 200); };
$('repair').onclick = async () => { await ask('repair'); setTimeout(render, 200); };

render();
setInterval(render, 2000);
