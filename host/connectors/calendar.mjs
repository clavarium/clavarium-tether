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
 *   -- OR, a classic calendar (OVH, Infomaniak, Nextcloud, SOGo...; no provider) over CalDAV --
 *   target.config.caldav     the calendar's address, or just its server's (it is found)
 *   target.config.calendar   optional: which calendar, by name, when there are several
 *   target.config.user       the account (sign-in name and email)
 *   target.secrets.password  the NAME of the password in the host's secret store
 *
 * Google and the classic calendars share one CalDAV path (host/dav.mjs): every verb
 * works on both; Microsoft goes over Graph.
 *
 * Reads (watch): calendar.list, calendar.read, calendar.freebusy. Acts (above watch): calendar.create.
 * `fetch` is injected for tests. (Note: the Thunderbird client covers Google calendar
 * cleanly; a Microsoft calendar needs the right Graph scope on the connected account.)
 */
import { no, Refused } from '../../server/verbs.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { refreshAccess, thunderbird, PROVIDERS } from '../oauth.mjs';
import { discover, responses, props, prop, setProps, eventOf, newEvent, newUid, escapeText, timeLine, stamp, localToUtc, TZ as DAV_TZ } from '../dav.mjs';

const LIST_MAX = 200;           /* events a list returns at most, then it says so (a year holds many) */
const TZ = 'Europe/Paris';      /* the person's timezone: events are shown and created in it, not UTC */
/* A Graph/ISO datetime, shown short and local: "2026-11-10 16:00". */
const shortWhen = (dt) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(dt || '')); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (dt || '?'); };
const READ_MAX = 256 * 1024;
const dateField = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : { dateTime: s });
/* A Graph time: the local ISO time the tool takes, in the person's timezone (create AND update: never UTC).
   A bare date is midnight of that day (an all-day event, isAllDay). */
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '').trim());
const msTime = (s) => ({ dateTime: isDay(s) ? `${String(s).trim()}T00:00:00` : String(s), timeZone: TZ });
/* An all-day event ends the day AFTER its last day (the end is exclusive, everywhere): "from the 10th to
   the 10th" is one day, never an empty event. Both ends a date, or neither. */
