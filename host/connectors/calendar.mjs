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

const LIST_MAX = 25;
const READ_MAX = 256 * 1024;
const dateField = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : { dateTime: s });

const API = {
    google: {
        list: (n) => `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${n}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(new Date().toISOString())}`,
        event: (id) => `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
        create: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        items: (j) => j.items ?? [],
        brief: (e) => `${e.id}\n  ${e.start?.dateTime ?? e.start?.date ?? '?'} — ${e.summary ?? '(no title)'}${e.location ? `  @ ${e.location}` : ''}`,
        body: ({ title, start, end, where }) => ({ summary: title, start: dateField(start), end: dateField(end), ...(where ? { location: where } : {}) }),
    },
    microsoft: {
        list: (n) => `https://graph.microsoft.com/v1.0/me/events?$top=${n}&$orderby=start/dateTime&$select=id,subject,start,end,location`,
        event: (id) => `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`,
        create: 'https://graph.microsoft.com/v1.0/me/events',
        items: (j) => j.value ?? [],
        brief: (e) => `${e.id}\n  ${e.start?.dateTime ?? '?'} — ${e.subject ?? '(no title)'}${e.location?.displayName ? `  @ ${e.location.displayName}` : ''}`,
        body: ({ title, start, end, where }) => ({ subject: title, start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: end, timeZone: 'UTC' }, ...(where ? { location: { displayName: where } } : {}) }),
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
        const headers = { Authorization: `Bearer ${token}` };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        let res;
        try { res = await fetchImpl(url, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: cannot reach the calendar`); }
        if (res.status === 401 || res.status === 403) no(`${target.title}: not authorized -- reconnect the account (the calendar scope may be missing)`);
        return res;
    }
    const bodyError = async (res) => { try { const j = await res.json(); return j?.error?.message || ''; } catch { return ''; } };

    const verbs = {
        /* The next events, soonest first. */
        async 'calendar.list'(target, a, ctx) {
            const api = API[providerOf(target)];
            const res = await call(target, ctx, 'GET', api.list(LIST_MAX));
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            const items = api.items(await res.json());
            const text = items.length ? items.map(api.brief).join('\n') : 'No upcoming event.';
            return { text, size: Buffer.byteLength(text) };
        },
        /* One event in full, by its id. */
        async 'calendar.read'(target, a, ctx) {
            const api = API[providerOf(target)];
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
            if (!a.start || !a.end) no('an event needs a start and an end (ISO times, e.g. 2030-01-02T09:00:00Z)');
            const res = await call(target, ctx, 'POST', api.create, api.body({ title: a.title, start: a.start, end: a.end, where: a.where }));
            if (!res.ok) no(`${target.title}: the event was not created (${res.status} ${await bodyError(res)})`.trim());
            const made = await res.json().catch(() => ({}));
            return { text: `Created: ${a.title} (${a.start}). Its id is ${made.id ?? '(unknown)'}.`, size: 0 };
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
