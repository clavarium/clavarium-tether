/* THE BACKGROUND: it holds the link to the keeper, the grants, and the browser
 * work the pure protocol maps onto. The popup talks to it; the keeper calls it
 * over the WebSocket. WXT builds both browsers from this one file; only
 * chrome.debugger, where it exists, makes a difference.
 *
 * The verbs act ONLY on tabs the person granted (lib/scope.js), and a badge and
 * a red border show on a tab while the agent acts in it (the visible-indicator
 * requirement). The pairing token is kept in extension storage and never logged.
 *
 * On Chrome the acting verbs are REAL input, through the debugging protocol
 * (lib/cdp.js): Chrome shows its "is debugging this browser" banner while the
 * agent acts, detached after 30 s idle. Firefox has no debugger API and keeps
 * synthetic DOM events (lib/act.js decides).
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { grants as makeGrants, onTabCreated } from '../lib/scope.js';
import { dispatch } from '../lib/protocol.js';
import { createLink, readConfig } from '../lib/link.js';
import { createDriver } from '../lib/cdp.js';
import { makeActs } from '../lib/act.js';

/* 4190 (the keeper's page port) is a port browsers refuse (ERR_UNSAFE_PORT),
 * so the browser endpoint is served on a browser-safe port instead; run
 * `tether serve --browser --port 8787`. The person may change this in the popup. */
const DEFAULT_KEEPER = 'ws://127.0.0.1:8787/browser';
const CONSOLE_MAX = 200;

