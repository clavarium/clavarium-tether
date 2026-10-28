/* THE CALENDAR CONNECTOR: a person's calendar (Google or Microsoft) reached by the
 * keeper over the provider's REST API with a token, never a password. Like the mail
 * connector, the refresh token is the host's and the agent never sees it; a short
 * access token is minted per call. Inspired by the MIT Google/Microsoft MCP servers,
 * the calls reimplemented here so the token stays host-side and the levels gate them.
 *
 *   target.config.provider   'google' or 'microsoft'
 *   target.config.clientId   optional: an own OAuth app instead of Thunderbird's
 *   target.secrets.refresh   the NAME of the refresh token in the host's secret store
 *   target.secrets.secret    optional: the NAME of an own client secret
 *
 * Reads (watch): calendar.list, calendar.read. Acts (above watch): calendar.create.
 * `fetch` is injected for tests. (Note: the Thunderbird client covers Google calendar
 * cleanly; a Microsoft calendar needs the right Graph scope on the connected account.)
 */
import { no, Refused } from '../../server/verbs.mjs';
import { refreshAccess, thunderbird, PROVIDERS } from '../oauth.mjs';

const LIST_MAX = 200;           /* events a list returns at most, then it says so (a year holds many) */
const TZ = 'Europe/Paris';      /* the person's timezone: events are shown and created in it, not UTC */
/* A Graph/ISO datetime, shown short and local: "2026-11-10 16:00". */
const shortWhen = (dt) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(dt || '')); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (dt || '?'); };
const READ_MAX = 256 * 1024;
const dateField = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : { dateTime: s });

