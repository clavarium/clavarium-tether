/* WHAT THE AGENT MAY TOUCH: the grants the person set in the popup. A tab is
 * granted one of two ways — the person flipped that one tab on, or the person
 * allowed its whole site. Nothing else is reachable. This is the extension's
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

    const siteAllowed = (url) => {
        const h = hostOf(url);
        if (!h) return false;
        for (const s of sites) if (h === s || h.endsWith(`.${s}`)) return true;
        return false;
    };

    return {
        /* Turn one tab on or off. */
        setTab(id, on) { const k = String(id); if (on) tabs.add(k); else tabs.delete(k); },
        grantTab(id) { tabs.add(String(id)); },
        forget(id) { tabs.delete(String(id)); },
        /* Allow or drop a whole site (every tab on it is then reachable). */
        allowSite(site, on = true) { const s = normalSite(site); if (!s) return; if (on) sites.add(s); else sites.delete(s); },
        siteAllowed,
        /* Is this tab reachable by the agent? Its id on, or its site allowed. */
        isGranted(id, url) { return tabs.has(String(id)) || siteAllowed(url); },
        tabOn(id) { return tabs.has(String(id)); },
        tabIds() { return [...tabs]; },
        siteList() { return [...sites]; },
        toJSON() { return { tabs: [...tabs], sites: [...sites] }; },
    };
}
