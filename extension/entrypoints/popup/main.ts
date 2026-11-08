/* THE POPUP: the person's control. Not paired: one field for the line Clavarium
 * gives. Paired: one block per Clavarium (0.1.64), each with one switch per tab
 * (given or not), its « Tout donner », the "also the windows it opens" option under
 * a tab it holds, and its « Retirer l'association » (a second click confirms). A tab
 * another Clavarium holds says « donné à <host> », its switch disabled. Below the
 * blocks, « Ajouter un Clavarium » opens the field again. With one pairing there is
 * no block heading: the host stays in the top line, as before. What it lists is decided in
 * lib/popup.js; it only reads and changes grants in the background and holds no
 * connection and no token. Its words come from _locales (French or English).
 */
import { browser } from 'wxt/browser';
import { rows, master, masterFlip, givenCount, blockTabs } from '../../lib/popup.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const ask = (op: string, extra: object = {}) => browser.runtime.sendMessage({ op, ...extra }) as Promise<any>;
const say = (key: string, subs?: string[]) => browser.i18n.getMessage(key as any, subs) || key;
const SELF = browser.runtime.getURL('/' as any);

let confirming: string | null = null;     // the pairing whose « Retirer » waits for its second click
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
let adding = false;

for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = say(el.dataset.i18n!);
($('config') as HTMLInputElement).placeholder = say('pastePlaceholder');
document.documentElement.lang = browser.i18n.getUILanguage().startsWith('fr') ? 'fr' : 'en';

function sw(checked: boolean, onchange: (on: boolean) => void, label: string, disabled = false) {
    const box = document.createElement('label');
    box.className = 'sw';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked; cb.disabled = disabled; cb.setAttribute('aria-label', label);
    cb.onchange = () => onchange(cb.checked);
    box.append(cb, document.createElement('span'));
    return box;
}
function line(cls: string, text: string, title = '') {
    const el = document.createElement('span');
    el.className = cls; el.textContent = text; if (title) el.title = title;
    return el;
}

const dotOf = (status: string) => ['ready', 'connected'].includes(status) ? 'on' : ['connecting', 'pairing'].includes(status) ? 'wait' : '';
const wordOf = (dot: string) => say(dot === 'on' ? 'statusReady' : dot === 'wait' ? 'statusConnecting' : 'statusDown');