const API = {
    google: {
        list: (n, { from, to } = {}) => `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${n}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(from)}${to ? `&timeMax=${encodeURIComponent(to)}` : ''}`,
        event: (id) => `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
        create: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        items: (j) => j.items ?? [],
        brief: (e) => `${e.id}\n  ${e.start?.dateTime ?? e.start?.date ?? '?'} — ${e.summary ?? '(no title)'}${e.location ? `  @ ${e.location}` : ''}`,
        body: ({ title, start, end, where }) => ({ summary: title, start: dateField(start), end: dateField(end), ...(where ? { location: where } : {}) }),
    },
    microsoft: {
        /* calendarView, not /events: /events orders over the WHOLE calendar, so it
           returns the oldest events, not the next ones. calendarView takes a window
           (from now on) and expands recurrences, so "list" means what is coming. */
        list: (n, { from, to } = {}) => `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$top=${n}&$orderby=start/dateTime&$select=id,subject,start,end,location`,
        event: (id) => `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`,
        create: 'https://graph.microsoft.com/v1.0/me/events',
        items: (j) => j.value ?? [],
        brief: (e) => `${e.id}\n  ${shortWhen(e.start?.dateTime)} — ${e.subject ?? '(no title)'}${e.location?.displayName ? `  @ ${e.location.displayName}` : ''}`,
        body: ({ title, start, end, where, notes, attendees }) => ({
            subject: title,
            start: { dateTime: start, timeZone: TZ }, end: { dateTime: end, timeZone: TZ },
            ...(where ? { location: { displayName: where } } : {}),
            ...(notes ? { body: { contentType: 'text', content: String(notes) } } : {}),
            ...(attendees?.length ? { attendees: attendees.map((a) => ({ emailAddress: { address: a }, type: 'required' })) } : {}),
        }),
    },
};

export function calendar({ fetch: fetchImpl = globalThis.fetch } = {}) {
    const tokens = new Map();
    const providerOf = (target) => { const p = String(target.config?.provider ?? ''); if (!API[p] || !PROVIDERS[p]) no(`${target.title}: set its provider to google or microsoft`); return p; };

    async function access(target, ctx) {
        const provider = providerOf(target);
        const cached = tokens.get(target.id);
        if (cached && cached.exp > Date.now() + 60_000) return cached.value;
        const refresh = await ctx.secret('refresh');
        if (!refresh) no(`${target.title}: its refresh token is empty -- reconnect the account`);
        const clientId = target.config?.clientId || thunderbird(provider).clientId;
        const clientSecret = target.secrets?.secret ? await ctx.secret('secret') : thunderbird(provider).clientSecret;
        let t;
        try { t = await refreshAccess(provider, { clientId, clientSecret, refreshToken: refresh, fetch: fetchImpl }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: the calendar must be reconnected (its authorisation was refused)`); }
        tokens.set(target.id, { value: t.accessToken, exp: t.expiresAt });
        return t.accessToken;
    }

    async function call(target, ctx, method, url, json) {
        const token = await access(target, ctx);
        /* Ask Microsoft to answer in the person's timezone, not UTC, so a 4pm
           meeting reads 16:00 and not 15:00. Harmless for the Google REST path. */
        const headers = { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TZ}"` };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        let res;
        try { res = await fetchImpl(url, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: cannot reach the calendar`); }
        if (res.status === 401 || res.status === 403) no(`${target.title}: not authorized -- reconnect the account (the calendar scope may be missing)`);
        return res;
    }
    const bodyError = async (res) => { try { const j = await res.json(); return j?.error?.message || ''; } catch { return ''; } };

    /* GOOGLE CALENDAR OVER CalDAV. The REST Calendar API needs that API turned on
       in the OAuth client's own Google project; the borrowed Thunderbird client is
       a CalDAV client (that is how it reads Google calendars), not a REST one, so
       REST is refused. CalDAV uses the same calendar scope the client carries (as
       its contacts do over CardDAV), so the host speaks a small calendar-query and
       parses the returned iCalendar. The collection URL needs the account address. */
    const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const userOf = (target) => { const u = String(target.config?.user ?? '').trim(); if (!u) no(`${target.title}: reconnect the account so it carries its address (the Google calendar needs it)`); return u; };
    const CALDAV = (user) => `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(user)}/events/`;
    const icalUTC = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const fmtICal = (dt) => { const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(dt || ''); return m ? (m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`) : (dt || '?'); };
    const veventField = (v, re) => { const m = re.exec(v); return m ? m[1].trim() : ''; };
    function fromVevent(text) {
        const v = String(text).replace(/\r?\n[ \t]/g, '');
        return { summary: veventField(v, /^SUMMARY[^:\r\n]*:(.+)$/im), start: veventField(v, /^DTSTART[^:\r\n]*:(.+)$/im), location: veventField(v, /^LOCATION[^:\r\n]*:(.+)$/im) };
    }
    async function dav(target, ctx, method, url, { headers = {}, body } = {}) {
        const token = await access(target, ctx);
        let res;
        try { res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { body } : {}) }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: cannot reach the calendar`); }
        if (res.status === 401 || res.status === 403) no(`${target.title}: not authorized -- reconnect the account (the calendar scope may be missing)`);
        return res;
    }
    /* The events in a window, each expanded to its occurrences, briefed one per line. */
    async function googleList(target, ctx, { from, to }) {
        const s = icalUTC(from); const e = icalUTC(to);
        const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data><C:expand start="${s}" end="${e}"/></C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${s}" end="${e}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
        const res = await dav(target, ctx, 'REPORT', CALDAV(userOf(target)), { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body });
        if (!res.ok) no(`${target.title}: the calendar could not be read (${res.status})`);
        const xml = await res.text();
        const out = [];
        for (const block of xml.split(/<[A-Za-z0-9]*:?response[\s>]/i).slice(1)) {
            const href = /<[^>]*?:?href[^>]*>([\s\S]*?)<\/[^>]*?:?href>/i.exec(block)?.[1]?.trim();
            const data = /<[^>]*?:?calendar-data[^>]*>([\s\S]*?)<\/[^>]*?:?calendar-data>/i.exec(block)?.[1];
            if (!data) continue;
            for (const piece of decodeXml(data).split(/BEGIN:VEVENT/i).slice(1)) {
                const ev = fromVevent(piece);
                if (ev.summary || ev.start) out.push({ id: href, ...ev });
            }
        }
        out.sort((x, y) => String(x.start).localeCompare(String(y.start)));
        return out.map((ev) => `${ev.id || '(no id)'}\n  ${fmtICal(ev.start)} — ${ev.summary || '(no title)'}${ev.location ? `  @ ${ev.location}` : ''}`);
    }
    async function googleRead(target, ctx, id) {
        const url = /^https?:\/\//.test(id) ? id : new URL(id, CALDAV(userOf(target))).href;
        const res = await dav(target, ctx, 'GET', url, { headers: { 'Content-Type': 'text/calendar' } });
        if (res.status === 404) no('no such event');
        if (!res.ok) no(`${target.title}: that event could not be read (${res.status})`);
        return (await res.text()).slice(0, READ_MAX);
    }

    const verbs = {
        /* Events in a window, soonest first. By default from now on (the next
           events); `from`/`to` (ISO dates or datetimes) move it into the past or
           future, so the agent can look at any week or month, not only what's next. */
        async 'calendar.list'(target, a, ctx) {
            const provider = providerOf(target);
            const when = (s) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
            const from = when(a.from) ?? new Date().toISOString();
            const to = when(a.to) ?? new Date(new Date(from).getTime() + 365 * 86_400_000).toISOString();
            /* A cap keeps the reply readable; when it bites, say so and why -- never a
               silent truncation. `more` is true when events were left out. */
            const pack = (briefs, more) => {
                if (!briefs.length) return { text: 'No event in that range.', size: 18 };
                const shown = briefs.slice(0, LIST_MAX);
                const note = (more || briefs.length > LIST_MAX) ? `\n\n(Showing the first ${LIST_MAX} events in this window, to keep the reply readable — narrow it with from/to to see the rest.)` : '';
                const text = shown.join('\n') + note;
                return { text, size: Buffer.byteLength(text) };
            };
            /* Google over CalDAV (the REST API its client cannot use); Microsoft over Graph. */
            if (provider === 'google') return pack(await googleList(target, ctx, { from, to }));
            const api = API[provider];
            const res = await call(target, ctx, 'GET', api.list(LIST_MAX, { from, to }));
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            const json = await res.json();
            return pack(api.items(json).map(api.brief), Boolean(json['@odata.nextLink']));
        },
        /* One event in full, by its id. */
        async 'calendar.read'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider === 'google') { const text = await googleRead(target, ctx, String(a.id)); return { text, size: Buffer.byteLength(text) }; }
            const api = API[provider];
            const res = await call(target, ctx, 'GET', api.event(String(a.id)));
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            const text = JSON.stringify(await res.json(), null, 1).slice(0, READ_MAX);
            return { text, size: Buffer.byteLength(text) };
        },
        /* Create an event. An act: the start and end are ISO times (a bare date is all-day). */
        async 'calendar.create'(target, a, ctx) {
            const api = API[providerOf(target)];
            if (!a.title) no('an event needs a title');
            if (!a.start || !a.end) no('an event needs a start and an end (local ISO times, e.g. 2026-11-10T16:00:00)');
            const attendees = String(a.with ?? '').split(',').map((x) => x.trim()).filter(Boolean);
            const res = await call(target, ctx, 'POST', api.create, api.body({ title: a.title, start: a.start, end: a.end, where: a.where, notes: a.notes, attendees }));
            if (!res.ok) no(`${target.title}: the event was not created (${res.status} ${await bodyError(res)})`.trim());
            const made = await res.json().catch(() => ({}));
            return { text: `Created: ${a.title} (${a.start}). Its id is ${made.id ?? '(unknown)'}.`, size: 0 };
        },
        /* Join a file to an event. An act. Microsoft takes the bytes inline (Graph
           fileAttachment); a Google calendar attach is a Drive link, added once the
           files connector is in -- for now it is Microsoft only. */
        async 'calendar.attach'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') no(`${target.title}: joining a file to an event is Microsoft-only for now`);
            if (!a.id) no('attach needs the event id (from the list)');
            if (!a.attach) no('attach needs the file (its base64 bytes)');
            const ev = encodeURIComponent(String(a.id));
            /* Who would receive the file: an event attachment reaches every participant
               on the next invitation update or resend. Split internal from external by
               the organiser's domain, and refuse an external audience unless `share`. */
            const internals = []; const externals = [];
            const info = await call(target, ctx, 'GET', `https://graph.microsoft.com/v1.0/me/events/${ev}?$select=attendees,organizer`);
            if (info.ok) {
                const j = await info.json().catch(() => ({}));
                const org = (j.organizer?.emailAddress?.address || target.config?.user || '').toLowerCase();
                const dom = org.split('@')[1] || '';
                for (const at of (j.attendees ?? [])) {
                    const addr = at.emailAddress?.address; if (!addr || addr.toLowerCase() === org) continue;
                    (dom && addr.toLowerCase().endsWith('@' + dom) ? internals : externals).push(addr);
                }
            }
            if (externals.length && a.share !== true) {
                no(`${externals.length} external participant(s): ${externals.join(', ')}. The file would reach them on the next invitation update/resend. Add --share (CLI) or share:true (MCP) to attach anyway.`);
            }
            const att = { '@odata.type': '#microsoft.graph.fileAttachment', name: String(a.attachName || 'attachment'), contentBytes: String(a.attach) };
            const res = await call(target, ctx, 'POST', `https://graph.microsoft.com/v1.0/me/events/${ev}/attachments`, att);
            if (!res.ok) no(`${target.title}: the file was not attached (${res.status} ${await bodyError(res)})`.trim());
            const all = internals.length + externals.length;
            const who = all
                ? ` It will reach ${all} participant(s) on the next invitation update/resend:${internals.length ? ` ${internals.join(', ')} (internal)` : ''}${externals.length ? `${internals.length ? ';' : ''} ${externals.join(', ')} (external)` : ''}.`
                : ' Visible to you alone (the event has no participants).';
            return { text: `Attached ${a.attachName || 'the file'} to the event.${who}`, size: 0 };
        },
        /* Remove a file from an event, by its name or 1-based number. An act.
           Microsoft only, like attaching (Graph deletes the attachment by id). */
        async 'calendar.detach'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') no(`${target.title}: event attachments are Microsoft-only for now`);
            if (!a.id) no('detach needs the event id (from the list)');
            const which = String(a.which ?? '').trim();
            if (!which) no('detach needs which attachment (its name or number)');
            const ev = encodeURIComponent(String(a.id));
            const listed = await call(target, ctx, 'GET', `https://graph.microsoft.com/v1.0/me/events/${ev}/attachments?$select=id,name`);
            if (!listed.ok) no(`${target.title}: the event's attachments could not be read (${listed.status})`);
            const atts = (await listed.json()).value ?? [];
            if (!atts.length) no('this event has no attachment');
            const n = /^\d+$/.test(which) ? Number(which) - 1 : atts.findIndex((x) => (x.name || '').toLowerCase().includes(which.toLowerCase()));
            const att = atts[n];
            if (!att) no(`no attachment "${which}" — this event has: ${atts.map((x) => x.name).join(', ')}`);
            const res = await call(target, ctx, 'DELETE', `https://graph.microsoft.com/v1.0/me/events/${ev}/attachments/${encodeURIComponent(att.id)}`);
            if (!res.ok) no(`${target.title}: the attachment was not removed (${res.status} ${await bodyError(res)})`.trim());
            return { text: `Removed ${att.name} from the event.`, size: 0 };
        },
        /* Delete an event. An act. Microsoft over Graph; Google over CalDAV (the id
           is the event's CalDAV href, as read returns it). */
        async 'calendar.delete'(target, a, ctx) {
            const provider = providerOf(target);
            if (!a.id) no('delete needs the event id (from the list)');
            if (provider === 'google') {
                const url = /^https?:\/\//.test(String(a.id)) ? String(a.id) : new URL(String(a.id), CALDAV(userOf(target))).href;
                const res = await dav(target, ctx, 'DELETE', url, {});
                if (res.status === 404) no('no such event');
                if (!res.ok) no(`${target.title}: the event was not deleted (${res.status})`);
                return { text: 'Deleted the event.', size: 0 };
            }
            const res = await call(target, ctx, 'DELETE', API.microsoft.event(String(a.id)));
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: the event was not deleted (${res.status} ${await bodyError(res)})`.trim());
            return { text: 'Deleted the event.', size: 0 };
        },
        /* Respond to a meeting invitation: accept, decline or tentative. An act.
           Microsoft over Graph; a Google RSVP (CalDAV PARTSTAT) comes with parity. */
        async 'calendar.respond'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') no(`${target.title}: answering an invitation is Microsoft-only for now`);
            if (!a.id) no('respond needs the event id (from the list)');
            const map = { accept: 'accept', yes: 'accept', decline: 'decline', no: 'decline', refuse: 'decline', tentative: 'tentativelyAccept', maybe: 'tentativelyAccept' };
            const action = map[String(a.answer ?? '').toLowerCase().trim()];
            if (!action) no('answer is accept, decline or tentative');
            const body = { sendResponse: true, ...(a.comment ? { comment: String(a.comment) } : {}) };
            const res = await call(target, ctx, 'POST', `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(String(a.id))}/${action}`, body);
            if (!res.ok) no(`${target.title}: the response was not sent (${res.status} ${await bodyError(res)})`.trim());
            return { text: `${action === 'accept' ? 'Accepted' : action === 'decline' ? 'Declined' : 'Tentatively accepted'} the invitation.`, size: 0 };
        },
        /* Change an event: any of title, start, end, where. An act. Microsoft over
           Graph (PATCH); a Google edit (CalDAV PUT) comes with parity. */
        async 'calendar.update'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') no(`${target.title}: changing an event is Microsoft-only for now`);
            if (!a.id) no('update needs the event id (from the list)');
            const patch = {};
            if (a.title !== undefined) patch.subject = String(a.title);
            if (a.start !== undefined) patch.start = { dateTime: String(a.start), timeZone: 'UTC' };
            if (a.end !== undefined) patch.end = { dateTime: String(a.end), timeZone: 'UTC' };
            if (a.where !== undefined) patch.location = { displayName: String(a.where) };
            if (a.notes !== undefined) patch.body = { contentType: 'text', content: String(a.notes) };
            if (a.with !== undefined) patch.attendees = String(a.with).split(',').map((x) => x.trim()).filter(Boolean).map((e) => ({ emailAddress: { address: e }, type: 'required' }));
            if (!Object.keys(patch).length) no('update needs at least one of: title, start, end, where, notes, with');
            const res = await call(target, ctx, 'PATCH', API.microsoft.event(String(a.id)), patch);
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: the event was not changed (${res.status} ${await bodyError(res)})`.trim());
            return { text: 'Updated the event.', size: 0 };
        },
    };

    return {
        name: 'calendar',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        close() { tokens.clear(); },
        shutdown() { tokens.clear(); },
    };
}
