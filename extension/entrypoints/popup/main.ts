/* THE POPUP: the person's control. Not paired: one field for the line Clavarium
 * gives. Paired: one switch per tab (given or not), « Tout donner » for all, the
 * "also the windows it opens" option under a given tab, and « Retirer
 * l'association » (a second click confirms). What it lists is decided in
 * lib/popup.js; it only reads and changes grants in the background and holds no
 * connection and no token. Its words come from _locales (French or English).
 */
import { browser } from 'wxt/browser';
import { rows, master, masterFlip, givenCount, siteOf } from '../../lib/popup.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const ask = (op: string, extra: object = {}) => browser.runtime.sendMessage({ op, ...extra }) as Promise<any>;
const say = (key: string, subs?: string[]) => browser.i18n.getMessage(key as any, subs) || key;
const SELF = browser.runtime.getURL('/' as any);

let confirming = false;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = say(el.dataset.i18n!);
($('config') as HTMLInputElement).placeholder = say('pastePlaceholder');
document.documentElement.lang = browser.i18n.getUILanguage().startsWith('fr') ? 'fr' : 'en';

function sw(checked: boolean, onchange: (on: boolean) => void, label: string) {
    const box = document.createElement('label');
    box.className = 'sw';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked; cb.setAttribute('aria-label', label);
    cb.onchange = () => onchange(cb.checked);
    box.append(cb, document.createElement('span'));
    return box;
}
function line(cls: string, text: string, title = '') {
    const el = document.createElement('span');
    el.className = cls; el.textContent = text; if (title) el.title = title;
    return el;
}

async function render() {
    const s = await ask('state');
    const paired = !!s.paired;
    const status = String(s.status ?? '');
    const dot = ['ready', 'connected'].includes(status) ? 'on' : ['connecting', 'pairing'].includes(status) ? 'wait' : '';
    $('dot').className = `dot ${paired ? dot : (s.claiming ? 'wait' : '')}`;
    const stateWord = dot === 'on' ? 'statusReady' : dot === 'wait' ? 'statusConnecting' : 'statusDown';
    $('state').textContent = paired ? siteOf(s.keeperUrl) : say('notPaired');
    $('state').title = paired ? say(stateWord) : '';
    $('pasteBox').hidden = paired;
    $('pairedBox').hidden = !paired;
    if (!paired) {
        if (status === 'refused') $('pasteSaid').textContent = say('refused');
        else if (s.claiming) $('pasteSaid').textContent = say('pairing');
        return;
    }

    const list = rows(s.tabs, SELF);
    const box = $('tabs');
    box.textContent = '';
    if (!list.length) box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: say('noTabs') }));
    else {
        /* « Tout donner »: on only when every listed tab is given. */
        const all = document.createElement('div');
        all.className = 'tab all';
        all.append(line('t', say('giveAll')), sw(master(list) === 'all', async () => {
            const { on, ids } = masterFlip(list);
            await ask('setTabs', { ids, on }); render();
        }, say('giveAll')), line('s', say('giveAllNote')));
        box.append(all);
    }
    for (const r of list) {
        const row = document.createElement('div');
        row.className = 'tab';
        /* The title is cut, never its « (2) »: that is what tells two same-titled tabs apart. */
        const name = document.createElement('span');
        name.className = 'name'; name.title = r.url;
        name.append(line('t', r.base), ...(r.num ? [line('n', r.num.trim())] : []));
        row.append(name, sw(r.given, async (on) => { await ask('toggleTab', { id: r.id, on }); render(); }, r.label), line('s', r.site, r.url));
        if (r.openedBy) row.append(line('s', say('openedBy', [r.openedBy])));
        /* A given tab may also give the tabs and windows it opens (one level; unticking takes nothing back). */
        if (r.showInherit) {
            const opt = document.createElement('label');
            opt.className = 'more';
            const ib = document.createElement('input');
            ib.type = 'checkbox'; ib.checked = r.inherit;
            ib.onchange = async () => { await ask('setInherit', { id: r.id, on: ib.checked }); render(); };
            opt.append(ib, say('inherit'));
            row.append(opt);
        }
        box.append(row);
    }
    const n = givenCount(list);
    $('count').textContent = say(n === 1 ? 'countOne' : 'countMany', [String(n)]);
    const un = $('unpair');
    un.textContent = say(confirming ? 'unpairConfirm' : 'unpair');
    un.className = confirming ? 'sure' : '';
}

$('paste').onclick = async () => {
    const r = await ask('paste', { text: ($('config') as HTMLInputElement).value });
    $('pasteSaid').textContent = r.ok ? say('pairing') : r.error;
    if (r.ok) ($('config') as HTMLInputElement).value = '';
    setTimeout(render, 300);
};
/* « Retirer l'association »: a first click asks « Retirer ? » here; the second one does it. */
$('unpair').onclick = async () => {
    clearTimeout(confirmTimer);
    if (!confirming) { confirming = true; confirmTimer = setTimeout(() => { confirming = false; render(); }, 4000); render(); return; }
    confirming = false;
    await ask('unpair');
    $('pasteSaid').textContent = '';
    render();
};

render();
setInterval(render, 2000);
