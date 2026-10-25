/* THE CONTENT SCRIPT: it captures the page's console so `browser.console` can
 * read recent messages back. It patches console.log/warn/error/info at
 * document_start and forwards each line to the background, which keeps the last
 * few per tab. Synthetic input and reading the DOM are done by executeScript
 * from the background (the page's own world); this script only watches.
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: false,
    main() {
        const send = (level: string, args: unknown[]) => {
            let line = '';
            try { line = `${level}: ${args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ')}`.slice(0, 2000); } catch { return; }
            try { browser.runtime.sendMessage({ op: 'console', line }); } catch { /* background asleep */ }
        };
        for (const level of ['log', 'info', 'warn', 'error'] as const) {
            const original = console[level].bind(console);
            console[level] = (...args: unknown[]) => { send(level, args); original(...args); };
        }
        window.addEventListener('error', (e) => send('error', [e.message]));
        window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => send('error', [`unhandled: ${e.reason}`]));
    },
});
