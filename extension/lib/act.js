/* WHICH HAND ACTS: real input through the debugger (Chrome), or synthetic DOM
 * events (Firefox, or a Chrome tab the debugger cannot attach to). The
 * background gives the page work (`page`) and the CDP driver (lib/cdp.js);
 * this decides, and words the result. Pure, so both paths are tested with
 * nothing built.
 *
 *   page = {
 *     point(tabId, where)            -> { x, y } | { error }  an element's centre (scrolled into view) or "x,y"
 *     centre(tabId)                  -> { x, y }              the viewport's centre
 *     focus(tabId, selector)         -> boolean               focus a field first
 *     synthetic: { click, type, key, scroll, drag }(tabId, args) -> string
 *     evalScript(tabId, code)        -> string                scripting.executeScript + eval (may throw on a CSP)
 *     setFiles(tabId, selector, b64, name, mime) -> string     a File set on an <input type=file> (or dropped)
 *   }
 */
const ms = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, 2000) : undefined; };
const CSP = /unsafe-eval|content security policy|EvalError/i;

export const UPLOAD_MAX = 25 * 1024 * 1024;

export function makeActs({ driver, page }) {
    const real = !!driver?.available;
    /* The debugger refused (a chrome:// page, another debugger): the synthetic way, said. */
    async function either(tabId, viaCdp, viaDom) {
        if (!real) return viaDom();
        try { return await viaCdp(); }
        catch (e) {
            if (e?.pointError) throw e;
            const r = await viaDom();
            return `${r} (synthetic: the debugger could not act here: ${String(e?.message ?? e).slice(0, 120)})`;
        }
    }
    const at = async (tabId, where) => {
        const p = await page.point(tabId, where);
        if (!p || p.error) { const err = new Error(p?.error ?? `nothing at ${where}`); err.pointError = true; throw err; }
        return p;
    };

    return {
        real,
        async click(tabId, a = {}) {
            return either(tabId, async () => {
                const p = a.selector ? await at(tabId, a.selector) : { x: Number(a.x ?? 0), y: Number(a.y ?? 0) };
                await driver.click(tabId, p.x, p.y, { button: a.button || 'left', delay: ms(a.delay) });
                return `clicked at ${Math.round(p.x)},${Math.round(p.y)}`;
            }, () => page.synthetic.click(tabId, a));
        },
        async type(tabId, a = {}) {
            return either(tabId, async () => {
                if (a.selector && !(await page.focus(tabId, a.selector))) { const err = new Error(`no field ${a.selector}`); err.pointError = true; throw err; }
                const how = await driver.type(tabId, a.text, { fast: a.fast === true, delay: ms(a.delay) });
                return how === 'long' ? 'typed (at once: too long to type key by key)' : 'typed';
            }, () => page.synthetic.type(tabId, a));
        },
        async key(tabId, a = {}) {
            return either(tabId, async () => {
                if (a.selector && !(await page.focus(tabId, a.selector))) { const err = new Error(`no element ${a.selector}`); err.pointError = true; throw err; }
                await driver.key(tabId, a.key, { delay: ms(a.delay) });
                return `pressed ${a.key}`;
            }, () => page.synthetic.key(tabId, a));
        },
        async scroll(tabId, a = {}) {
            return either(tabId, async () => {
                const p = a.selector ? await at(tabId, a.selector) : await page.centre(tabId);
                await driver.scroll(tabId, p.x, p.y, Number(a.dx ?? 0), Number(a.dy ?? 0), { delay: ms(a.delay) });
                return `scrolled ${a.dx ?? 0},${a.dy ?? 0}`;
            }, () => page.synthetic.scroll(tabId, a));
        },
        async drag(tabId, a = {}) {
            return either(tabId, async () => {
                const from = await at(tabId, a.from); const to = await at(tabId, a.to);
                await driver.drag(tabId, from, to, { delay: ms(a.delay) });
                return `dragged ${a.from} to ${a.to}`;
            }, () => page.synthetic.drag(tabId, a));
        },
        /* Chrome: Runtime.evaluate, which the page's CSP does not govern. Firefox: executeScript, refused plainly under a strict CSP. */
        async eval(tabId, script) {
            if (real) { try { return await driver.evaluate(tabId, script); } catch { /* the debugger refused: the scripting way */ } }
            let r;
            try { r = await page.evalScript(tabId, script); } catch (e) { r = `error: ${e?.message ?? e}`; }
            if (typeof r === 'string' && r.startsWith('error:') && CSP.test(r)) {
                throw new Error(`this page's Content Security Policy forbids running a script string here${real ? '' : ' (Firefox has no debugger to go around it)'}: nothing was run -- read it with browser.html, act with click/type/key, or use Chrome`);
            }
            return r;
        },
        /* A file from the agent, as base64: set on the input (DataTransfer), the same on both browsers. */
        async upload(tabId, a = {}) {
            const b64 = String(a.file ?? '');
            if (!b64) throw new Error('upload needs the file');
            if (!a.selector) throw new Error('upload needs the selector of a file input (or of a drop zone)');
            if (Math.floor(b64.length * 3 / 4) > UPLOAD_MAX) throw new Error(`the file is too large (${UPLOAD_MAX / 1024 / 1024} MB at most)`);
            return page.setFiles(tabId, a.selector, b64, a.name || 'file', a.mime || '');
        },
    };
}
