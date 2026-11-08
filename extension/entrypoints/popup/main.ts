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
    pairBox.hidden = s.paired || s.claiming;
    $('pasteBox').hidden = s.paired;
    if (s.status === 'refused') $('pasteSaid').textContent = 'That configuration was refused (spent or expired): make a new one.';
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
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = t.title || t.url || `tab ${t.id}`;
        name.title = t.url || '';
        label.append(name);
        if (t.openedBy) {
            const by = document.createElement('div');
            by.className = 'sub';
            by.textContent = `opened by ${t.openedBy}`;
            label.append(by);
        }
        /* A granted tab may also grant the tabs and windows it opens (one level; unticking takes nothing back). */
        if (t.granted) {
            const opt = document.createElement('label');
            opt.className = 'sub';
            opt.title = 'Tabs and windows it already opened stay granted when you untick.';
            const ib = document.createElement('input');
            ib.type = 'checkbox'; ib.checked = !!t.inherit;
            ib.onchange = async () => { await ask('setInherit', { id: t.id, on: ib.checked }); render(); };
            opt.append(ib, ' Also the windows it opens');
            label.append(opt);
        }
        const site = siteOf(t.url || '');
        const siteBtn = document.createElement('button');
        siteBtn.className = 'site';
        siteBtn.textContent = sites.has(site) ? `✓ ${site}` : `allow ${site}`;
        siteBtn.disabled = !site;
        siteBtn.onclick = async () => { await ask('allowSite', { site, on: !sites.has(site) }); render(); };
        row.append(cb, label, siteBtn);
        box.append(row);
    }
    $('inheritHint').hidden = !s.tabs.some((t: any) => t.inherit);
}

$('paste').onclick = async () => {
    const r = await ask('paste', { text: ($('config') as HTMLInputElement).value });
    $('pasteSaid').textContent = r.ok ? 'Pairing…' : r.error;
    if (r.ok) ($('config') as HTMLInputElement).value = '';
    setTimeout(render, 300);
};
$('saveKeeper').onclick = async () => { const url = ($('keeper') as HTMLInputElement).value.trim(); await ask('setKeeper', { url }); setTimeout(render, 200); };
$('repair').onclick = async () => { await ask('repair'); setTimeout(render, 200); };

render();
setInterval(render, 2000);
