/* THE DEVICE CONNECTOR: work done IN A PERSON'S BROWSER, not here.
 *
 * Flashing a device plugged into a person's computer by USB cannot be done by
 * the keeper: the cable is at the person's, and the browser is what reaches it
 * (Web Serial, WebUSB). So an approved `device.flash` becomes a JOB: the page of
 * the application lists it, a person clicks, the page runs Tether's own module
 * (ui/device-flash.js) and says how it ended with `finish`. The agent's call
 * waits for that answer, and gets it as it is.
 *
 *   args.firmware   an address ON THE APPLICATION'S SITE ("/…"): the page fetches it
 *                   with its own session; any other site is refused
 *   args.name       what the device is called on the card
 *   args.wifi       false: flash only; else the person is asked for a Wi-Fi after
 *   args.app        { url, room, code }: what the device joins (our devices, Improv 0xC0)
 *
 * Not run within JOB_MINUTES: refused, nothing was done.
 */
import { randomUUID } from 'node:crypto';
import { no, oneLine } from '../../server/verbs.mjs';

export const JOB_MINUTES = 30;
export const MODULES = Object.freeze({ 'device.flash': 'device-flash.js' });

export function device({ now = () => Date.now() } = {}) {
    const jobs = new Map();
    const checked = (a) => {
        const firmware = String(a.firmware ?? '');
        if (!/^\/[^/\\]/.test(firmware) || firmware.length > 500) no('firmware must be an address of this site, starting with /');
        const app = a.app && typeof a.app === 'object'
            ? { url: oneLine(a.app.url, 200), room: oneLine(a.app.room ?? '', 40), code: oneLine(a.app.code, 20) } : undefined;
        if (app && !/^https?:\/\//.test(app.url)) no('app.url must be an http(s) address');
        return { firmware, name: oneLine(a.name ?? '', 60) || undefined, wifi: a.wifi !== false, ...(app ? { app } : {}) };
    };
    return {
        run(verb, t, a, ctx) {
            const module = MODULES[verb];
            if (!module) no(`${verb} is not a device verb`);
            const args = checked(a);
            const id = randomUUID();
            ctx?.hold?.(new Date(now() + JOB_MINUTES * 60_000).toISOString());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { jobs.delete(id); reject(new Error(`nobody ran it in a browser within ${JOB_MINUTES} minutes: nothing was done`)); }, JOB_MINUTES * 60_000);
                timer.unref?.();
                jobs.set(id, { id, verb, module, target: { id: t.id, title: t.title }, agent: ctx?.agent, args, at: new Date(now()).toISOString(),
                    end: (ok, text) => { clearTimeout(timer); jobs.delete(id); if (ok) resolve({ text: oneLine(text, 2000) || 'done' }); else reject(new Error(oneLine(text, 2000) || 'it failed in the browser')); } });
            });
        },
        /* What waits for a browser, as a page shows it. */
        jobs() { return [...jobs.values()].map(({ end, ...j }) => j); },
        finish(id, ok, text) {
            const job = jobs.get(String(id));
            if (!job) no('no such job: ended already, or never was');
            job.end(ok === true, String(text ?? ''));
            return { ok: true };
        },
    };
}
