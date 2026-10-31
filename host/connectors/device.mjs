/* THE DEVICE CONNECTOR: work done IN A PERSON'S BROWSER, not here.
 *
 * Flashing a device plugged into a person's computer by USB cannot be done by
 * the keeper: the cable is at the person's, and the browser is what reaches it
 * (Web Serial, WebUSB). So an approved `device.flash` becomes a JOB: the page of
 * the application lists it, a person clicks, the page runs Tether's own module
 * (ui/device-flash.js) and says how it ended with `finish`. The agent's call
 * waits for that answer, and gets it as it is.
 *
 *   args.image      THE FIRMWARE ITSELF, base64: the agent hands it over (Tether is the
 *                   vector, whatever the load); kept here, in memory, for this job only,
 *                   and given to the page that runs it (`file`)
 *   args.firmware   or an address ON THE APPLICATION'S SITE ("/…") the page fetches
 *   args.name       what the device is called on the card
 *   args.wifi       false: flash only; else the person is asked for a Wi-Fi after
 *   args.pair       true: after the Wi-Fi, the device is paired with the application
 *                   whose page runs the job (the page knows how; args.room names the room)
 *   args.app        { url, room, code }: or what the device joins, given outright
 *
 * Not run within JOB_MINUTES: refused, nothing was done.
 */
import { randomUUID, createHash } from 'node:crypto';
import { no, oneLine } from '../../server/verbs.mjs';

export const JOB_MINUTES = 30;
export const IMAGE_MAX = 16 * 1024 * 1024;
export const MODULES = Object.freeze({ 'device.flash': 'device-flash.js' });

export function device({ now = () => Date.now() } = {}) {
    const jobs = new Map();
    const checked = (a) => {
        let image = null;
        if (a.image !== undefined) {
            image = Buffer.from(String(a.image), 'base64');
            if (image.length === 0 || image.length > IMAGE_MAX) no(`the image must be 1 byte to ${IMAGE_MAX / 1024 / 1024} MB of base64`);
        }
        const firmware = a.firmware === undefined ? '' : String(a.firmware);
        if (!image && (!/^\/[^/\\]/.test(firmware) || firmware.length > 500)) no('give the image (base64), or firmware: an address of this site starting with /');
        const app = a.app && typeof a.app === 'object'
            ? { url: oneLine(a.app.url, 200), room: oneLine(a.app.room ?? '', 40), code: oneLine(a.app.code, 20) } : undefined;
        if (app && !/^https?:\/\//.test(app.url)) no('app.url must be an http(s) address');
        const args = { ...(image ? { image: { bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') } } : { firmware }),
            name: oneLine(a.name ?? '', 60) || undefined, wifi: a.wifi !== false, ...(a.pair === true ? { pair: true } : {}), ...(a.room ? { room: oneLine(a.room, 40) } : {}), ...(app ? { app } : {}) };
        return { args, image };
    };
    return {
        run(verb, t, a, ctx) {
            const module = MODULES[verb];
            if (!module) no(`${verb} is not a device verb`);
            const { args, image } = checked(a);
            const id = randomUUID();
            ctx?.hold?.(new Date(now() + JOB_MINUTES * 60_000).toISOString());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { jobs.delete(id); reject(new Error(`nobody ran it in a browser within ${JOB_MINUTES} minutes: nothing was done`)); }, JOB_MINUTES * 60_000);
                timer.unref?.();
                jobs.set(id, { id, verb, module, target: { id: t.id, title: t.title }, agent: ctx?.agent, args, image, at: new Date(now()).toISOString(),
                    end: (ok, text) => { clearTimeout(timer); jobs.delete(id); if (ok) resolve({ text: oneLine(text, 2000) || 'done' }); else reject(new Error(oneLine(text, 2000) || 'it failed in the browser')); } });
            });
        },
        /* What waits for a browser, as a page shows it. */
        jobs() { return [...jobs.values()].map(({ end, image, ...j }) => j); },
        /* The image a job carries, for the page that runs it: base64. */
        file(id) {
            const job = jobs.get(String(id));
            if (!job) no('no such job: ended already, or never was');
            if (!job.image) no('this job carries no image: its firmware is an address');
            return { image: job.image.toString('base64') };
        },
        finish(id, ok, text) {
            const job = jobs.get(String(id));
            if (!job) no('no such job: ended already, or never was');
            job.end(ok === true, String(text ?? ''));
            return { ok: true };
        },
    };
}
