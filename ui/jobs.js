/* A JOB: an act a person approved that only their browser can do (a device to flash
 * over USB). The page shows it with a button -- the browser lets only a click reach a
 * USB device -- and this runs it, then says how it ended to the keeper.
 *
 *   await runJob(job, { call, root, words, pair })   // from the button's click
 *
 * `call(op, args)` is the page's way to the keeper (as for mount); `root` where the
 * module draws its steps. The module is Tether's own, named by the keeper, from
 * this folder: a page never runs a module a job names otherwise. The firmware an agent
 * handed over comes from the keeper (`job-file`); `pair(room) -> { url, code }` is the
 * host's own, for a device that pairs with it.
 */
export const MODULES = Object.freeze(['device-flash.js']);

export async function runJob(job, { call, root = null, words = {}, pair = null } = {}) {
    if (!MODULES.includes(job?.module)) return call('job-done', { id: job?.id, ok: false, text: 'unknown module' });
    let r;
    try {
        const { run } = await import(`./${job.module}`);
        const image = job.args?.image ? async () => {
            const f = await call('job-file', { id: job.id });
            if (!f.ok) throw new Error(f.text);
            const bin = atob(f.data.image);
            return Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } : null;
        r = await run(job.args ?? {}, { root, words, image, pair });
    } catch (error) {
        r = { ok: false, text: String(error?.message ?? error) };
    }
    await call('job-done', { id: job.id, ok: r.ok === true, text: r.text });
    return r;
}
