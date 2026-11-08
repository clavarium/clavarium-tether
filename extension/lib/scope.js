/* WHAT THE AGENT MAY TOUCH: the grants the person set in the popup. A tab is
 * granted one of two ways — the person flipped that one tab on, or the person
 * allowed its whole site. Nothing else is reachable.
 *
 * A granted tab may also pass its right to the tabs and windows IT opens (the
 * "Also the windows it opens" option: Colab opening a Google sign-in popup).
 * Each such child is granted by its own id and remembers its opener. One level
 * only: a child passes nothing on unless the person ticks the option on it too.
 * Turning the option off takes back nothing already granted. This is the extension's
 * own lock; the keeper holds the same set and refuses on its side too.
 *
 * Pure: no browser API, no storage. The background loads it from storage and
 * saves `toJSON()` back; the popup reads and changes it. Framework-free ESM so
 * the unit tests run it with nothing built.
 */
export function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
export function normalSite(site) {
    return String(site ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

export function grants(initial = {}) {
    const tabs = new Set((initial.tabs ?? []).map(String));   // tab ids the person turned on
    const sites = new Set((initial.sites ?? []).map(normalSite).filter(Boolean));
    const inherit = new Set((initial.inherit ?? []).map(String));  // tab ids whose children are granted too
    const parents = new Map(Object.entries(initial.parents ?? {}).map(([c, p]) => [String(c), String(p)])); // child -> opener

    const siteAllowed = (url) => {
        const h = hostOf(url);
        if (!h) return false;
        for (const s of sites) if (h === s || h.endsWith(`.${s}`)) return true;
        return false;
    };

    return {
        /* Turn one tab on or off. */
        setTab(id, on) { const k = String(id); if (on) tabs.add(k); else { tabs.delete(k); inherit.delete(k); parents.delete(k); } },
        grantTab(id) { tabs.add(String(id)); },
        forget(id) {
            const k = String(id); tabs.delete(k); inherit.delete(k); parents.delete(k);
            for (const [c, p] of parents) if (p === k) parents.delete(c);
        },
        /* The option: this tab's children (by openerTabId) are granted too. */
        setInherit(id, on) { const k = String(id); if (on) inherit.add(k); else inherit.delete(k); },
        inherits(id) { return inherit.has(String(id)); },
        /* A new tab or window opened by `openerId`: granted, by id, when the opener has the option on.
           The child's own option stays off, so the right goes one level deep only. */
        adopt(childId, openerId) {
            if (openerId === undefined || openerId === null || !inherit.has(String(openerId))) return false;
            const c = String(childId);
            if (c === String(openerId)) return false;
            tabs.add(c); parents.set(c, String(openerId));
            return true;
        },
        parentOf(id) { return parents.get(String(id)) ?? null; },
        /* Allow or drop a whole site (every tab on it is then reachable). */
        allowSite(site, on = true) { const s = normalSite(site); if (!s) return; if (on) sites.add(s); else sites.delete(s); },
        siteAllowed,
        /* Is this tab reachable by the agent? Its id on, or its site allowed. */
        isGranted(id, url) { return tabs.has(String(id)) || siteAllowed(url); },
        tabOn(id) { return tabs.has(String(id)); },
        tabIds() { return [...tabs]; },
        siteList() { return [...sites]; },
        toJSON() { return { tabs: [...tabs], sites: [...sites], inherit: [...inherit], parents: Object.fromEntries(parents) }; },
    };
}

/* The handler for browser.tabs.onCreated: a child of a tab with the option on is
 * granted, kept, and told to the keeper at once (so browser-tabs shows it).
 * Chrome sets openerTabId on popup windows from window.open too (checked on
 * Chromium, 08-11), so no windows.onCreated fallback is needed. */
export function onTabCreated({ grants: g, save, push }) {
    return async (tab) => {
        if (tab?.id === undefined || !g.adopt(tab.id, tab.openerTabId)) return false;
        await save(); await push();
        return true;
    };
}
