/* WHAT THE POPUP LISTS, decided with no browser API (so the unit tests run it as is).
 *
 * rows(): the tabs the person may give, in order. Internal pages (chrome://, about:,
 * the extension's own pages...) are left out. Two tabs with the same title get
 * " (2)", " (3)" so they can be told apart; grants stay by tab id. A child granted
 * through its opener's option says which (deduped) tab opened it.
 *
 * master(): the « Tout donner » switch is on only when EVERY listed tab is given;
 * flipping it gives them all, or takes them all back.
 */
const INTERNAL = /^(chrome|about|chrome-extension|moz-extension|edge|brave|opera|vivaldi|devtools|chrome-search|chrome-untrusted|view-source|resource):/i;

export function isInternal(url, selfBase = '') {
    const u = String(url ?? '');
    if (!u) return true;
    if (selfBase && u.startsWith(selfBase)) return true;
    return INTERNAL.test(u);
}

export function siteOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

export function rows(tabs, selfBase = '') {
    const shown = (tabs ?? []).filter((t) => t && t.id !== undefined && !isInternal(t.url, selfBase));
    const seen = new Map();
    const labelOf = new Map();
    const out = shown.map((t) => {
        const base = (t.title || '').trim() || siteOf(t.url) || t.url || `#${t.id}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const label = n === 1 ? base : `${base} (${n})`;
        labelOf.set(String(t.id), label);
        return { id: t.id, label, site: siteOf(t.url), url: t.url ?? '', given: !!t.granted, inherit: !!t.inherit, showInherit: !!t.granted, parent: t.parent ?? null, openedBy: t.openedBy ?? null };
    });
    for (const r of out) {
        if (r.parent !== null && labelOf.has(String(r.parent))) r.openedBy = labelOf.get(String(r.parent));
        delete r.parent;
    }
    return out;
}

/* 'all' | 'some' | 'none'; the switch shows on for 'all' only. */
export function master(list) {
    const given = list.filter((r) => r.given).length;
    if (list.length && given === list.length) return 'all';
    return given ? 'some' : 'none';
}

/* What flipping the master does: on (any but 'all') gives every tab not yet given;
   off (from 'all') takes every one back. */
export function masterFlip(list) {
    const on = master(list) !== 'all';
    return { on, ids: list.filter((r) => r.given !== on).map((r) => r.id) };
}

export function givenCount(list) { return list.filter((r) => r.given).length; }
