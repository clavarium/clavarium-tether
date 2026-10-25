/* THE MESSAGE MAPPING: a { t:"call", id, verb, args } from the keeper is turned
 * into one action, and its result into { t:"result", id, ok, text, size } (or
 * { ok:false, error }). This is the heart of the extension and it is pure: the
 * browser work is an injected `actions` object, so the mapping and the
 * tab-scoping can be tested with nothing built.
 *
 * SCOPING IS ENFORCED HERE TOO. A verb that names a tab the person did not
 * grant is refused before any action runs — the same refusal the keeper makes,
 * as a second lock. `open` with no tab opens a new tab, which is granted as it
 * opens (the person approved the open through the keeper's rights).
 *
 *   actions = {
 *     tabs(grants)                 -> { text, size, data }   granted tabs, listed
 *     openTab(url, grants)         -> { text, size, tabId }  open+grant a new tab
 *     activeGrantedTab(grants)     -> tabId | null           the agent's current tab
 *     tabInfo(tabId)               -> { url, title } | null
 *     navigate(tabId, url)         -> { text, size }
 *     shot(tabId)                  -> { text, size }         a data: image URL
 *     html(tabId, args)            -> { text, size }
 *     console(tabId, args)         -> { text, size }
 *     eval(tabId, script)          -> { text, size }
 *     click(tabId, args)           -> { text, size }
 *     type(tabId, args)            -> { text, size }
 *     key(tabId, args)             -> { text, size }
 *     scroll(tabId, args)          -> { text, size }
 *     drag(tabId, args)            -> { text, size }
 *   }
 *   mark(tabId) -> (async) off()   show the "an agent is acting here" badge/border
 */
const byteLen = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(s ?? '')).length : Buffer.byteLength(String(s ?? '')));
const done = (id, r = {}) => ({ t: 'result', id, ok: true, text: r.text ?? '', size: r.size ?? byteLen(r.text) });
const fail = (id, error) => ({ t: 'result', id, ok: false, error: String(error ?? 'refused') });

/* The verbs that act on one already-resolved, already-granted tab. */
async function act(verb, tabId, args, actions) {
    switch (verb) {
        case 'open': return actions.navigate(tabId, args.url);
        case 'shot': return actions.shot(tabId);
        case 'html': return actions.html(tabId, args);
        case 'console': return actions.console(tabId, args);
        case 'eval': return actions.eval(tabId, args.script);
        case 'click': return actions.click(tabId, args);
        case 'type': return actions.type(tabId, args);
        case 'key': return actions.key(tabId, args);
        case 'scroll': return actions.scroll(tabId, args);
        case 'drag': return actions.drag(tabId, args);
        default: throw new Error(`no verb browser.${verb}`);
    }
}

export async function dispatch(msg, { grants, actions, mark } = {}) {
    const id = msg?.id;
    const verb = msg?.verb;
    const args = msg?.args ?? {};
    try {
        if (verb === 'tabs') return done(id, await actions.tabs(grants));

        /* `open` with no tab is a new tab; the agent cannot open a tab it may
           not then touch, so opening grants it. */
        if (verb === 'open' && (args.tab === undefined || args.tab === null || args.tab === '')) {
            if (!args.url) return fail(id, 'open needs a url');
            return done(id, await actions.openTab(args.url, grants));
        }

        let tabId = args.tab;
        if (tabId === undefined || tabId === null || tabId === '') tabId = await actions.activeGrantedTab(grants);
        if (tabId === undefined || tabId === null) return fail(id, 'no granted tab to act on: grant one in the extension');

        const info = await actions.tabInfo(tabId);
        if (!info) return fail(id, 'that tab is gone');
        if (!grants.isGranted(tabId, info.url)) return fail(id, 'that tab was not granted to the agent');

        const off = mark ? await mark(tabId) : null;
        try { return done(id, await act(verb, tabId, args, actions)); }
        finally { if (off) { try { await off(); } catch { /* best effort */ } } }
    } catch (e) {
        return fail(id, e?.message ?? e);
    }
}

export const _internal = { byteLen, done, fail };
