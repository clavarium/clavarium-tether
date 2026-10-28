/* THE CALENDAR CONNECTOR, with no network: `fetch` is injected and stands in for
 * the token endpoint and the provider's calendar API. No real account; the token is
 * a placeholder. Google reads over CalDAV (the REST API its borrowed client cannot
 * use), Microsoft over Graph. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendar } from '../host/connectors/calendar.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const xml = (text, status = 207) => new Response(text, { status, headers: { 'content-type': 'application/xml' } });
const ICS = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:g1\r\nSUMMARY:Standup\r\nDTSTART:20300102T090000Z\r\nLOCATION:Room 1\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const MULTISTATUS = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/caldav/v2/me%40example.com/events/g1.ics</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag><C:calendar-data>${ICS.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>`;

function server() {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, auth: opts.headers?.Authorization, body: opts.body });
        if (url.includes('oauth2.googleapis.com/token') || url.includes('login.microsoftonline.com')) return json({ access_token: 'CAL-Tok', expires_in: 3600 });
        if (url.includes('apidata.googleusercontent.com/caldav')) {
            if (method === 'REPORT') return xml(MULTISTATUS);
            return new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } }); // GET one event
        }
        if (url.includes('googleapis.com/calendar')) return method === 'POST' ? json({ id: 'g-new' }) : json({ items: [] }); // create only (REST)
        if (url.includes('graph.microsoft.com')) {
            if (method === 'POST') return json({ id: 'm-new' });
            return json({ value: [{ id: 'm1', subject: 'Review', start: { dateTime: '2030-01-02T10:00:00' }, location: { displayName: 'Teams' } }] });
        }
        return json({ error: { message: 'nope' } }, 404);
    };
    return { fetch, calls };
}
test('calendar.list says when it capped (Microsoft nextLink), never silently', async () => {
    const fetch = async (url) => {
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ value: [{ id: 'm1', subject: 'Review', start: { dateTime: '2030-01-02T10:00:00' } }], '@odata.nextLink': 'https://graph.microsoft.com/next' });
    };
    const Mt = { id: 'c2', title: 'Cal', config: { provider: 'microsoft' }, secrets: { refresh: 'r' } };
    const r = await calendar({ fetch }).run('calendar.list', Mt, {}, { secret: async () => 'R' });
    assert.match(r.text, /Showing the first 200/, 'the cap is 200 now (not 25) and it is announced');
    assert.match(r.text, /narrow/i, 'and it says how to see more');
});

const G = { id: 'c1', title: 'Cal', config: { provider: 'google', user: 'me@example.com' }, secrets: { refresh: 'cal-refresh' } };
const M = { id: 'c2', title: 'Cal', config: { provider: 'microsoft' }, secrets: { refresh: 'cal-refresh' } };
const ctx = () => ({ secret: async (k) => (k === 'refresh' ? 'REFRESH' : undefined) });

test('calendar.list (Google) over CalDAV: minted token as Bearer, briefs the events', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.list', G, {}, ctx());
    assert.ok(r.text.includes('Standup'), 'shows the event');
    assert.ok(r.text.includes('2030-01-02 09:00'), 'with its start, readable');
    const rep = s.calls.find((c) => c.method === 'REPORT');
    assert.ok(rep.url.includes('apidata.googleusercontent.com/caldav/v2/me%40example.com/events/'), 'the CalDAV collection for the account');
    assert.equal(rep.auth, 'Bearer CAL-Tok', 'Bearer the minted token, never a password');
    assert.ok(rep.body.includes('calendar-query') && rep.body.includes('time-range'), 'a calendar-query with a window');
});

test('calendar.list (Google) without the account address asks to reconnect', async () => {
    const s = server();
    const noUser = { id: 'c1', title: 'Cal', config: { provider: 'google' }, secrets: { refresh: 'r' } };
    await assert.rejects(calendar({ fetch: s.fetch }).run('calendar.list', noUser, {}, ctx()), /reconnect the account/);
});

test('calendar.read (Google) GETs the event over CalDAV', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.read', G, { id: 'https://apidata.googleusercontent.com/caldav/v2/me%40example.com/events/g1.ics' }, ctx());
    assert.ok(r.text.includes('Standup'));
});

test('calendar.create posts the event body (REST)', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.create', G, { title: 'Lunch', start: '2030-01-02T12:00:00Z', end: '2030-01-02T13:00:00Z' }, ctx());
    assert.ok(r.text.includes('Created: Lunch'), 'confirms creation');
    const post = s.calls.find((c) => c.method === 'POST' && c.url.includes('/events'));
    const body = JSON.parse(post.body);
    assert.equal(body.summary, 'Lunch');
    assert.equal(body.start.dateTime, '2030-01-02T12:00:00Z');
});

test('calendar.list (Microsoft) via Graph briefs events', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.list', M, {}, ctx());
    assert.ok(r.text.includes('Review'), 'shows the event');
    /* calendarView from now on -- the next events, not the oldest of the whole calendar. */
    assert.ok(s.calls.some((c) => c.url.includes('graph.microsoft.com/v1.0/me/calendarView') && c.url.includes('startDateTime=')), 'the upcoming-window Graph endpoint');
});

test('calendar.list takes a date window (from/to), for the past or the future', async () => {
    const g = server();
    await calendar({ fetch: g.fetch }).run('calendar.list', G, { from: '2026-03-01', to: '2026-03-31' }, ctx());
    const rep = g.calls.find((c) => c.method === 'REPORT');
    assert.ok(rep.body.includes('20260301') && rep.body.includes('20260331'), 'Google CalDAV window (iCal UTC)');
    const m = server();
    await calendar({ fetch: m.fetch }).run('calendar.list', M, { from: '2026-03-01', to: '2026-03-31' }, ctx());
    const mc = m.calls.find((c) => c.url.includes('graph.microsoft.com') && c.method === 'GET');
    assert.ok(mc.url.includes('calendarView') && mc.url.includes('startDateTime=') && mc.url.includes('endDateTime='), 'MS calendarView window');
    assert.ok(mc.url.includes('2026-03-01') && mc.url.includes('2026-03-31'), 'MS window dates');
});

test('calendar.attach (Microsoft) posts a fileAttachment to the event', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.attach', M, { id: 'm1', attach: 'SGk=', attachName: 'f.txt' }, ctx());
    assert.ok(r.text.includes('Attached'));
    const post = s.calls.find((c) => c.method === 'POST' && c.url.includes('/me/events/m1/attachments'));
    assert.ok(post, 'POST to the event attachments');
    const body = JSON.parse(post.body);
    assert.equal(body['@odata.type'], '#microsoft.graph.fileAttachment');
    assert.equal(body.contentBytes, 'SGk=');
});

test('calendar.attach is Microsoft-only for now (Google uses Drive links)', async () => {
    const s = server();
    await assert.rejects(calendar({ fetch: s.fetch }).run('calendar.attach', G, { id: 'g1', attach: 'SGk=' }, ctx()), /Microsoft-only/);
});

test('calendar refuses a target with no provider, and create without times', async () => {
    const s = server();
    const c = calendar({ fetch: s.fetch });
    await assert.rejects(c.run('calendar.list', { id: 'x', title: 'X', config: {}, secrets: { refresh: 'r' } }, {}, ctx()), /google or microsoft/);
    await assert.rejects(c.run('calendar.create', G, { title: 'x' }, ctx()), /start and an end/);
});