/* One Clavarium's block: its tabs, its « Tout donner », its count and its « Retirer l'association ». */
function block(p: any, tabs: any[], hosts: Record<string, string>, heading: boolean) {
    const el = document.createElement('div');
    el.className = 'block';
    if (heading) {
        const h = document.createElement('div');
        h.className = 'bhead';
        const d = dotOf(String(p.status ?? ''));
        const dot = Object.assign(document.createElement('span'), { className: `dot ${d}`, title: wordOf(d) });
        h.append(dot, line('', p.host, p.url));
        el.append(h);
    }
    const list = rows(blockTabs(tabs, p.id, hosts), SELF);
    const ask1 = (op: string, extra: object) => ask(op, { pid: p.id, ...extra });
    if (!list.length) el.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: say('noTabs') }));
    else {
        /* The list's own header, not a row: « Onglets » on the left, « Tout donner » and the master switch on the right
           (on only when every tab not held elsewhere is given to this one), the warning under it. */
        const free = list.some((r: any) => !r.heldBy);
        const h = document.createElement('div');
        h.className = 'lhead';
        const right = document.createElement('span');
        right.className = 'master';
        if (free) right.append(line('', say('giveAll')), sw(master(list) === 'all', async () => {
            const { on, ids } = masterFlip(list);
            await ask1('setTabs', { ids, on }); render();
        }, say('giveAll')));
        h.append(line('ltitle', say('tabsTitle')), right);
        el.append(h);
        if (free) el.append(line('warn', say('giveAllNote')));
    }
    for (const r of list) {
        const row = document.createElement('div');
        row.className = r.heldBy ? 'tab held' : 'tab';
        /* The title is cut, never its « (2) »: that is what tells two same-titled tabs apart. */
        const name = document.createElement('span');
        name.className = 'name'; name.title = r.url;
        name.append(line('t', r.base), ...(r.num ? [line('n', r.num.trim())] : []));
        row.append(name, sw(r.given, async (on) => { await ask1('toggleTab', { id: r.id, on }); render(); }, r.label, !!r.heldBy),
            r.heldBy ? line('s', say('heldBy', [r.heldBy])) : line('s', r.site, r.url));
        if (r.openedBy && !r.heldBy) row.append(line('s', say('openedBy', [r.openedBy])));
        /* A given tab may also give the tabs and windows it opens, to this same Clavarium (one level; unticking takes nothing back). */
        if (r.showInherit) {
            const opt = document.createElement('label');
            opt.className = 'more';
            const ib = document.createElement('input');
            ib.type = 'checkbox'; ib.checked = r.inherit;
            ib.onchange = async () => { await ask1('setInherit', { id: r.id, on: ib.checked }); render(); };
            opt.append(ib, say('inherit'));
            row.append(opt);
        }
        el.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'foot';
    const n = givenCount(list);
    const un = document.createElement('button');
    un.type = 'button';
    const sure = confirming === p.id;
    un.textContent = say(sure ? 'unpairConfirm' : 'unpair');
    un.className = sure ? 'sure' : '';
    /* « Retirer l'association »: a first click asks « Retirer ? » here; the second one removes this Clavarium only. */
    un.onclick = async () => {
        clearTimeout(confirmTimer);
        if (!sure) { confirming = p.id; confirmTimer = setTimeout(() => { confirming = null; render(); }, 4000); render(); return; }
        confirming = null;
        await ask1('unpair', {});
        render();
    };
    foot.append(line('', say(n === 1 ? 'countOne' : 'countMany', [String(n)])), un);
    el.append(foot);
    return el;
}

async function render() {
    const s = await ask('state');
    const all: any[] = s.pairings ?? [];
    const paired = all.filter((p) => p.paired);
    const claiming = all.some((p) => p.claiming);
    const one = paired.length === 1 ? paired[0] : null;
    const d = one ? dotOf(String(one.status ?? '')) : (claiming ? 'wait' : '');
    $('dot').className = `dot ${d}`;
    $('dot').hidden = paired.length > 1;
    $('state').textContent = one ? one.host : paired.length ? '' : say('notPaired');
    $('state').title = one ? wordOf(d) : '';
    /* A line pasted and now paired: the field closes again. */
    if (!claiming && !s.refused && $('pasteSaid').textContent === say('pairing')) { $('pasteSaid').textContent = ''; adding = false; }
    if (s.refused) $('pasteSaid').textContent = say('refused');
    else if (claiming) $('pasteSaid').textContent = say('pairing');
    $('pairedBox').hidden = !paired.length;
    const showPaste = !paired.length || adding || claiming || !!s.refused;
    $('pasteBox').hidden = !showPaste;
    $('add').hidden = showPaste;
    if (!paired.length) return;

    const hosts = Object.fromEntries(all.map((p) => [p.id, p.host]));
    const box = $('blocks');
    box.textContent = '';
    for (const p of paired) box.append(block(p, s.tabs ?? [], hosts, paired.length > 1));
}

$('add').onclick = () => { adding = true; $('pasteSaid').textContent = ''; render().then(() => ($('config') as HTMLInputElement).focus()); };
$('paste').onclick = async () => {
    const r = await ask('paste', { text: ($('config') as HTMLInputElement).value });
    $('pasteSaid').textContent = r.ok ? say('pairing') : r.error;
    if (r.ok) ($('config') as HTMLInputElement).value = '';
    setTimeout(render, 300);
};

render();
setInterval(render, 2000);
