/* THE BACKGROUND: it holds the link to the keeper, the grants, and the browser
 * work the pure protocol maps onto. The popup talks to it; the keeper calls it
 * over the WebSocket. Nothing here is specific to Chrome or Firefox — WXT builds
 * both from this one file.
 *
 * The verbs act ONLY on tabs the person granted (lib/scope.js), and a badge and
 * a red border show on a tab while the agent acts in it (the visible-indicator
 * requirement). The pairing token is kept in extension storage and never logged.
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { grants as makeGrants } from '../lib/scope.js';
import { dispatch } from '../lib/protocol.js';
import { createLink } from '../lib/link.js';

/* 4190 (the keeper's page port) is a port browsers refuse (ERR_UNSAFE_PORT),
 * so the browser endpoint is served on a browser-safe port instead; run
 * `tether serve --browser --port 8787`. The person may change this in the popup. */
const DEFAULT_KEEPER = 'ws://127.0.0.1:8787/browser';
const CONSOLE_MAX = 200;

export default defineBackground(() => {
    let grants = makeGrants({});
    let keeperUrl = DEFAULT_KEEPER;
    let token: string | null = null;
    let pairingCode = String(Math.floor(100000 + Math.random() * 900000));
    let lastTab: number | null = null;
    const consoles = new Map<number, string[]>(); // tabId -> recent console lines

    /* ---- storage ---- */
    async function load() {
        const s = await browser.storage.local.get(['grants', 'keeperToken', 'keeperUrl']);
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
        async eval(tabId: number, script: string) {
            const r = await inPage(Number(tabId), (code: string) => {
                try { const v = (0, eval)(code); return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); } catch (e: any) { return `error: ${e?.message ?? e}`; }
            }, [script]);
            lastTab = Number(tabId);
            return text(String(r ?? 'undefined'));
        },
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
            lastTab = Number(tabId);
            return text(String(r));
        },
        async type(tabId: number, a: { text: string; selector?: string }) {
            const r = await inPage(Number(tabId), (sel: string, value: string) => {
                const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLInputElement | HTMLElement | null;
                if (!el) return 'no field to type in';
                if ('value' in (el as any)) { (el as HTMLInputElement).focus(); (el as HTMLInputElement).value += value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
                else { (el as HTMLElement).focus(); for (const ch of value) el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true })); }
                return 'typed';
            }, [a.selector ?? '', a.text]);
            lastTab = Number(tabId);
            return text(String(r));
        },
        async key(tabId: number, a: { key: string; selector?: string }) {
            const r = await inPage(Number(tabId), (sel: string, key: string) => {
                const parts = key.split('+'); const main = parts.pop() as string;
                const mods = { ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt'), metaKey: parts.includes('meta') };
                const el = (sel ? document.querySelector(sel) : document.activeElement) as HTMLElement | null ?? document.body;
                for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: main, bubbles: true, ...mods }));
                return `pressed ${key}`;
            }, [a.selector ?? '', a.key]);
            lastTab = Number(tabId);
            return text(String(r));
        },
        async scroll(tabId: number, a: { dx?: number; dy?: number; selector?: string }) {
            const r = await inPage(Number(tabId), (sel: string, dx: number, dy: number) => {
                const el = sel ? document.querySelector(sel) as HTMLElement : null;
                if (el) el.scrollBy(dx, dy); else window.scrollBy(dx, dy);
                return `scrolled ${dx},${dy}`;
            }, [a.selector ?? '', a.dx ?? 0, a.dy ?? 0]);
            lastTab = Number(tabId);
            return text(String(r));
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
            lastTab = Number(tabId);
            return text(String(r));
        },
    };

    /* ---- the link (rebuilt when the keeper URL changes) ---- */
    let link = makeLink();
    function makeLink() {
        return createLink({
            url: keeperUrl,
            getToken: () => token,
            setToken: (t: string) => { token = t; browser.storage.local.set({ keeperToken: t }); },
            pairingCode: () => pairingCode,
            onCall: (m: any) => dispatch(m, { grants, actions, mark: mark as any }),
            onStatus: () => { /* the popup reads status on demand */ },
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
                        keeperUrl, paired: !!token, code: pairingCode,
                        sites: grants.siteList(),
                        tabs: all.filter((t) => t.id !== undefined).map((t) => ({ id: t.id, title: t.title, url: t.url, granted: grants.isGranted(t.id!, t.url), on: grants.tabOn(t.id!) })),
                    });
                    break;
                }
                case 'toggleTab': grants.setTab(msg.id, msg.on); await saveGrants(); await pushTabs(); reply({ ok: true }); break;
                case 'allowSite': grants.allowSite(msg.site, msg.on); await saveGrants(); await pushTabs(); reply({ ok: true }); break;
                case 'setKeeper': keeperUrl = msg.url || DEFAULT_KEEPER; await browser.storage.local.set({ keeperUrl }); restart(); reply({ ok: true }); break;
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
    browser.tabs.onRemoved.addListener((id) => { consoles.delete(id); grants.forget(id); });
    browser.tabs.onUpdated.addListener(() => { pushTabs().catch(() => {}); });

    /* Load the stored grants, token and keeper URL, then open the link. */
    (async () => { await load(); restart(); await pushTabs(); })();
});