export default defineBackground(() => {
    let grants = makeGrants({});
    let keeperUrl = DEFAULT_KEEPER;
    let token: string | null = null;
    let pairKey: string | null = null;     // a one-time key pasted in the popup, until it is swapped for a token
    let pairingCode = String(Math.floor(100000 + Math.random() * 900000));
    let lastTab: number | null = null;
    const consoles = new Map<number, string[]>(); // tabId -> recent console lines

    /* ---- storage ---- */
    async function load() {
        const s = await browser.storage.local.get(['grants', 'keeperToken', 'keeperUrl', 'pairKey']);
        pairKey = (s.pairKey as string) ?? null;
        grants = makeGrants((s.grants as object) ?? {});
        token = (s.keeperToken as string) ?? null;
        keeperUrl = (s.keeperUrl as string) ?? DEFAULT_KEEPER;
    }
    const saveGrants = () => browser.storage.local.set({ grants: grants.toJSON() });

    /* ---- the indicator: a badge, and a red border injected into the page ---- */
    async function mark(tabId: number) {
        const id = Number(tabId);
        try { await browser.action.setBadgeText({ tabId: id, text: '●' }); await browser.action.setBadgeBackgroundColor({ tabId: id, color: '#d33' }); } catch { /* no action on some pages */ }
        try {
            await browser.scripting.executeScript({
                target: { tabId: id },
                func: () => {
                    let el = document.getElementById('__tether_acting__');
                    if (!el) { el = document.createElement('div'); el.id = '__tether_acting__'; el.style.cssText = 'position:fixed;inset:0;border:3px solid #d33;pointer-events:none;z-index:2147483647'; document.documentElement.appendChild(el); }
                },
            });
        } catch { /* a page that forbids scripts */ }
        return async () => {
            try { await browser.action.setBadgeText({ tabId: id, text: '' }); } catch { /* idem */ }
            try { await browser.scripting.executeScript({ target: { tabId: id }, func: () => document.getElementById('__tether_acting__')?.remove() }); } catch { /* idem */ }
        };
    }

    /* ---- run one snippet in a tab's own world and get its last value ---- */
    async function inPage<T>(tabId: number, func: (...a: any[]) => T, args: any[] = []): Promise<T> {
        const [res] = await browser.scripting.executeScript({ target: { tabId: Number(tabId) }, world: 'MAIN', func: func as any, args });
        return (res?.result as T);
    }

    /* ---- the page work under lib/act.js: points, focus, the synthetic hand, a script, files ---- */
    const synthetic = {
        async click(tabId: number, a: { selector?: string; x?: number; y?: number; button?: string }) {
            const r = await inPage(Number(tabId), (sel: string, x: number, y: number) => {
                const el = sel ? document.querySelector(sel) as HTMLElement : (document.elementFromPoint(x, y) as HTMLElement);
                if (!el) return 'nothing to click';
                const rect = el.getBoundingClientRect();
                const cx = sel ? rect.left + rect.width / 2 : x; const cy = sel ? rect.top + rect.height / 2 : y;
                for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
                if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
                return 'clicked';
            }, [a.selector ?? '', a.x ?? 0, a.y ?? 0]);
            return String(r);
        },
        async type(tabId: number, a: { text: string; selector?: string }) {
            const r = await inPage(Number(tabId), (sel: string, value: string) => {
                const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLInputElement | HTMLElement | null;
                if (!el) return 'no field to type in';
                if ('value' in (el as any)) { (el as HTMLInputElement).focus(); (el as HTMLInputElement).value += value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
                else { (el as HTMLElement).focus(); for (const ch of value) el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true })); }
                return 'typed';
            }, [a.selector ?? '', a.text]);
            return String(r);
        },
        async key(tabId: number, a: { key: string; selector?: string }) {
            const r = await inPage(Number(tabId), (sel: string, key: string) => {
                const parts = key.split('+'); const main = parts.pop() as string;
                const mods = { ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt'), metaKey: parts.includes('meta') };
                const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLElement | null ?? document.body;
                for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: main, bubbles: true, ...mods }));
                return `pressed ${key}`;
            }, [a.selector ?? '', a.key]);
            return String(r);
        },
        async scroll(tabId: number, a: { dx?: number; dy?: number; selector?: string }) {
            const r = await inPage(Number(tabId), (sel: string, dx: number, dy: number) => {
                const el = sel ? document.querySelector(sel) as HTMLElement : null;
                if (el) el.scrollBy(dx, dy); else window.scrollBy(dx, dy);
                return `scrolled ${dx},${dy}`;
            }, [a.selector ?? '', a.dx ?? 0, a.dy ?? 0]);
            return String(r);
        },
        async drag(tabId: number, a: { from: string; to: string }) {
            const r = await inPage(Number(tabId), (from: string, to: string) => {
                const point = (s: string) => { const el = document.querySelector(s) as HTMLElement | null; if (el) { const r2 = el.getBoundingClientRect(); return { el, x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 }; } const [x = 0, y = 0] = s.split(',').map(Number); return { el: document.elementFromPoint(x, y) as HTMLElement, x, y }; };
                const a1 = point(from); const b1 = point(to);
                if (!a1.el) return 'nothing to drag';
                a1.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: a1.x, clientY: a1.y }));
                (b1.el ?? a1.el).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b1.x, clientY: b1.y }));
                (b1.el ?? a1.el).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b1.x, clientY: b1.y }));
                return `dragged ${from} to ${to}`;
            }, [a.from, a.to]);
            return String(r);
        },
    };
    const page = {
        synthetic,
        async point(tabId: number, where: string) {
            return inPage(tabId, (s: string) => {
                const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
                if (m) return { x: Number(m[1]), y: Number(m[2]) };
                let el: Element | null = null;
                try { el = document.querySelector(s); } catch { return { error: `not a selector: ${s}` }; }
                if (!el) return { error: `no element ${s}` };
                let r = el.getBoundingClientRect();
                if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) { el.scrollIntoView({ block: 'center', inline: 'center' }); r = el.getBoundingClientRect(); }
                if (r.width === 0 && r.height === 0) return { error: `${s} is not visible` };
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }, [String(where ?? '')]);
        },
        async centre(tabId: number) { return inPage(tabId, () => ({ x: innerWidth / 2, y: innerHeight / 2 })); },
        async focus(tabId: number, selector: string) {
            return inPage(tabId, (s: string) => { const el = document.querySelector(s) as HTMLElement | null; if (!el) return false; el.scrollIntoView?.({ block: 'nearest' }); el.focus(); return true; }, [selector]);
        },
        async evalScript(tabId: number, script: string) {
            return inPage(tabId, (code: string) => {
                try { const v = (0, eval)(code); return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); } catch (e: any) { return `error: ${e?.name === 'EvalError' ? 'EvalError: ' : ''}${e?.message ?? e}`; }
            }, [script]);
        },
        /* A File made in the page from the bytes, set on the input through a DataTransfer (a drop on a drop zone). */
        async setFiles(tabId: number, selector: string, b64: string, name: string, mime: string) {
            return inPage(tabId, (s: string, data: string, fileName: string, type: string) => {
                const el = document.querySelector(s) as HTMLElement | null;
                if (!el) return `no element ${s}`;
                const bin = atob(data); const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const file = new File([bytes], fileName, { type });
                const dt = new DataTransfer(); dt.items.add(file);
                const input = (el instanceof HTMLInputElement && el.type === 'file' ? el : el.querySelector('input[type=file]')) as HTMLInputElement | null;
                if (input) {
                    input.files = dt.files;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return `uploaded ${fileName} (${bytes.length} bytes) to ${s}`;
                }
                for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
                return `dropped ${fileName} (${bytes.length} bytes) on ${s}`;
            }, [selector, b64, name, mime]);
        },
    };
    /* Chrome has chrome.debugger (real input, see lib/cdp.js); Firefox has none and acts synthetically. */
    const driver = createDriver({ dbg: (globalThis as any).chrome?.debugger });
    const acts = makeActs({ driver, page });

    /* ---- the browser work the protocol maps onto ---- */
    const text = (t: string, size?: number) => ({ text: t, size: size ?? new TextEncoder().encode(t).length });
    const actions = {
        async tabs() {
            const all = await browser.tabs.query({});
            const on = all.filter((t) => t.id !== undefined && grants.isGranted(t.id, t.url));
            const lines = on.map((t) => `${t.id}  ${t.title ?? '(no title)'}  ${t.url ?? ''}`.trim());
            return text(lines.length ? lines.join('\n') : 'No tab granted to the agent.', on.length);
        },
        async openTab(url: string) {
            const t = await browser.tabs.create({ url });
            if (t.id !== undefined) { grants.grantTab(t.id); lastTab = t.id; await saveGrants(); await pushTabs(); }
            return { ...text(`opened ${url} in a new tab (${t.id})`), tabId: t.id };
        },
        async activeGrantedTab() {
            if (lastTab !== null) { try { const t = await browser.tabs.get(lastTab); if (t && grants.isGranted(t.id!, t.url)) return t.id!; } catch { /* gone */ } }
            const [active] = await browser.tabs.query({ active: true, currentWindow: true });
            if (active?.id !== undefined && grants.isGranted(active.id, active.url)) return active.id;
            const all = await browser.tabs.query({});
            const t = all.find((x) => x.id !== undefined && grants.isGranted(x.id, x.url));
            return t?.id ?? null;
        },
        async tabInfo(tabId: number) { try { const t = await browser.tabs.get(Number(tabId)); return { url: t.url ?? '', title: t.title ?? '' }; } catch { return null; } },
        async navigate(tabId: number, url: string) { await browser.tabs.update(Number(tabId), { url }); lastTab = Number(tabId); return text(`went to ${url}`); },
        async shot(tabId: number) {
            const t = await browser.tabs.get(Number(tabId));
            await browser.tabs.update(Number(tabId), { active: true });
            const data = await browser.tabs.captureVisibleTab(t.windowId!, { format: 'png' });
            lastTab = Number(tabId);
            return text(data, data.length);
        },
        async html(tabId: number, a: { selector?: string; readable?: boolean }) {
            const html = await inPage(Number(tabId), (sel: string, readable: boolean) => {
                const node = sel ? document.querySelector(sel) : document.documentElement;
                if (!node) return `(no element ${sel})`;
                return readable ? (node as HTMLElement).innerText : (node as HTMLElement).outerHTML;
            }, [a.selector ?? '', !!a.readable]);
            lastTab = Number(tabId);
            return text(String(html ?? ''));
        },
        async console(tabId: number, a: { lines?: number }) {
            const buf = consoles.get(Number(tabId)) ?? [];
            const n = Math.max(1, Math.min(CONSOLE_MAX, a.lines ?? 40));
            const out = buf.slice(-n).join('\n');
            return text(out || '(no console messages captured)');
        },
        async eval(tabId: number, script: string) { lastTab = Number(tabId); return text(String(await acts.eval(Number(tabId), script) ?? 'undefined')); },
        async click(tabId: number, a: any) { lastTab = Number(tabId); return text(await acts.click(Number(tabId), a)); },
        async type(tabId: number, a: any) { lastTab = Number(tabId); return text(await acts.type(Number(tabId), a)); },
        async key(tabId: number, a: any) { lastTab = Number(tabId); return text(await acts.key(Number(tabId), a)); },
        async scroll(tabId: number, a: any) { lastTab = Number(tabId); return text(await acts.scroll(Number(tabId), a)); },
        async drag(tabId: number, a: any) { lastTab = Number(tabId); return text(await acts.drag(Number(tabId), a)); },
        async upload(tabId: number, a: any) { lastTab = Number(tabId); return text(await acts.upload(Number(tabId), a)); },
    };

    /* ---- the link (rebuilt when the keeper URL changes) ---- */
    let link = makeLink();
    function makeLink() {
        return createLink({
            url: keeperUrl,
            getToken: () => token,
            setToken: (t: string) => { token = t; browser.storage.local.set({ keeperToken: t }); },
            pairingCode: () => pairingCode,
            getPairKey: () => pairKey,
            clearPairKey: () => { pairKey = null; browser.storage.local.remove('pairKey'); },
            onCall: (m: any) => dispatch(m, { grants, actions, mark: mark as any }),
            /* The popup reads status on demand. Once the keeper says welcome (or paired), the granted tabs are said again:
               a keeper that restarted knows none (08-11, found on a real browser: "no tab granted" while the popup showed them ticked). */
            onStatus: (s: string) => { if (s === 'ready') pushTabs().catch(() => {}); },
        });
    }
    function restart() { try { link.stop(); } catch { /* idle */ } link = makeLink(); link.start(); }

    async function pushTabs() {
        const all = await browser.tabs.query({});
        const tabs = all.filter((t) => t.id !== undefined && grants.isGranted(t.id, t.url)).map((t) => ({ id: t.id, url: t.url ?? '', title: t.title ?? '', site: (() => { try { return new URL(t.url ?? '').hostname; } catch { return ''; } })() }));
        link.send({ t: 'tabs', tabs });
    }

    /* ---- popup <-> background ---- */
    browser.runtime.onMessage.addListener((msg: any, _sender, reply) => {
        (async () => {
            switch (msg?.op) {
                case 'state': {
                    const all = await browser.tabs.query({});
                    reply({
                        status: link.status(),
                        keeperUrl, paired: !!token, code: pairingCode, claiming: !!pairKey,
                        sites: grants.siteList(),
                        tabs: all.filter((t) => t.id !== undefined).map((t) => {
                            const parent = grants.parentOf(t.id!);
                            const opener = parent === null ? undefined : all.find((x) => String(x.id) === parent);
                            return { id: t.id, title: t.title, url: t.url, granted: grants.isGranted(t.id!, t.url), on: grants.tabOn(t.id!), inherit: grants.inherits(t.id!), parent, openedBy: opener ? (opener.title || opener.url || `tab ${opener.id}`) : null };
                        }),
                    });
                    break;
                }
                case 'toggleTab': grants.setTab(msg.id, msg.on); await saveGrants(); await pushTabs(); reply({ ok: true }); break;
                /* « Tout donner »: many tabs at once, one save, one push. */
                case 'setTabs': for (const id of msg.ids ?? []) grants.setTab(id, msg.on); await saveGrants(); await pushTabs(); reply({ ok: true }); break;
                case 'setInherit': grants.setInherit(msg.id, msg.on); await saveGrants(); reply({ ok: true }); break;
                case 'allowSite': grants.allowSite(msg.site, msg.on); await saveGrants(); await pushTabs(); reply({ ok: true }); break;
                case 'setKeeper': keeperUrl = msg.url || DEFAULT_KEEPER; await browser.storage.local.set({ keeperUrl }); restart(); reply({ ok: true }); break;
                /* The configuration copied from the keeper page: its address kept, its one-time key said once connected. */
                case 'paste': {
                    const c = readConfig(msg.text);
                    if (c.error) { reply({ ok: false, error: c.error }); break; }
                    keeperUrl = c.url; pairKey = c.key; token = null;
                    await browser.storage.local.set({ keeperUrl, pairKey });
                    await browser.storage.local.remove('keeperToken');
                    restart(); reply({ ok: true }); break;
                }
                /* « Retirer l'association »: the token and the stored address forgotten, the link closed; the popup asks for a new line. */
                case 'unpair':
                    token = null; pairKey = null; keeperUrl = DEFAULT_KEEPER;
                    await browser.storage.local.remove(['keeperToken', 'keeperUrl', 'pairKey']);
                    try { link.stop(); } catch { /* idle */ }
                    reply({ ok: true }); break;
                case 'repair': token = null; await browser.storage.local.remove('keeperToken'); pairingCode = String(Math.floor(100000 + Math.random() * 900000)); restart(); reply({ ok: true, code: pairingCode }); break;
                default: reply({ ok: false }); break;
            }
        })();
        return true; // async reply
    });

    /* console capture from the content script */
    browser.runtime.onMessage.addListener((msg: any, sender) => {
        if (msg?.op === 'console' && sender.tab?.id !== undefined) {
            const buf = consoles.get(sender.tab.id) ?? [];
            buf.push(msg.line); while (buf.length > CONSOLE_MAX) buf.shift();
            consoles.set(sender.tab.id, buf);
        }
    });
    browser.tabs.onRemoved.addListener((id) => { consoles.delete(id); grants.forget(id); driver.forget(id); });
    browser.tabs.onUpdated.addListener(() => { pushTabs().catch(() => {}); });
    /* A tab or window opened by a tab with "Also the windows it opens" on is granted too (one level). */
    /* It waits for the stored grants: a Chrome service worker may wake on this very event. */
    browser.tabs.onCreated.addListener((t) => { loaded.then(() => onTabCreated({ grants, save: saveGrants, push: pushTabs })(t)).catch(() => {}); });

    /* Load the stored grants, token and keeper URL, then open the link. */
    const loaded = load();
    (async () => { await loaded; restart(); await pushTabs(); })();
});
