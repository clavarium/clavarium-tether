import { defineConfig } from 'wxt';

/* ONE CODEBASE, BOTH BROWSERS. WXT builds the Chrome (MV3 service worker) and
 * the Firefox (MV3 event page) variants from these entrypoints. No
 * chrome.debugger in V1: the verbs use scripting.executeScript in the page's
 * own world, tabs.captureVisibleTab and synthetic events only.
 *
 * host_permissions is <all_urls> because the agent may be granted any tab the
 * person chooses; the grant, not the manifest, is what scopes access. The
 * default per-site level in the keeper is Propose, and a badge plus a red
 * border show while the agent acts in a tab (see entrypoints/background.ts).
 */
export default defineConfig({
    /* Firefox builds as MV2 (WXT's default): a PERSISTENT background page, which
     * is the most robust way to keep the outbound WebSocket to the keeper alive
     * on Firefox, where an MV3 event page would be suspended. Chrome builds MV3
     * (a service worker); the reconnect + heartbeat in lib/link.js covers both. */
    suppressWarnings: { firefoxDataCollection: true },
    manifest: {
        name: 'Clavarium Tether',
        description: 'Give an AI agent, on a tether, access to the browser tabs you grant it.',
        permissions: ['tabs', 'scripting', 'storage', 'activeTab'],
        host_permissions: ['<all_urls>'],
        action: { default_popup: 'popup/index.html', default_title: 'Clavarium Tether' },
        browser_specific_settings: { gecko: { id: 'tether@example.com' } },
    },
});
