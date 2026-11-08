/* SEVERAL CLAVARIUM AT ONCE (0.1.0-next.64): the list of pairings, each with its own address, token and grants.
 *
 *   stored as { pairings: [{ id, url, token, host, grants, pairKey? }] }
 *
 * A TAB IS GIVEN TO ONE CLAVARIUM ONLY. Turning a tab on for one pairing is refused while another holds it (the
 * person takes it back there first). A pairing's view of the grants (scoped()) never reaches a tab another pairing
 * holds by id, even through an allowed site, so a call from one Clavarium cannot touch the other's tabs.
 *
 * "Also the windows it opens" belongs to the pairing that holds the opener: its child goes to that pairing.
 *
 * MIGRATION. Before 0.1.64 one pairing was kept flat ({ keeperUrl, keeperToken, grants, pairKey }). migrate() turns
 * it into a list of one, token and grants kept, so nobody pairs again; the flat keys are then removed.
 *
 * Pure: no browser API, no storage. Framework-free ESM so the unit tests run it with nothing built.
 */
import { grants as makeGrants, hostOf } from './scope.js';

export const LEGACY_KEYS = ['keeperUrl', 'keeperToken', 'grants', 'pairKey'];

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* The stored object -> { list, migrated }. A list already there wins; a flat pairing (a token, or a key still being
   claimed) becomes the first entry; flat grants with no pairing at all have no one to belong to and are dropped. */
export function migrate(stored = {}, defaultUrl = '') {
    if (Array.isArray(stored.pairings)) return { list: stored.pairings, migrated: false };
    const token = stored.keeperToken ?? null;
    const pairKey = stored.pairKey ?? null;
    const legacy = LEGACY_KEYS.some((k) => stored[k] !== undefined);
    if (!token && !pairKey) return { list: [], migrated: legacy };
    const url = stored.keeperUrl ?? defaultUrl;
    return { list: [{ id: 'p1', url, token, host: hostOf(url) ?? '', grants: stored.grants ?? {}, ...(pairKey ? { pairKey } : {}) }], migrated: true };
}

export function createPairings(list = [], { id = newId } = {}) {
    const all = [];
    const wrap = (p) => ({ id: String(p.id), url: String(p.url ?? ''), token: p.token ?? null, host: p.host || hostOf(p.url) || '', pairKey: p.pairKey ?? null, grants: makeGrants(p.grants ?? {}) });
    for (const p of list) if (p && p.id && p.url) all.push(wrap(p));

    const get = (pid) => all.find((p) => p.id === String(pid)) ?? null;
    /* Who holds this tab by its id (turned on, opened by the agent, or adopted through an opener). */
    const ownerOf = (tabId) => all.find((p) => p.grants.tabOn(tabId)) ?? null;
    const heldByOther = (p, tabId) => { const o = ownerOf(tabId); return !!o && o !== p; };

    return {
        list: () => all,
        get,
        ownerOf,
        /* A new pairing, waiting for its one-time key to be swapped for a token. */
        add({ url, key }) {
            const p = wrap({ id: id(), url, token: null, pairKey: key ?? null });
            all.push(p);
            return p;
        },
        remove(pid) { const i = all.findIndex((p) => p.id === String(pid)); if (i < 0) return null; return all.splice(i, 1)[0]; },
        /* Give or take back one tab. Refused while another pairing holds it. */
        setTab(pid, tabId, on) {
            const p = get(pid);
            if (!p) return { ok: false, error: 'no such pairing' };
            if (on && heldByOther(p, tabId)) return { ok: false, error: `given to ${ownerOf(tabId).host}`, heldBy: ownerOf(tabId).id };
            p.grants.setTab(tabId, on);
            return { ok: true };
        },
        /* The option belongs to the pairing that holds the tab. */
        setInherit(pid, tabId, on) {
            const p = get(pid);
            if (!p || (on && !p.grants.tabOn(tabId))) return { ok: false };
            p.grants.setInherit(tabId, on);
            return { ok: true };
        },
        /* A tab opened by `openerId`: adopted by the one pairing whose opener has the option on. */
        adopt(childId, openerId) {
            if (openerId === undefined || openerId === null) return null;
            const p = all.find((x) => x.grants.tabOn(openerId) && x.grants.inherits(openerId));
            if (!p || ownerOf(childId)) return null;
            return p.grants.adopt(childId, openerId) ? p : null;
        },
        forget(tabId) { for (const p of all) p.grants.forget(tabId); },
        /* What one pairing may reach: its own grants, minus any tab another pairing holds by id. This is what its
           calls are checked against (lib/protocol.js), and what its granted list says. */
        scoped(p) {
            const g = p.grants;
            return {
                ...g,
                isGranted: (tabId, url) => !heldByOther(p, tabId) && g.isGranted(tabId, url),
                grantTab: (tabId) => { if (!heldByOther(p, tabId)) g.grantTab(tabId); },
            };
        },
        toJSON: () => all.map((p) => ({ id: p.id, url: p.url, token: p.token, host: p.host, grants: p.grants.toJSON(), ...(p.pairKey ? { pairKey: p.pairKey } : {}) })),
    };
}

/* One at a time: a screenshot activates its tab, then captures its window, so two Clavarium shooting two tabs of one
   window must not interleave (the second activation would be captured by the first). */
export function oneAtATime() {
    let tail = Promise.resolve();
    return (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}