export function dayEnd(start, end) {
    if (isDay(start) !== isDay(end)) no('an all-day event has dates for both start and end (2026-11-10); a timed one, times for both');
    if (!isDay(start) || String(end).trim() > String(start).trim()) return end;
    const d = new Date(`${String(start).trim()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}
/* The days an all-day event covers, said the same everywhere: its first day, then its LAST day (the stored end
   is the day after). A timed event: its start (loop 14). */
const lastDayOf = (end) => { const d = new Date(`${String(end).trim()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
export function daysSaid(start, end) {
    if (!isDay(start)) return String(start);
    const last = end && isDay(end) ? lastDayOf(dayEnd(start, end)) : String(start).trim();
    return last > String(start).trim() ? `${String(start).trim()} to ${last} included, all day` : `${String(start).trim()}, all day`;
}
const htmlText = (html) => String(html ?? '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const TIMEOUT_MS = 60_000;
/* WHO IS "INSIDE" (calendar-attach, loop 7): a participant on the organiser's own domain -- unless that domain
   is a public mailbox provider, where a namesake domain says nothing: there, everyone but the account is outside. */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com', 'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'gmx.com', 'gmx.fr', 'gmx.de', 'web.de', 'proton.me', 'protonmail.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'neuf.fr', 'bbox.fr', 'yandex.com', 'mail.com', 'zoho.com']);
export const insideOf = (org) => { const o = String(org ?? '').toLowerCase(); const dom = o.split('@')[1] || ''; return (addr) => { const x = String(addr ?? '').toLowerCase(); return x === o || (Boolean(dom) && !PUBLIC_DOMAINS.has(dom) && x.endsWith(`@${dom}`)); }; };

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
        list: (n, { from, to } = {}) => `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$top=${n}&$orderby=start/dateTime&$select=id,subject,start,end,location,categories`,
        event: (id) => `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`,
        create: 'https://graph.microsoft.com/v1.0/me/events',
        items: (j) => j.value ?? [],
        brief: (e) => `${e.id}\n  ${shortWhen(e.start?.dateTime)} — ${e.subject ?? '(no title)'}${e.location?.displayName ? `  @ ${e.location.displayName}` : ''}${e.categories?.length ? `  [${e.categories.join(', ')}]` : ''}`,
        body: ({ title, start, end, where, notes, attendees, categories }) => ({
            subject: title,
            start: msTime(start), end: msTime(end), ...(isDay(start) ? { isAllDay: true } : {}),
            ...(where ? { location: { displayName: where } } : {}),
            ...(notes ? { body: { contentType: 'text', content: String(notes) } } : {}),
            ...(attendees?.length ? { attendees: attendees.map((a) => ({ emailAddress: { address: a }, type: 'required' })) } : {}),
            ...(categories?.length ? { categories } : {}),
        }),
    },
};

/* Outlook's own category colours (Graph preset ids), shown by name when the
 * mailbox's categories are listed. Reference data, not a setting. */
const COLOR_NAME = {
    none: 'no colour', preset0: 'red', preset1: 'orange', preset2: 'brown', preset3: 'yellow', preset4: 'green',
    preset5: 'teal', preset6: 'olive', preset7: 'blue', preset8: 'purple', preset9: 'cranberry', preset10: 'steel',
    preset11: 'dark steel', preset12: 'grey', preset13: 'dark grey', preset14: 'black', preset15: 'dark red',
    preset16: 'dark orange', preset17: 'dark brown', preset18: 'dark yellow', preset19: 'dark green', preset20: 'dark teal',
    preset21: 'dark olive', preset22: 'dark blue', preset23: 'dark purple', preset24: 'dark cranberry',
};
/* A colour a person names, back to its Graph preset id (the reverse of COLOR_NAME);
 * a presetN given straight through is kept. Unknown names fall to null (refused). */
const COLOR_PRESET = Object.fromEntries(Object.entries(COLOR_NAME).map(([preset, name]) => [name, preset]));
const presetOf = (colour) => { const c = String(colour ?? '').trim().toLowerCase(); return /^preset(\d|1\d|2[0-4])$/.test(c) || c === 'none' ? c : (COLOR_PRESET[c] ?? null); };
/* The categories asked for, as a clean list (empty array clears them). */
const catsOf = (a) => (Array.isArray(a.categories) ? a.categories.map((c) => String(c).trim()).filter(Boolean) : (a.categories ? [String(a.categories).trim()].filter(Boolean) : null));


/* Notes as HTML (03-11): plain text, escaped, its lines kept. */
const notesHtml = (text) => `<div>${String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/\r?\n/g, '<br>')}</div>`;
/* The Teams join block of an event's HTML body, as it was: from the line of underscores above its join link
   to the end of the body; without one, a plain link to join (so no invitation is ever left without it). */
export function teamsBlockOf(html, joinUrl) {
    const body = String(html ?? '').replace(/<\/body>\s*<\/html>\s*$/i, '');
    const inner = (/<body[^>]*>([\s\S]*)$/i.exec(body)?.[1]) ?? body;
    const at = joinUrl ? inner.indexOf(joinUrl.replace(/&/g, '&amp;')) >= 0 ? inner.indexOf(joinUrl.replace(/&/g, '&amp;')) : inner.indexOf(joinUrl) : inner.search(/teams\.microsoft\.com\/l\/meetup-join/i);
    if (at >= 0) {
        const rule = inner.lastIndexOf('________________', at);
        const from = rule >= 0 ? Math.max(0, inner.lastIndexOf('<div', rule)) : inner.lastIndexOf('<div', at);
        if (from >= 0) return inner.slice(from);
    }
    return joinUrl ? `<div><br>________________________________________________________________________________<br><a href="${String(joinUrl).replace(/"/g, '&quot;')}">Microsoft Teams meeting — join</a><br>________________________________________________________________________________</div>` : '';
}

export function calendar({ fetch: fetchImpl = globalThis.fetch } = {}) {
    const tokens = new Map();
    /* 'google' or 'microsoft' by its provider; with none, a classic CalDAV calendar. */
    const providerOf = (target) => {
        const p = String(target.config?.provider ?? '').trim();
        if (!p && String(target.config?.caldav ?? '').trim()) return 'caldav';
        if (!API[p] || !PROVIDERS[p]) no(`${target.title}: set its provider to google or microsoft, or its calendar address (caldav)`);
        return p;
    };

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
        try { res = await fetchImpl(url, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: ${e?.name === 'TimeoutError' ? 'the calendar did not answer in time' : 'cannot reach the calendar'}${method === 'GET' ? '' : ' -- it may have been done: check before asking again'}`); }
        if (res.status === 401 || res.status === 403) no(`${target.title}: not authorized -- reconnect the account (the calendar scope may be missing)`);
        return res;
    }
    const bodyError = async (res) => { try { const j = await res.json(); return j?.error?.message || ''; } catch { return ''; } };

    /* ---------- CalDAV: Google and the classic calendars ----------
       Google's REST Calendar API needs that API turned on in the OAuth client's own
       project; the borrowed Thunderbird client is a CalDAV client (that is how it
       reads Google calendars), so Google is spoken to over CalDAV with its token.
       A classic calendar is the same protocol with a user and a password. One path
       for both: list, read, create, change, delete, answer an invitation, label,
       join a file, others' availability (where the server offers it). */
    const userOf = (target) => { const u = String(target.config?.user ?? '').trim(); if (!u) no(`${target.title}: ${providerOf(target) === 'google' ? 'reconnect the account so it carries its address (the Google calendar needs it)' : 'set its account (user)'}`); return u; };
    const CALDAV = (user) => `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(user)}/events/`;
    const folders = new Map();   /* target.id -> its calendar folder, once found */
    /* A request to the calendar server with the target's credentials. */
    function davRequest(target, ctx) {
        return async (method, url, { headers = {}, body } = {}) => {
            let auth;
            if (providerOf(target) === 'google') auth = `Bearer ${await access(target, ctx)}`;
            else {
                const password = await ctx.secret('password');
                if (!password) no(`${target.title}: its password is empty`);
                auth = `Basic ${Buffer.from(`${userOf(target)}:${password}`, 'utf8').toString('base64')}`;
            }
            let res;
            try { res = await fetchImpl(url, { method, headers: { Authorization: auth, ...headers }, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
            catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: ${e?.name === 'TimeoutError' ? 'the calendar did not answer in time' : 'cannot reach the calendar'}${['GET', 'PROPFIND', 'REPORT', 'OPTIONS'].includes(method) ? '' : ' -- it may have been done: check before asking again'}`); }
            if (res.status === 401 || res.status === 403) no(providerOf(target) === 'google' ? `${target.title}: not authorized -- reconnect the account (the calendar scope may be missing)` : `${target.title}: the calendar refused the user or the password`);
            return res;
        };
    }
    async function folderOf(target, ctx) {
        if (providerOf(target) === 'google') return CALDAV(userOf(target));
        if (folders.has(target.id)) return folders.get(target.id);
        let start;
        try { start = new URL(/^https?:\/\//i.test(target.config.caldav) ? target.config.caldav : `https://${target.config.caldav}`).href; }
        catch { no(`${target.title}: its calendar address is not an address`); }
        if (!start.startsWith('https://')) no(`${target.title}: the calendar address must be https`);
        const found = await discover(davRequest(target, ctx), start, 'calendar', target.config?.calendar);
        folders.set(target.id, found);
        return found;
    }
    /* DOES THIS SERVER TELL THE OTHERS? Invitations, updates, cancellations and answers reach people only
       when the server schedules itself (RFC 6638: "calendar-auto-schedule" in the DAV header of OPTIONS).
       Asked once per target; what the result says follows it, never promised blindly (#8). */
    const scheduling = new Map();
    async function schedules(target, ctx) {
        if (scheduling.has(target.id)) return scheduling.get(target.id);
        let yes = false;
        try { const res = await davRequest(target, ctx)('OPTIONS', await folderOf(target, ctx)); yes = /calendar-auto-schedule/i.test(res.headers?.get?.('dav') ?? ''); } catch { /* unknown: said as not */ }
        scheduling.set(target.id, yes);
        return yes;
    }
    const NOT_TOLD = 'this calendar server sends no invitations (it does not schedule): they are NOT told -- tell them yourself, e.g. by mail';
    /* A REPEATING EVENT on CalDAV (loop 22): its id is the whole series (every occurrence shares it; Microsoft lists
       each occurrence with its own id). A change, a delete, an answer apply to every occurrence: said, never silent. */
    const SERIES = ' It is a repeating event: this applied to the WHOLE series (every occurrence), not one date.';
    /* A date of the series changed on its own is a VEVENT of its own (RECURRENCE-ID): a change of the series does not
       reach it -- said, with its dates (loop 23). Delete removes the whole resource, overrides included. */
    /* What a CalDAV resource holds of a series: is it one, is its first part a single date, which dates are changed on their own. */
    const seriesOf = (raw) => {
        const blocks = String(raw).replace(/\r?\n[ \t]/g, '').split(/BEGIN:VEVENT/i).slice(1).map((b) => b.split(/END:VEVENT/i)[0]);
        return { series: blocks.some((b) => /^RRULE/im.test(b)), first: /^RECURRENCE-ID/im.test(blocks[0] ?? ''),
            own: blocks.filter((b) => /^RECURRENCE-ID/im.test(b)).map((b) => /^RECURRENCE-ID[^:]*:(\d{4})(\d{2})(\d{2})/im.exec(b)).filter(Boolean).map((m) => `${m[1]}-${m[2]}-${m[3]}`) };
    };
    async function wholeSeries(target, ctx, id, act, { removes = false } = {}) {
        let series = false; let own = [];
        try {
            const got = seriesOf((await davGet(target, ctx, id)).text);
            series = got.series;
            if (series && got.first && !removes) no(`${target.title}: this event's first part is one date of a series, not the series -- nothing was done; change it in a calendar program`);
            own = got.own;
        } catch (e) { if (e instanceof Refused) throw e; /* the act reads it itself, and says */ }
        const r = await act();
        if (!series) return r;
        const kept = !removes && own.length ? ` ${own.length} date${own.length === 1 ? '' : 's'} changed on ${own.length === 1 ? 'its' : 'their'} own (${own.join(', ')}) keep${own.length === 1 ? 's' : ''} ${own.length === 1 ? 'its' : 'their'} own values.` : '';
        return { ...r, text: `${r.text}${kept ? ` It is a repeating event: this applied to the series, not one date.${kept}` : SERIES}` };
    }
    const urlOf = async (target, ctx, id) => { const s = String(id ?? '').trim(); if (!s) no('that needs the event id (from the list)'); return /^https?:\/\//.test(s) ? s : new URL(s, await folderOf(target, ctx)).href; };
    const XML = { 'Content-Type': 'application/xml; charset=utf-8' };
    /* The events of a window: with `expand`, one entry per occurrence (to show);
       without, each event's own text once (to change). */
    async function davEvents(target, ctx, { from, to, expand = true }) {
        const s = stamp(new Date(from)); const e = stamp(new Date(to));
        const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data>${expand ? `<C:expand start="${s}" end="${e}"/>` : ''}</C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${s}" end="${e}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
        const res = await davRequest(target, ctx)('REPORT', await folderOf(target, ctx), { headers: { Depth: '1', ...XML }, body });
        if (!res.ok && res.status !== 207) no(`${target.title}: the calendar could not be read (${res.status})`);
        const out = [];
        for (const r of responses(await res.text())) {
            const data = r.value('calendar-data');
            if (!data) continue;
            if (!expand) { out.push({ href: r.href, etag: r.value('getetag'), text: data }); continue; }
            for (const piece of data.split(/BEGIN:VEVENT/i).slice(1)) {
                const ev = eventOf(`BEGIN:VEVENT${piece.split(/END:VEVENT/i)[0]}END:VEVENT`);
                if (ev.summary || ev.start) out.push({ href: r.href, ...ev, series: /RECURRENCE-ID/i.test(piece) || /^RRULE/im.test(data) });
            }
        }
        return out;
    }
    /* One event's text and version tag, to change it without losing what it holds. */
    async function davGet(target, ctx, id) {
        const url = await urlOf(target, ctx, id);
        const res = await davRequest(target, ctx)('GET', url, { headers: { Accept: 'text/calendar' } });
        if (res.status === 404) no('no such event');
        if (!res.ok) no(`${target.title}: that event could not be read (${res.status})`);
        return { url, etag: res.headers?.get?.('etag') ?? null, text: await res.text() };
    }
    async function davPut(target, ctx, url, text, { etag, create } = {}) {
        const res = await davRequest(target, ctx)('PUT', url, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...(create ? { 'If-None-Match': '*' } : etag ? { 'If-Match': etag } : {}) }, body: text });
        if (res.status === 412) no(`${target.title}: the event changed meanwhile -- read it again`);
        if (!res.ok) no(`${target.title}: the calendar refused the change (${res.status})`);
        return res;
    }
    const briefOf = (ev) => `${ev.href || '(no id)'}${ev.series ? '  (repeats: this id is the WHOLE series)' : ''}\n  ${ev.start || '?'} — ${ev.summary || '(no title)'}${ev.location ? `  @ ${ev.location}` : ''}${ev.categories.length ? `  [${ev.categories.join(', ')}]` : ''}`;
    const PARTSTAT = { accept: 'ACCEPTED', yes: 'ACCEPTED', decline: 'DECLINED', no: 'DECLINED', refuse: 'DECLINED', tentative: 'TENTATIVE', maybe: 'TENTATIVE' };
    const FILE_MAX = 5 * 1024 * 1024;   /* bytes of a file kept inside an event */
    const yearAround = () => ({ from: new Date(Date.now() - 366 * 86_400_000).toISOString(), to: new Date(Date.now() + 2 * 366 * 86_400_000).toISOString() });
    const attendeeLines = (list) => list.map((x) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${x}`);
    const MEET = (target) => `${target.title}: ${providerOf(target) === 'google' ? 'a Meet link needs Google\'s own calendar API, which this connection does not reach yet' : 'this calendar makes no online meeting'} -- give the link in where or notes, or online "none"`;

    const davVerbs = {
        async list(target, a, ctx, { from, to }, pack) {
            let evs = await davEvents(target, ctx, { from, to });
            if (a.category) { const want = String(a.category).toLowerCase(); evs = evs.filter((e) => e.categories.some((c) => c.toLowerCase() === want)); }
            evs.sort((x, y) => String(x.start).localeCompare(String(y.start)));
            return pack(evs.map(briefOf));
        },
        async read(target, a, ctx) {
            const { text } = await davGet(target, ctx, a.id);
            const ev = eventOf(text);
            const lines = [`${ev.summary || '(no title)'}`, `  ${ev.start}${ev.end ? ` — ${ev.end}` : ''} (${DAV_TZ})`];
            if (ev.location) lines.push(`  @ ${ev.location}`);
            if (ev.organizer) lines.push(`  organiser: ${ev.organizer}`);
            if (ev.attendees.length) lines.push(`  with: ${ev.attendees.map((x) => `${x.email}${x.status ? ` (${x.status})` : ''}`).join(', ')}`);
            if (ev.categories.length) lines.push(`  categories: ${ev.categories.join(', ')}`);
            if (ev.files.length) lines.push(`  files: ${ev.files.map((f) => f.name).join(', ')}`);
            if (ev.notes) lines.push('', ev.notes);
            const out = lines.join('\n').slice(0, READ_MAX);
            return { text: out, size: Buffer.byteLength(out) };
        },
        async create(target, a, ctx, { attendees, categories, online }) {
            if (online !== 'none') no(MEET(target));
            const uid = newUid();
            const url = new URL(`${uid}.ics`, await folderOf(target, ctx)).href;
            await davPut(target, ctx, url, newEvent({ uid, title: a.title, start: a.start, end: dayEnd(a.start, a.end), where: a.where, notes: a.notes, attendees, organizer: attendees.length ? userOf(target) : null, categories: categories ?? [] }), { create: true });
            const sched = attendees.length ? await schedules(target, ctx) : false;
            const told = attendees.length ? (sched ? `, invitations to ${attendees.join(', ')} (sent by the calendar server)` : `, invitations to ${attendees.join(', ')}: ${NOT_TOLD}`) : '';
            /* Answers come back only through scheduling: watched only then (loop 3). */
            return { text: `Created: ${a.title} (${daysSaid(a.start, a.end)})${told}. Its id is ${new URL(url).pathname}.`, size: 0, watch: sched ? { id: new URL(url).pathname, title: a.title, start: a.start } : null };
        },
        async update(target, a, ctx) {
            const { url, etag, text } = await davGet(target, ctx, a.id);
            let t = text; let changed = 0;
            const set = (name, lines) => { t = setProps(t, name, lines); changed++; };
            if (a.title !== undefined) set('SUMMARY', [`SUMMARY:${escapeText(a.title)}`]);
            if (a.start !== undefined) set('DTSTART', [timeLine('DTSTART', a.start)]);
            /* An end alone on an all-day event follows the same rule, against its current start (loop 15). */
            const curStart = eventOf(text).start;
            if (a.end !== undefined) set('DTEND', [timeLine('DTEND', a.start !== undefined ? dayEnd(a.start, a.end) : isDay(curStart) && isDay(a.end) ? dayEnd(curStart, a.end) : a.end)]);
            if (a.where !== undefined) set('LOCATION', String(a.where).trim() ? [`LOCATION:${escapeText(a.where)}`] : []);
            if (a.notes !== undefined) set('DESCRIPTION', String(a.notes).trim() ? [`DESCRIPTION:${escapeText(a.notes)}`] : []);
            if (a.with !== undefined) {
                const list = String(a.with).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
                const had = new Map(props(t, 'ATTENDEE').map((p) => [p.value.replace(/^mailto:/i, '').toLowerCase(), p.raw]));
                set('ATTENDEE', list.map((x) => had.get(x.toLowerCase()) ?? attendeeLines([x])[0]));
                if (list.length && !prop(t, 'ORGANIZER')) set('ORGANIZER', [`ORGANIZER:mailto:${userOf(target)}`]);
            }
            if (a.categories !== undefined) { const c = catsOf(a) ?? []; set('CATEGORIES', c.length ? [`CATEGORIES:${c.map(escapeText).join(',')}`] : []); }
            if (a.online !== undefined && String(a.online).toLowerCase() !== 'none') no(MEET(target));
            if (!changed) no('update needs at least one of: title, start, end, where, notes, with, category');
            const seq = Number(prop(t, 'SEQUENCE')?.value ?? 0);
            t = setProps(t, 'SEQUENCE', [`SEQUENCE:${seq + 1}`]);
            t = setProps(t, 'DTSTAMP', [`DTSTAMP:${stamp(new Date())}`]);
            await davPut(target, ctx, url, t, { etag });
            const before = eventOf(text); const after = eventOf(t);
            const mine = !before.organizer || before.organizer.toLowerCase() === userOf(target).toLowerCase();
            const others = after.attendees.map((x) => x.email).filter((x) => x.toLowerCase() !== userOf(target).toLowerCase());
            const gone = before.attendees.map((x) => x.email).filter((x) => !after.attendees.some((y) => y.email.toLowerCase() === x.toLowerCase()));
            const sched = (others.length || gone.length) && mine ? await schedules(target, ctx) : false;
            const told = !mine ? (others.length ? ` You are not the organiser (${before.organizer}): the change stays on this calendar, the others do not see it.` : '') : !(others.length || gone.length) ? '' : sched ? ` The calendar server sends the change to ${others.join(', ') || 'nobody left'}${gone.length ? `, and a cancellation to ${gone.join(', ')} (removed)` : ''}.` : ` Invitees (${[...others, ...gone].join(', ')}): ${NOT_TOLD}.`;
            /* The time set, said as Microsoft's result says it (loop 4). */
            /* An all-day end is stored exclusive (the day after): said as its last day, as on Microsoft (loop 13). */
            const when = a.start !== undefined || a.end !== undefined ? ` Now ${isDay(after.start) ? daysSaid(after.start, after.end || after.start) : `${after.start}${after.end ? ` — ${after.end}` : ''}`} (${DAV_TZ}).` : '';
            return { text: `Updated the event.${when}${told}`, size: 0, watch: a.with !== undefined && others.length && sched ? { id: new URL(url).pathname, title: after.summary, start: after.start } : null };
        },
        async remove(target, a, ctx) {
            const url = await urlOf(target, ctx, a.id);
            /* Read first: who it concerns is said; unread, nothing is deleted (loop 10). */
            const ev = eventOf((await davGet(target, ctx, url)).text);
            const res = await davRequest(target, ctx)('DELETE', url, {});
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: the event was not deleted (${res.status})`);
            const me = userOf(target).toLowerCase();
            const others = (ev?.attendees ?? []).map((x) => x.email).filter((x) => x.toLowerCase() !== me);
            const mine = !ev.organizer || ev.organizer.toLowerCase() === me;
            if (!others.length && mine) return { text: 'Deleted the event.', size: 0 };
            const sched = await schedules(target, ctx);
            if (!mine) return { text: `Deleted the event from this calendar. You were invited (organiser ${ev.organizer}): the organiser is not told that you will not come${sched ? ' (this server may send them a note)' : ''} -- calendar-respond decline is the way to say no.`, size: 0 };
            return { text: `Deleted the event.${sched ? ` The calendar server sends a cancellation to ${others.join(', ')}.` : ` Invitees (${others.join(', ')}): ${NOT_TOLD.replace('invitations', 'cancellations')}.`}`, size: 0 };
        },
        /* An answer is this account's PARTSTAT on the event; the server tells the
           organiser (CalDAV scheduling). */
        async respond(target, a, ctx, part) {
            const { url, etag, text } = await davGet(target, ctx, a.id);
            const me = userOf(target).toLowerCase();
            const mine = props(text, 'ATTENDEE');
            if (!mine.some((p) => p.value.replace(/^mailto:/i, '').toLowerCase() === me)) no(`${target.title}: ${me} is not invited to that event`);
            const lines = mine.map((p) => (p.value.replace(/^mailto:/i, '').toLowerCase() === me
                ? `ATTENDEE${p.params.replace(/;PARTSTAT=[^;:]*/i, '').replace(/;RSVP=[^;:]*/i, '')};PARTSTAT=${part}:${p.value}` : p.raw));
            let t = setProps(text, 'ATTENDEE', lines);
            if (a.comment) t = setProps(t, 'COMMENT', [`COMMENT:${escapeText(a.comment)}`]);
            await davPut(target, ctx, url, t, { etag });
            const org = eventOf(text).organizer;
            const told = (await schedules(target, ctx)) ? ` The calendar server tells the organiser${org ? ` (${org})` : ''}.` : ` This calendar server does not schedule: the organiser${org ? ` (${org})` : ''} is NOT told -- tell them yourself, e.g. by mail.`;
            return { text: `${part === 'ACCEPTED' ? 'Accepted' : part === 'DECLINED' ? 'Declined' : 'Tentatively accepted'} the invitation.${told}`, size: 0 };
        },
        /* A file kept inside the event itself; read back to be sure the server kept it. */
        async attach(target, a, ctx) {
            const bytes = String(a.attach).replace(/\s+/g, '');
            if (bytes.length * 3 / 4 > FILE_MAX) no(`a file joined to an event is ${FILE_MAX / 1024 / 1024} MB at most`);
            const name = String(a.attachName || 'attachment').replace(/[";:\r\n]/g, '');
            const { url, etag, text } = await davGet(target, ctx, a.id);
            const ev = eventOf(text);
            /* Inside or outside is judged from THIS account (loop 8: from the organiser, an outsider's colleagues counted inside). */
            const me = userOf(target).toLowerCase(); const inside = insideOf(me);
            const mine = !ev.organizer || ev.organizer.toLowerCase() === me;
            const externals = [...ev.attendees.map((x) => x.email.toLowerCase()), ...(ev.organizer ? [ev.organizer.toLowerCase()] : [])].filter((x) => x !== me && !inside(x));
            if (mine && externals.length && a.share !== true) no(`${externals.length} external participant(s): ${externals.join(', ')}. The file would reach them with the event. Add --share (CLI) or share:true (MCP) to attach anyway.`);
            const lines = [...props(text, 'ATTACH').map((p) => p.raw), `ATTACH;FMTTYPE=application/octet-stream;ENCODING=BASE64;VALUE=BINARY;X-FILENAME=${name}:${bytes}`];
            await davPut(target, ctx, url, setProps(text, 'ATTACH', lines), { etag });
            /* Put: a read-back that fails says it may be there, never "not done" (loop 17). */
            let back;
            try { back = await davGet(target, ctx, a.id); } catch (e) { no(`${target.title}: the file was sent to the event, but reading it back failed (${e?.message ?? e}) -- it may have been done: read the event before asking again`); }
            const count = (t) => eventOf(t).files.filter((f) => f.name === name).length;
            if (count(back.text) <= count(text)) no(`${target.title}: the calendar did not keep the file (this server takes no file inside an event) -- send it by mail instead`);
            /* It reaches the others only through the server's scheduling (loop 2: it was said sent regardless). */
            const others = ev.attendees.map((x) => x.email).filter((x) => x.toLowerCase() !== userOf(target).toLowerCase());
            const who = !mine ? ` You are not the organiser (${ev.organizer}): the file stays on this calendar, the others do not receive it.`
                : !others.length ? ' Visible to you alone (the event has no participants).'
                : (await schedules(target, ctx)) ? ` The calendar server sends it with the event to ${others.join(', ')}.` : ` Kept in the event on this calendar; ${others.join(', ')} do NOT receive it (this server does not schedule) -- send it by mail if they need it.`;
            return { text: `Attached ${name} to the event.${who}`, size: 0 };
        },
        async detach(target, a, ctx) {
            const which = String(a.which ?? '').trim();
            if (!which) no('detach needs which attachment (its name or number)');
            const { url, etag, text } = await davGet(target, ctx, a.id);
            const all = props(text, 'ATTACH');
            if (!all.length) no('this event has no attachment');
            const files = eventOf(text).files;
            const n = /^\d+$/.test(which) ? Number(which) - 1 : files.findIndex((f) => f.name.toLowerCase().includes(which.toLowerCase()));
            if (!files[n]) no(`no attachment "${which}" — this event has: ${files.map((f) => f.name).join(', ')}`);
            await davPut(target, ctx, url, setProps(text, 'ATTACH', all.filter((_, i) => i !== n).map((p) => p.raw)), { etag });
            return { text: `Removed ${files[n].name} from the event.`, size: 0 };
        },
        /* Categories here are labels on events, with no list of their own: the
           ones in use are listed, and renaming or removing one rewrites the events
           that wear it (from a year back to two ahead). */
        async categories(target, a, ctx) {
            const seen = new Map();
            for (const ev of await davEvents(target, ctx, { ...yearAround(), expand: false })) for (const c of eventOf(ev.text).categories) seen.set(c.toLowerCase(), c);
            const text = seen.size ? `${[...seen.values()].sort().join('\n')}\n\n(Labels in use on events; a category exists as soon as an event wears it. This calendar keeps no colour per category.)` : 'No category on any event yet: tag one with --category, and it exists.';
            return { text, size: Buffer.byteLength(text) };
        },
        async categoryAdd(target, a) {
            no(`${target.title}: this calendar keeps no list of categories, and no colour for them -- a category exists as soon as an event wears it: tag events with --category "${String(a.name ?? '').trim() || 'Name'}"`);
        },
        async categoryEdit(target, a, ctx, to) {
            const want = String(a.name ?? '').trim().toLowerCase();
            if (!want) no('say which category (its name)');
            if (a.color !== undefined) no(`${target.title}: this calendar keeps no colour for categories`);
            if (to !== null && !String(to ?? '').trim()) no('rename needs a new name (--to)');
            let n = 0;
            const wearing = (await davEvents(target, ctx, { ...yearAround(), expand: false })).filter((ev) => eventOf(ev.text).categories.some((c) => c.toLowerCase() === want));
            for (const ev of wearing) {
                const cats = eventOf(ev.text).categories;
                const next = [...new Set(cats.flatMap((c) => (c.toLowerCase() === want ? (to === null ? [] : [String(to).trim()]) : [c])))];
                /* One event at a time: a failure in the middle says how far it went (#23); asking again does the rest. */
                try { await davPut(target, ctx, new URL(ev.href, await folderOf(target, ctx)).href, setProps(ev.text, 'CATEGORIES', next.length ? [`CATEGORIES:${next.map(escapeText).join(',')}`] : []), { etag: ev.etag }); }
                catch (e) { if (!n) throw e; no(`${e?.message ?? 'an event was not changed'} -- done on ${n} of ${wearing.length} events; asking again does the rest`); }
                n++;
            }
            if (!n) no(`${target.title}: no event wears the category "${a.name}"`);
            /* Dates of a series changed on their own carry their own labels: not changed here, said (loop 28). */
            const own = wearing.reduce((k, ev) => k + ev.text.replace(/\r?\n[ \t]/g, '').split(/BEGIN:VEVENT/i).slice(2).filter((b) => /^RECURRENCE-ID/im.test(b) && new RegExp(`^CATEGORIES[^:]*:.*\\b${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im').test(b)).length, 0);
            const ownSaid = own ? ` ${own} date${own === 1 ? '' : 's'} of a series changed on ${own === 1 ? 'its' : 'their'} own keep${own === 1 ? 's' : ''} it.` : '';
            return { text: `${to === null ? `Removed the category "${a.name}" from` : `Renamed "${a.name}" to "${String(to).trim()}" on`} ${n} event${n === 1 ? '' : 's'}, from a year ago to two years ahead (events outside that window keep it).${ownSaid}`, size: 0 };
        },
        /* Others' availability: the scheduling outbox (RFC 6638), where the server
           has one; it answers busy blocks only. */
        async freebusy(target, a, ctx, { who, from, to }) {
            const request = davRequest(target, ctx);
            const folder = await folderOf(target, ctx);
            const find = await request('PROPFIND', folder, { headers: { Depth: '0', ...XML }, body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>' });
            const principal = /<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)</i.exec(responses(await find.text())[0]?.value('current-user-principal') ?? '')?.[1];
            let outbox = null;
            if (principal) {
                const p = await request('PROPFIND', new URL(principal, folder).href, { headers: { Depth: '0', ...XML }, body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:schedule-outbox-URL/></D:prop></D:propfind>' });
                outbox = /<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)</i.exec(responses(await p.text())[0]?.value('schedule-outbox-URL') ?? '')?.[1] ?? null;
            }
            if (!outbox) no(`${target.title}: this calendar server does not share others' availability`);
            const me = userOf(target);
            const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//clavarium//tether//EN', 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', `UID:${newUid()}`, `DTSTAMP:${stamp(new Date())}`,
                `DTSTART:${stamp(from)}`, `DTEND:${stamp(to)}`, `ORGANIZER:mailto:${me}`, ...who.map((x) => `ATTENDEE:mailto:${x}`), 'END:VFREEBUSY', 'END:VCALENDAR', ''].join('\r\n');
            const res = await request('POST', new URL(outbox, folder).href, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', Originator: `mailto:${me}`, Recipient: who.map((x) => `mailto:${x}`).join(', ') }, body });
            if (!res.ok) no(`${target.title}: availability could not be read (${res.status})`);
            const xml = await res.text();
            const blocks = who.map((x) => {
                const part = xml.split(/<(?:[A-Za-z0-9_-]+:)?response[\s>]/i).slice(1).find((b) => b.toLowerCase().includes(`mailto:${x.toLowerCase()}`));
                const data = part ? responses(`<response>${part}`)[0]?.value('calendar-data') : null;
                if (!data) return `${x}\n  could not be read (no access, or unknown address)`;
                const busy = props(data, 'FREEBUSY', 'VFREEBUSY').flatMap((p) => p.value.split(',').map((span) => ({ kind: /FBTYPE=([^;:]+)/i.exec(p.params)?.[1] ?? 'BUSY', span })));
                if (!busy.length) return `${x}\n  free for the whole window`;
                return `${x}\n${busy.map((b) => { const [s1, e1] = b.span.split('/'); const show = (v) => (v && !v.startsWith('P') ? eventOf(`BEGIN:VEVENT\r\nDTSTART:${v}\r\nEND:VEVENT`).start : v); return `  ${b.kind.toLowerCase().replace('busy-', '')}  ${show(s1)} — ${show(e1)}`; }).join('\n')}`;
            });
            const text = `Availability (${DAV_TZ}):\n\n${blocks.join('\n\n')}`;
            return { text, size: Buffer.byteLength(text) };
        },
    };

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
            if (provider !== 'microsoft') return davVerbs.list(target, a, ctx, { from, to }, pack);
            const api = API[provider];
            const res = await call(target, ctx, 'GET', api.list(LIST_MAX, { from, to }));
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            const json = await res.json();
            let items = api.items(json);
            /* Only one category's events, matched by name without case: all this month's travel, say. */
            if (a.category) { const want = String(a.category).toLowerCase(); items = items.filter((e) => (e.categories ?? []).some((c) => String(c).toLowerCase() === want)); }
            return pack(items.map(api.brief), Boolean(json['@odata.nextLink']));
        },
        /* One event in full, by its id. */
        async 'calendar.read'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') return davVerbs.read(target, a, ctx);
            const api = API[provider];
            const res = await call(target, ctx, 'GET', api.event(String(a.id)));
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            /* Read as the CalDAV path reads (05-11: it was a raw JSON dump): who, when, where, answers, notes. */
            const j = await res.json();
            const when = (t) => (j.isAllDay ? String(t?.dateTime ?? '').slice(0, 10) : shortWhen(t?.dateTime));
            const said = { accepted: 'accepted', declined: 'declined', tentativelyAccepted: 'tentative', notResponded: 'no answer', none: 'no answer', organizer: 'organiser' };
            const lines = [`${j.subject || '(no title)'}`, `  ${when(j.start)}${j.end ? ` — ${when(j.end)}` : ''} (${TZ})${j.isAllDay ? ', all day' : ''}${j.isCancelled ? ' -- CANCELLED' : ''}`];
            if (j.location?.displayName) lines.push(`  @ ${j.location.displayName}`);
            if (j.organizer?.emailAddress?.address) lines.push(`  organiser: ${j.organizer.emailAddress.address}${j.isOrganizer ? ' (you)' : ''}`);
            if (j.attendees?.length) lines.push(`  with: ${j.attendees.map((x) => `${x.emailAddress?.address}${x.status?.response ? ` (${said[x.status.response] ?? x.status.response})` : ''}`).join(', ')}`);
            if (!j.isOrganizer && j.responseStatus?.response) lines.push(`  your answer: ${said[j.responseStatus.response] ?? j.responseStatus.response}`);
            if (j.categories?.length) lines.push(`  categories: ${j.categories.join(', ')}`);
            if (j.isOnlineMeeting) lines.push(`  online: Teams${j.onlineMeeting?.joinUrl ? ` ${j.onlineMeeting.joinUrl}` : ''}`);
            if (j.hasAttachments) lines.push('  files: yes (calendar-detach lists them by name)');
            const notes = j.body?.contentType === 'html' ? htmlText(j.body.content) : String(j.body?.content ?? '').trim();
            if (notes) lines.push('', notes);
            lines.push('', `id: ${j.id ?? a.id}`);
            const text = lines.join('\n').slice(0, READ_MAX);
            return { text, size: Buffer.byteLength(text) };
        },
        /* See when others are busy, to find a time together. A read: it returns
           only busy/free blocks (and a title only where the person already shares
           it), never the contents of their calendars. `who` is a comma-separated
           list of addresses; `from`/`to` bound the window (default: the next 7
           days). Microsoft over Graph getSchedule; a Google free/busy query comes
           with parity (its REST path needs the account's own OAuth app). */
        async 'calendar.freebusy'(target, a, ctx) {
            const provider = providerOf(target);
            const who = String(a.who ?? '').split(',').map((x) => x.trim()).filter(Boolean);
            if (!who.length) no('freebusy needs at least one address (comma-separated)');
            if (who.length > 20) no('freebusy looks at up to 20 people at once');
            if (provider !== 'microsoft') {
                const from = a.from ? localToUtc(/^\d{4}-\d{2}-\d{2}$/.test(String(a.from).trim()) ? `${String(a.from).trim()}T00:00` : a.from) : new Date();
                const to = a.to ? localToUtc(/^\d{4}-\d{2}-\d{2}$/.test(String(a.to).trim()) ? `${String(a.to).trim()}T00:00` : a.to) : new Date(from.getTime() + 7 * 86_400_000);
                return davVerbs.freebusy(target, a, ctx, { who, from, to });
            }
            /* A window in the person's own wall-clock (Europe/Paris), passed with
               that timezone so "09:00" means 09:00 there. Default: now → +7 days. */
            const localISO = (d) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`; };
            const norm = (s) => { const t = String(s).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t}T00:00:00`; if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) return `${t}:00`; return t; };
            const now = new Date();
            const from = a.from ? norm(a.from) : localISO(now);
            const to = a.to ? norm(a.to) : localISO(new Date(now.getTime() + 7 * 86_400_000));
            const res = await call(target, ctx, 'POST', 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
                schedules: who,
                startTime: { dateTime: from, timeZone: TZ }, endTime: { dateTime: to, timeZone: TZ },
                availabilityViewInterval: 60,
            });
            if (!res.ok) no(`${target.title}: availability could not be read (${res.status} ${await bodyError(res)})`.trim());
            const value = (await res.json()).value ?? [];
            const label = { tentative: 'tentative', busy: 'busy', oof: 'out of office', workingElsewhere: 'working elsewhere' };
            const blocks = value.map((s) => {
                const id = s.scheduleId || '(unknown)';
                if (s.error) return `${id}\n  could not be read (no access, or unknown address)`;
                const items = (s.scheduleItems ?? []).filter((it) => it.status && it.status !== 'free');
                if (!items.length) return `${id}\n  free for the whole window`;
                return `${id}\n` + items.map((it) => `  ${label[it.status] || it.status}  ${shortWhen(it.start?.dateTime)} — ${shortWhen(it.end?.dateTime)}${it.subject ? `  (${it.subject})` : ''}`).join('\n');
            });
            const text = value.length ? `Availability ${shortWhen(from)} → ${shortWhen(to)} (${TZ}):\n\n${blocks.join('\n\n')}` : 'No availability returned.';
            return { text, size: Buffer.byteLength(text) };
        },
        /* Create an event. An act: the start and end are ISO times (a bare date is all-day). */
        async 'calendar.create'(target, a, ctx) {
            const provider = providerOf(target);
            const api = API[provider];
            if (!a.title) no('an event needs a title');
            if (!a.start || !a.end) no('an event needs a start and an end (local ISO times, e.g. 2026-11-10T16:00:00)');
            const categories = catsOf(a);
            const attendees = String(a.with ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
            /* An online (Teams) meeting: on by default once there are participants, off
               with --online none. Microsoft only (Teams); Graph makes the meeting + link. */
            const online = a.online !== undefined ? String(a.online).toLowerCase() : (attendees.length && provider === 'microsoft' ? 'teams' : 'none');
            if (provider !== 'microsoft') return davVerbs.create(target, a, ctx, { attendees, categories, online });
            if (online !== 'none' && online !== 'teams') no('--online is teams or none');
            const payload = api.body({ title: a.title, start: a.start, end: dayEnd(a.start, a.end), where: a.where, notes: a.notes, attendees, categories: categories ?? undefined });
            if (provider === 'microsoft' && online === 'teams') { payload.isOnlineMeeting = true; payload.onlineMeetingProvider = 'teamsForBusiness'; }
            const res = await call(target, ctx, 'POST', api.create, payload);
            if (!res.ok) no(`${target.title}: the event was not created (${res.status} ${await bodyError(res)})`.trim());
            const made = await res.json().catch(() => ({}));
            const teams = online !== 'teams' ? '' : made.isOnlineMeeting === false ? ', but Microsoft did NOT make its Teams meeting (add it with online "teams")' : made.isOnlineMeeting === true ? ', with a Teams meeting' : ', with a Teams meeting asked (read the event for its join link)';
            return { text: `Created: ${a.title} (${daysSaid(a.start, a.end)})${teams}${attendees.length ? `, invitations to ${attendees.join(', ')} (sent by Microsoft)` : ''}. Its id is ${made.id ?? '(unknown)'}.`, size: 0, watch: attendees.length && made.id ? { id: made.id, title: a.title, start: a.start } : null };
        },
        /* Join a file to an event. An act. Microsoft takes the bytes inline (Graph
           fileAttachment); a Google calendar attach is a Drive link, added once the
           files connector is in -- for now it is Microsoft only. */
        async 'calendar.attach'(target, a, ctx) {
            const provider = providerOf(target);
            if (!a.id) no('attach needs the event id (from the list)');
            if (!a.attach) no('attach needs the file (its base64 bytes)');
            if (provider !== 'microsoft') return wholeSeries(target, ctx, a.id, () => davVerbs.attach(target, a, ctx));
            const ev = encodeURIComponent(String(a.id));
            /* Who would receive the file: an event attachment reaches every participant
               on the next invitation update or resend. Split internal from external by
               the organiser's domain, and refuse an external audience unless `share`. */
            const internals = []; const externals = [];
            const info = await call(target, ctx, 'GET', `https://graph.microsoft.com/v1.0/me/events/${ev}?$select=attendees,organizer,isOrganizer`);
            let mine = true;
            /* Who would receive it must be known before: an unread list is never taken as "nobody" (loop 5). */
            if (info.status === 404) no('no such event');
            if (!info.ok) no(`${target.title}: its participants could not be read (${info.status}) -- nothing was attached`);
            {
                const j = await info.json().catch(() => ({}));
                const org = (j.organizer?.emailAddress?.address || target.config?.user || '').toLowerCase();
                mine = j.isOrganizer !== false;
                const me = String(target.config?.user || org).toLowerCase();
                const inside = insideOf(me);
                for (const at of [...(j.attendees ?? []).map((x) => x.emailAddress?.address), ...(mine ? [] : [org])]) {
                    if (!at || at.toLowerCase() === me || at.toLowerCase() === org && mine) continue;
                    (inside(at) ? internals : externals).push(at);
                }
            }
            if (mine && externals.length && a.share !== true) {
                no(`${externals.length} external participant(s): ${externals.join(', ')}. The file would reach them on the next invitation update/resend. Add --share (CLI) or share:true (MCP) to attach anyway.`);
            }
            const att = { '@odata.type': '#microsoft.graph.fileAttachment', name: String(a.attachName || 'attachment'), contentBytes: String(a.attach) };
            const res = await call(target, ctx, 'POST', `https://graph.microsoft.com/v1.0/me/events/${ev}/attachments`, att);
            if (!res.ok) no(`${target.title}: the file was not attached (${res.status} ${await bodyError(res)})`.trim());
            const all = internals.length + externals.length;
            const who = !mine ? ' You are not the organiser: the file stays on your copy of the event, the others do not receive it.' : all
                ? ` It will reach ${all} participant(s) on the next invitation update/resend:${internals.length ? ` ${internals.join(', ')} (internal)` : ''}${externals.length ? `${internals.length ? ';' : ''} ${externals.join(', ')} (external)` : ''}.`
                : ' Visible to you alone (the event has no participants).';
            return { text: `Attached ${a.attachName || 'the file'} to the event.${who}`, size: 0 };
        },
        /* Remove a file from an event, by its name or 1-based number. An act.
           Microsoft only, like attaching (Graph deletes the attachment by id). */
        async 'calendar.detach'(target, a, ctx) {
            const provider = providerOf(target);
            if (!a.id) no('detach needs the event id (from the list)');
            if (provider !== 'microsoft') return wholeSeries(target, ctx, a.id, () => davVerbs.detach(target, a, ctx));
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
            if (provider !== 'microsoft') return wholeSeries(target, ctx, a.id, () => davVerbs.remove(target, a, ctx), { removes: true });
            const who = await peopleOf(target, ctx, a.id);
            const res = await call(target, ctx, 'DELETE', API.microsoft.event(String(a.id)));
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: the event was not deleted (${res.status} ${await bodyError(res)})`.trim());
            /* What Microsoft does to the others, said (#12): the organiser's delete cancels for every invitee;
               an invitee's delete only takes it off this calendar, the organiser is not told. */
            if (who && !who.isOrganizer) return { text: `Deleted the event from this calendar. You were invited (organiser ${who.organizer || 'unknown'}): the organiser is NOT told -- calendar-respond decline is the way to say no.`, size: 0 };
            return { text: `Deleted the event.${who?.attendees.length ? ` Microsoft sends a cancellation to ${who.attendees.join(', ')}.` : ''}`, size: 0 };
        },
        /* Respond to a meeting invitation: accept, decline or tentative. An act.
           Microsoft over Graph; a Google RSVP (CalDAV PARTSTAT) comes with parity. */
        async 'calendar.respond'(target, a, ctx) {
            const provider = providerOf(target);
            if (!a.id) no('respond needs the event id (from the list)');
            const map = { accept: 'accept', yes: 'accept', decline: 'decline', no: 'decline', refuse: 'decline', tentative: 'tentativelyAccept', maybe: 'tentativelyAccept' };
            const action = map[String(a.answer ?? '').toLowerCase().trim()];
            if (!action) no('answer is accept, decline or tentative');
            if (provider !== 'microsoft') return wholeSeries(target, ctx, a.id, () => davVerbs.respond(target, a, ctx, PARTSTAT[String(a.answer).toLowerCase().trim()]));
            const body = { sendResponse: true, ...(a.comment ? { comment: String(a.comment) } : {}) };
            const who = await peopleOf(target, ctx, a.id).catch(() => null);   /* only to name the organiser */
            const res = await call(target, ctx, 'POST', `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(String(a.id))}/${action}`, body);
            if (!res.ok) no(`${target.title}: the response was not sent (${res.status} ${await bodyError(res)})`.trim());
            /* Said as on CalDAV (loop 4): who is told. */
            return { text: `${action === 'accept' ? 'Accepted' : action === 'decline' ? 'Declined' : 'Tentatively accepted'} the invitation. Microsoft tells the organiser${who?.organizer ? ` (${who.organizer})` : ''}.`, size: 0 };
        },
        /* Change an event: any of title, start, end, where. An act. Microsoft over
           Graph (PATCH); a Google edit (CalDAV PUT) comes with parity. */
        async 'calendar.update'(target, a, ctx) {
            const provider = providerOf(target);
            if (!a.id) no('update needs the event id (from the list)');
            if (provider !== 'microsoft') return wholeSeries(target, ctx, a.id, () => davVerbs.update(target, a, ctx));
            const patch = {};
            if (a.title !== undefined) patch.subject = String(a.title);
            if (a.start !== undefined) { patch.start = msTime(a.start); patch.isAllDay = isDay(a.start); }
            /* Read first (who it concerns, and the event's own start and end, to say what it now covers). */
            const who = await peopleOf(target, ctx, a.id);
            const curDay = who.isAllDay ? String(who.start).slice(0, 10) : null;
            const endAs = a.end === undefined ? undefined : a.start !== undefined ? dayEnd(a.start, a.end) : curDay && isDay(a.end) ? dayEnd(curDay, a.end) : a.end;
            if (a.end !== undefined) patch.end = msTime(endAs);
            if (a.where !== undefined) patch.location = { displayName: String(a.where) };
            if (a.notes !== undefined) patch.body = { contentType: 'text', content: String(a.notes) };
            if (a.with !== undefined) patch.attendees = String(a.with).split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((e) => ({ emailAddress: { address: e }, type: 'required' }));
            if (a.categories !== undefined) patch.categories = catsOf(a) ?? []; /* --category none clears them */
            if (a.online !== undefined) {
                const online = String(a.online).toLowerCase();
                if (online === 'teams') { patch.isOnlineMeeting = true; patch.onlineMeetingProvider = 'teamsForBusiness'; }
                else if (online === 'none') patch.isOnlineMeeting = false;
                else no('--online is teams or none');
            }
            if (!Object.keys(patch).length) no('update needs at least one of: title, start, end, where, notes, with, category, online');
            /* Never let a change to the notes erase a Teams meeting (03-11: it did, on an invitation -- Graph drops
               the meeting when the new body loses its join block). If the event is an online meeting and --online
               was not given: keep it on, and write the new notes ABOVE the meeting's own join block, kept as it was. */
            let keepTeams = patch.isOnlineMeeting === true;
            if (patch.body !== undefined && a.online === undefined) {
                const info = await call(target, ctx, 'GET', `${API.microsoft.event(String(a.id))}?$select=isOnlineMeeting,onlineMeetingProvider,onlineMeeting,body`);
                if (info.status === 404) no('no such event');
                if (!info.ok) no(`${target.title}: the event could not be read to keep its Teams meeting (${info.status}) -- nothing was changed`);
                {
                    const j = await info.json().catch(() => ({}));
                    if (j.isOnlineMeeting) {
                        keepTeams = true;
                        patch.isOnlineMeeting = true; patch.onlineMeetingProvider = j.onlineMeetingProvider || 'teamsForBusiness';
                        patch.body = { contentType: 'html', content: `${notesHtml(a.notes)}${teamsBlockOf(j.body?.content ?? '', j.onlineMeeting?.joinUrl ?? '')}` };
                    }
                }
            }
            /* What it now covers, from the event as it will stand (its own start or end where not changed), never from the request alone (loop 15). */
            const newStart = a.start !== undefined ? String(a.start).trim() : (curDay ?? who.start);
            const newEnd = endAs !== undefined ? String(endAs).trim() : (who.isAllDay ? String(who.end).slice(0, 10) : who.end);
            const when = a.start !== undefined || a.end !== undefined ? ` Now ${isDay(newStart) ? daysSaid(newStart, isDay(newEnd) ? newEnd : newStart) : `${shortWhen(String(newStart))} — ${shortWhen(String(newEnd))}`} (${TZ}).` : '';
            const res = await call(target, ctx, 'PATCH', API.microsoft.event(String(a.id)), patch);
            if (res.status === 404) no('no such event');
            if (!res.ok) no(`${target.title}: the event was not changed (${res.status} ${await bodyError(res)})`.trim());
            /* Checked, not trusted: a meeting that should be there and is not is put back (a new link, said so). */
            if (keepTeams) {
                const after = await call(target, ctx, 'GET', `${API.microsoft.event(String(a.id))}?$select=isOnlineMeeting`).catch(() => ({ ok: false, status: 'no answer' }));
                if (!after.ok) return { text: `Updated the event. Whether its Teams meeting is still there could not be checked (${after.status}): read the event.${when}${told(who, patch)}`, size: 0, watch: watchOf(a, who, patch) };
                const still = Boolean((await after.json().catch(() => ({}))).isOnlineMeeting);
                if (!still) {
                    const again = await call(target, ctx, 'PATCH', API.microsoft.event(String(a.id)), { isOnlineMeeting: true, onlineMeetingProvider: patch.onlineMeetingProvider || 'teamsForBusiness' });
                    if (!again.ok) no(`${target.title}: the event was changed, but its Teams meeting was lost and could not be put back (${again.status}); add it again with --online teams`);
                    return { text: `Updated the event. Its Teams meeting had been dropped by Microsoft and was put back: the join link is new.${when}${told(who, patch)}`, size: 0, watch: watchOf(a, who, patch) };
                }
                return { text: `Updated the event; ${a.online !== undefined && String(a.online).toLowerCase() === 'teams' ? 'it has a Teams meeting (read the event for its join link)' : 'its Teams meeting is kept'}.${when}${told(who, patch)}`, size: 0, watch: watchOf(a, who, patch) };
            }
            return { text: `Updated the event.${when}${told(who, patch)}`, size: 0, watch: watchOf(a, who, patch) };
        },
        /* The mailbox's own categories (name and colour), so the agent knows which
           ones exist before it tags an event. A read. Microsoft only; a category is
           a personal label, invisible to the other participants. */
        async 'calendar.categories'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') return davVerbs.categories(target, a, ctx);
            const res = await call(target, ctx, 'GET', 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories');
            if (!res.ok) no(`${target.title}: the categories could not be read (${res.status} ${await bodyError(res)})`.trim());
            const cats = (await res.json()).value ?? [];
            if (!cats.length) return { text: 'No category set in this mailbox yet (add them in Outlook, then tag events with --category).', size: 0 };
            const text = cats.map((c) => `${c.displayName}  (${COLOR_NAME[c.color] ?? c.color ?? 'no colour'})`).join('\n');
            return { text, size: Buffer.byteLength(text) };
        },
        /* Create a category in the mailbox, with a colour (Microsoft). An act: a
           category is a personal label, so it may ask a person. Colours are named
           (red, blue, dark green, ...) or a presetN; the list is in `categories`. */
        async 'calendar.category-add'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') return davVerbs.categoryAdd(target, a, ctx);
            const name = String(a.name ?? '').trim();
            if (!name) no('a category needs a name');
            const color = presetOf(a.color ?? 'none');
            if (color === null) no(`unknown colour "${a.color}" -- use one of: ${Object.values(COLOR_NAME).filter((n) => n !== 'no colour').join(', ')}`);
            const res = await call(target, ctx, 'POST', 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories', { displayName: name, color });
            if (res.status === 409) no(`${target.title}: a category "${name}" already exists`);
            if (!res.ok) no(`${target.title}: the category was not created (${res.status} ${await bodyError(res)})`.trim());
            return { text: `Created the category "${name}" (${COLOR_NAME[color] ?? color}).`, size: 0 };
        },
        /* Rename a mailbox category, or recolour it, by its current name (Microsoft).
           Note: events already tagged keep the old name -- Outlook stores the name on
           each event, so a rename changes the colour registry, not past events. An act. */
        async 'calendar.category-rename'(target, a, ctx) {
            if (providerOf(target) !== 'microsoft') return davVerbs.categoryEdit(target, a, ctx, a.to);
            const id = await categoryId(target, a, ctx, a.name);
            const patch = {};
            if (a.to !== undefined && String(a.to).trim()) patch.displayName = String(a.to).trim();
            if (a.color !== undefined) { const c = presetOf(a.color); if (c === null) no(`unknown colour "${a.color}"`); patch.color = c; }
            if (!Object.keys(patch).length) no('rename needs a new name (--to) or a colour (--color)');
            const res = await call(target, ctx, 'PATCH', `https://graph.microsoft.com/v1.0/me/outlook/masterCategories/${encodeURIComponent(id)}`, patch);
            if (!res.ok) no(`${target.title}: the category was not changed (${res.status} ${await bodyError(res)})`.trim());
            return { text: `Changed the category "${a.name}"${patch.displayName ? ` -> "${patch.displayName}"` : ''}${patch.color ? ` (${COLOR_NAME[patch.color] ?? patch.color})` : ''}.`, size: 0 };
        },
        /* Remove a mailbox category by name (Microsoft). Events keep the name string. An act. */
        async 'calendar.category-delete'(target, a, ctx) {
            if (providerOf(target) !== 'microsoft') return davVerbs.categoryEdit(target, a, ctx, null);
            const id = await categoryId(target, a, ctx, a.name);
            const res = await call(target, ctx, 'DELETE', `https://graph.microsoft.com/v1.0/me/outlook/masterCategories/${encodeURIComponent(id)}`);
            if (!res.ok && res.status !== 204) no(`${target.title}: the category was not removed (${res.status} ${await bodyError(res)})`.trim());
            return { text: `Removed the category "${a.name}".`, size: 0 };
        },
    };
    /* Who an event concerns (Microsoft): its organiser, whether that is this account, its invitees. */
    /* Read before an act that concerns the others: an unread list is never taken as "nobody" (loop 10). */
    async function peopleOf(target, ctx, id) {
        const res = await call(target, ctx, 'GET', `${API.microsoft.event(String(id))}?$select=subject,start,end,isAllDay,isOrganizer,organizer,attendees`);
        if (res.status === 404) no('no such event');
        if (!res.ok) no(`${target.title}: the event could not be read first, to say who it concerns (${res.status}) -- nothing was done`);
        const j = await res.json().catch(() => null);
        if (!j) no(`${target.title}: the event could not be read first -- nothing was done`);
        return { isOrganizer: j.isOrganizer !== false, organizer: j.organizer?.emailAddress?.address ?? '', attendees: (j.attendees ?? []).map((x) => x.emailAddress?.address).filter(Boolean), title: j.subject ?? '', start: j.start?.dateTime ?? '', end: j.end?.dateTime ?? '', isAllDay: j.isAllDay === true };
    }
    /* What a change sends to the others (#12): the organiser's change goes to every invitee; with "with", the
       list is REPLACED -- one left out gets a cancellation. An invitee's change stays on this calendar. */
    function told(who, patch) {
        if (!who) return '';
        /* Categories are personal on Microsoft: a change of them alone goes to nobody (loop 8). */
        if (Object.keys(patch).every((k) => k === 'categories')) return '';
        const now = patch.attendees ? patch.attendees.map((x) => x.emailAddress.address) : who.attendees;
        const gone = patch.attendees ? who.attendees.filter((x) => !now.some((y) => y.toLowerCase() === x.toLowerCase())) : [];
        if (!who.isOrganizer) return now.length ? ' You are not the organiser: the change stays on this calendar, the others do not see it.' : '';
        if (!now.length && !gone.length) return '';
        return ` Microsoft sends the update to ${now.join(', ') || 'nobody left'}${gone.length ? `, and a cancellation to ${gone.join(', ')} (removed)` : ''}.`;
    }
    const watchOf = (a, who, patch) => (patch.attendees?.length && who?.isOrganizer ? { id: String(a.id), title: patch.subject ?? who.title, start: a.start ?? who.start } : null);
    /* A mailbox category's Graph id, by its display name (Microsoft only). */
    async function categoryId(target, a, ctx, name) {
        const provider = providerOf(target);
        if (provider !== 'microsoft') no(`${target.title}: calendar categories are Microsoft-only`);
        const want = String(name ?? '').trim();
        if (!want) no('say which category (its name)');
        const res = await call(target, ctx, 'GET', 'https://graph.microsoft.com/v1.0/me/outlook/masterCategories');
        if (!res.ok) no(`${target.title}: the categories could not be read (${res.status} ${await bodyError(res)})`.trim());
        const found = ((await res.json()).value ?? []).find((c) => String(c.displayName).toLowerCase() === want.toLowerCase());
        if (!found) no(`${target.title}: no category "${want}"`);
        return found.id;
    }

    /* ---------- an invitee who declines (#13) ----------
       An event the agent made, or whose invitees it set, is looked at every 15 minutes until it starts:
       an invitee whose answer becomes "declined" is told to the agent and the person (a notice). On a
       CalDAV server the answers come back only when it schedules. */
    let host = null; let watched = [];
    const watchFile = () => join(host.dir, 'calendar-watch.json');
    const keepWatch = () => { if (!host) return; const f = watchFile(); writeFileSync(`${f}.tmp`, JSON.stringify(watched, null, 1), { mode: 0o600 }); renameSync(`${f}.tmp`, f); };
    const startMs = (s) => { const t = String(s ?? '').trim(); if (isDay(t)) return localToUtc(`${t}T00:00`).getTime(); const d = /Z$|[+-]\d\d:?\d\d$/.test(t) ? new Date(t) : localToUtc(t.replace(' ', 'T').slice(0, 16)); return d.getTime(); };
    function watchEvent(target, agent, { id, title, start }) {
        if (!host || !agent) return '';
        const at = startMs(start);
        if (!(at > host.now())) return '';
        watched = watched.filter((x) => !(x.target === target.id && x.id === id));
        watched.push({ target: target.id, agent, id, title: String(title ?? ''), start: at, next: host.now() + 15 * 60_000, told: [] });
        watched = watched.slice(-300);
        try { keepWatch(); } catch { return ' (Tether watches the answers only while the keeper runs: its watch list could not be saved.)'; }
        return ' Tether watches the answers until it starts: an invitee who declines is told to you.';
    }
    async function answersOf(target, ctx, id) {
        if (providerOf(target) === 'microsoft') {
            const res = await call(target, ctx, 'GET', `${API.microsoft.event(String(id))}?$select=attendees,isCancelled`);
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(String(res.status));
            const j = await res.json();
            return j.isCancelled ? null : (j.attendees ?? []).map((x) => ({ email: x.emailAddress?.address, declined: x.status?.response === 'declined' }));
        }
        let got;
        try { got = await davGet(target, ctx, id); } catch (e) { if (/no such event/.test(e?.message ?? '')) return null; throw e; }
        return eventOf(got.text).attendees.map((x) => ({ email: x.email, declined: /^declined$/i.test(x.status ?? '') }));
    }
    let ticking = false;
    async function tick() {
        if (!host || ticking) return;
        ticking = true;
        try {
            const now = host.now();
            const before = watched.length;
            watched = watched.filter((x) => x.start > now && host.target(x.target));
            let changed = before !== watched.length;
            for (const w of watched.filter((x) => x.next <= now)) {
                const target = host.target(w.target);
                let list;
                try { list = await answersOf(target, host.ctx(target, w.agent), w.id); } catch { w.next = now + 15 * 60_000; changed = true; continue; }
                if (list === null) { watched = watched.filter((x) => x !== w); changed = true; continue; }
                for (const p of list.filter((x) => x.declined && x.email && !w.told.includes(x.email.toLowerCase()))) {
                    w.told.push(p.email.toLowerCase());
                    try { host.notice({ agent: w.agent, target: { id: target.id, title: target.title }, kind: 'calendar.declined', text: `${p.email} declined "${w.title}" (${new Date(w.start).toISOString().slice(0, 16).replace('T', ' ')} UTC).`, ref: String(w.id) }); } catch { /* told next time */ }
                }
                w.next = now + 15 * 60_000; changed = true;
            }
            if (changed) keepWatch();
        } finally { ticking = false; }
    }

    /* What a waiting act is about, for the card a person approves from: the event
       answered, changed or deleted -- its title, when, where, who organises and who
       comes -- and, for an invitation, what else already stands at that time. A read. */
    async function describe(verb, target, a, ctx) {
        if (!a.id || !['calendar.respond', 'calendar.update', 'calendar.delete', 'calendar.attach', 'calendar.detach'].includes(verb)) return null;
        const provider = providerOf(target);
        let ev;
        if (provider === 'microsoft') {
            const res = await call(target, ctx, 'GET', `${API.microsoft.event(String(a.id))}?$select=subject,start,end,location,organizer,attendees,isOnlineMeeting`);
            if (!res.ok) return null;
            const j = await res.json();
            ev = { title: j.subject ?? '', start: shortWhen(j.start?.dateTime), end: shortWhen(j.end?.dateTime), where: j.location?.displayName ?? '', organizer: j.organizer?.emailAddress?.address ?? '',
                attendees: (j.attendees ?? []).map((x) => x.emailAddress?.address).filter(Boolean), online: Boolean(j.isOnlineMeeting), startIso: j.start?.dateTime, endIso: j.end?.dateTime, mine: j.isOrganizer !== false };
        } else {
            const { text, url } = await davGet(target, ctx, a.id);
            const e = eventOf(text);
            const me = String(target.config?.user ?? '').toLowerCase();
            ev = { title: e.summary, start: e.start, end: e.end, where: e.location, organizer: e.organizer, attendees: e.attendees.map((x) => x.email).filter((x) => x.toLowerCase() !== me), url, mine: !e.organizer || e.organizer.toLowerCase() === me, series: seriesOf(text) };
        }
        /* What the act does to the others, for the card (#12): a person approves knowing who gets what. */
        try {
            const sent = provider === 'microsoft' || await schedules(target, ctx);
            const effects = [];
            const now = a.with !== undefined ? String(a.with).split(/[,;]/).map((x) => x.trim()).filter(Boolean) : ev.attendees;
            const gone = a.with !== undefined ? ev.attendees.filter((x) => !now.some((y) => y.toLowerCase() === x.toLowerCase())) : [];
            if (verb === 'calendar.delete' && (ev.attendees.length || !ev.mine)) effects.push(ev.mine ? (sent ? `a cancellation goes to ${ev.attendees.join(', ')}` : `the invitees (${ev.attendees.join(', ')}) are NOT told`) : 'the organiser is not told that you will not come (decline tells them)');
            const seen = ['title', 'start', 'end', 'where', 'notes', 'with', 'online'].some((k) => a[k] !== undefined) || (provider !== 'microsoft' && a.categories !== undefined);
            if (verb === 'calendar.update' && ev.mine && seen && (now.length || gone.length)) {
                effects.push(sent ? `the update goes to ${now.join(', ') || 'nobody'}` : `the invitees (${[...now, ...gone].join(', ')}) are NOT told`);
                if (gone.length && sent) effects.push(`removed: ${gone.join(', ')} (they get a cancellation)`);
            }
            if (verb === 'calendar.respond') effects.push(sent ? `the organiser${ev.organizer ? ` (${ev.organizer})` : ''} is told` : 'the organiser is NOT told (this server does not schedule)');
            if (provider !== 'microsoft' && ev.series?.series && ['calendar.update', 'calendar.delete', 'calendar.respond', 'calendar.attach', 'calendar.detach'].includes(verb)) {
                const own = ev.series.own;
                effects.unshift(verb === 'calendar.delete' || !own.length ? 'the WHOLE repeating series (every occurrence), not one date'
                    : `the repeating series, not one date; ${own.length === 1 ? 'a date' : 'dates'} changed on ${own.length === 1 ? 'its' : 'their'} own (${own.join(', ')}) keep${own.length === 1 ? 's' : ''} ${own.length === 1 ? 'its' : 'their'} own values`);
            }
            if (effects.length) ev.effects = effects;
        } catch { /* the card says less */ }
        delete ev.mine; delete ev.series;
        /* What already stands at that time (an invitation answered): other events overlapping. */
        if (verb === 'calendar.respond') {
            try {
                if (provider === 'microsoft' && ev.startIso && ev.endIso) {
                    const res = await call(target, ctx, 'GET', API.microsoft.list(20, { from: `${ev.startIso.slice(0, 19)}`, to: `${ev.endIso.slice(0, 19)}` }));
                    if (res.ok) ev.clashes = API.microsoft.items(await res.json()).filter((x) => x.id !== a.id && x.subject !== ev.title).map((x) => `${x.subject ?? ''} (${shortWhen(x.start?.dateTime).slice(11)})`).slice(0, 3);
                } else if (provider !== 'microsoft' && ev.start && ev.end && ev.start.includes(' ')) {
                    const from = localToUtc(ev.start.replace(' ', 'T')).toISOString(); const to = localToUtc(ev.end.replace(' ', 'T')).toISOString();
                    ev.clashes = (await davEvents(target, ctx, { from, to })).filter((x) => x.summary !== ev.title).map((x) => `${x.summary} (${x.start.slice(11)})`).slice(0, 3);
                }
            } catch { /* no clash said */ }
        }
        delete ev.startIso; delete ev.endIso; delete ev.url;
        return ev;
    }

    return {
        name: 'calendar',
        verbs: Object.keys(verbs),
        describe,
        async run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            const { watch: w, ...r } = await verbs[verb](target, a, ctx);
            if (w) r.text += watchEvent(target, ctx.agent, w);
            return r;
        },
        wake(h) {
            host = { now: () => Date.now(), notice: () => {}, ...h };
            try { watched = JSON.parse(readFileSync(watchFile(), 'utf8')); if (!Array.isArray(watched)) watched = []; } catch { watched = []; }
        },
        tick,
        watched: () => watched.map((x) => ({ ...x })),
        close() { tokens.clear(); folders.clear(); },
        shutdown() { tokens.clear(); folders.clear(); },
    };
}
