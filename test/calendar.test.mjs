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
    assert.ok(r.text.includes('2030-01-02 10:00'), 'with its start, readable, in the person\'s time (09:00 UTC is 10:00 in Paris)');
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

test('calendar.create (Google) PUTs a new event over CalDAV, never over REST', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.create', G, { title: 'Lunch', start: '2030-01-02T12:00:00Z', end: '2030-01-02T13:00:00Z' }, ctx());
    assert.ok(r.text.includes('Created: Lunch'), 'confirms creation');
    const put = s.calls.find((c) => c.method === 'PUT');
    assert.ok(put.url.startsWith('https://apidata.googleusercontent.com/caldav/v2/me%40example.com/events/') && put.url.endsWith('.ics'));
    assert.match(put.body, /SUMMARY:Lunch/);
    assert.match(put.body, /DTSTART:20300102T120000Z/);
    assert.ok(!s.calls.some((c) => c.url.includes('googleapis.com/calendar')), 'no REST call');
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

test('calendar.create (Microsoft) sends notes, invitees, and the local timezone', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', prefer: opts.headers?.Prefer, body: (() => { try { return opts.body ? JSON.parse(opts.body) : undefined; } catch { return opts.body; } })() });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ id: 'm-new' });
    };
    const r = await calendar({ fetch }).run('calendar.create', M, { title: 'Point', start: '2026-11-10T16:00:00', end: '2026-11-10T17:00:00', notes: 'ordre du jour', with: 'jerome@example.com, sam@example.com' }, ctx());
    assert.match(r.text, /Created/);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/me/events'));
    assert.equal(post.body.body.content, 'ordre du jour', 'notes go in the event body');
    assert.deepEqual(post.body.attendees.map((a) => a.emailAddress.address), ['jerome@example.com', 'sam@example.com'], 'invitees added');
    assert.equal(post.body.start.timeZone, 'Europe/Paris', 'created in local time, not UTC');
    assert.match(post.prefer, /outlook\.timezone="Europe\/Paris"/, 'asks Microsoft to answer in local time');
});

test('calendar.update (Microsoft) patches notes and invitees', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ method: opts.method || 'GET', body: (() => { try { return opts.body ? JSON.parse(opts.body) : undefined; } catch { return opts.body; } })() });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ id: 'm1' });
    };
    await calendar({ fetch }).run('calendar.update', M, { id: 'm1', notes: 'maj', with: 'x@example.com' }, ctx());
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.body.content, 'maj');
    assert.equal(patch.body.attendees[0].emailAddress.address, 'x@example.com');
});

test('calendar.attach names who will see the file and refuses externals without share', async () => {
    const event = { organizer: { emailAddress: { address: 'me@example.com' } }, attendees: [
        { emailAddress: { address: 'colleague@example.com' } },
        { emailAddress: { address: 'client@example.org' } },
    ] };
    const mk = () => async (url, opts = {}) => {
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if ((opts.method || 'GET') === 'GET' && url.includes('/me/events/') && !url.includes('/attachments')) return json(event);
        return json({ id: 'att1' });
    };
    await assert.rejects(calendar({ fetch: mk() }).run('calendar.attach', M, { id: 'm1', attach: 'SGk=', attachName: 'f.pdf' }, ctx()), /external participant/i);
    const r = await calendar({ fetch: mk() }).run('calendar.attach', M, { id: 'm1', attach: 'SGk=', attachName: 'f.pdf', share: true }, ctx());
    assert.match(r.text, /Attached/);
    assert.match(r.text, /colleague@example\.com \(internal\)/);
    assert.match(r.text, /client@example\.org \(external\)/);
});

test('calendar.attach with no participants says visible to you alone', async () => {
    const fetch = async (url, opts = {}) => {
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if ((opts.method || 'GET') === 'GET' && url.includes('/me/events/') && !url.includes('/attachments')) return json({ organizer: { emailAddress: { address: 'me@example.com' } }, attendees: [] });
        return json({ id: 'att1' });
    };
    const r = await calendar({ fetch }).run('calendar.attach', M, { id: 'm1', attach: 'SGk=' }, ctx());
    assert.match(r.text, /Visible to you alone/);
});

test('calendar.detach removes an attachment by name (Microsoft)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET' });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('/attachments') && (opts.method || 'GET') === 'GET') return json({ value: [{ id: 'at1', name: 'rapport.pdf' }] });
        return new Response(null, { status: 204 });
    };
    const r = await calendar({ fetch }).run('calendar.detach', M, { id: 'm1', which: 'rapport' }, ctx());
    assert.match(r.text, /Removed rapport\.pdf/);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/me/events/m1/attachments/at1')), 'DELETEs the right attachment');
});

test('calendar.respond accepts/declines an invitation via the right Graph action (Microsoft)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return new Response(null, { status: 202 });
    };
    const r = await calendar({ fetch }).run('calendar.respond', M, { id: 'm1', answer: 'decline', comment: 'busy' }, ctx());
    assert.match(r.text, /Declined/);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/me/events/m1/decline'));
    assert.ok(post, 'POST to the decline action');
    assert.equal(JSON.parse(post.body).sendResponse, true, 'sends the response to the organiser');
    // "tentative" maps to Graph's tentativelyAccept
    const s2 = [];
    await calendar({ fetch: async (u, o = {}) => { s2.push(u); return u.includes('login') ? json({ access_token: 'T', expires_in: 3600 }) : new Response(null, { status: 202 }); } }).run('calendar.respond', M, { id: 'm1', answer: 'tentative' }, ctx());
    assert.ok(s2.some((u) => u.includes('/tentativelyAccept')), 'tentative -> tentativelyAccept');
});

test('calendar.update PATCHes only the fields given (Microsoft)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ id: 'm1' });
    };
    const r = await calendar({ fetch }).run('calendar.update', M, { id: 'm1', title: 'New title', where: 'Room 9' }, ctx());
    assert.match(r.text, /Updated/);
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/me/events/m1'));
    assert.ok(patch, 'PATCH to the event');
    const body = JSON.parse(patch.body);
    assert.equal(body.subject, 'New title');
    assert.equal(body.location.displayName, 'Room 9');
    assert.equal(body.start, undefined, 'untouched fields are not sent');
    await assert.rejects(calendar({ fetch }).run('calendar.update', M, { id: 'm1' }, ctx()), /at least one of/);
});

test('calendar.respond rejects an unknown answer', async () => {
    const s = server();
    await assert.rejects(calendar({ fetch: s.fetch }).run('calendar.respond', M, { id: 'm1', answer: 'whatever' }, ctx()), /accept, decline or tentative/);
});

test('calendar.delete removes an event (Microsoft)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET' });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('isOrganizer')) return json({ isOrganizer: true, attendees: [] });
        return new Response(null, { status: 204 });
    };
    const r = await calendar({ fetch }).run('calendar.delete', M, { id: 'EVID' }, ctx());
    assert.match(r.text, /Deleted the event/);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/me/events/EVID')), 'DELETEs the event');
});

test('calendar.freebusy (Microsoft) queries getSchedule and briefs each person\'s busy blocks', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ value: [
            { scheduleId: 'a@example.com', scheduleItems: [{ status: 'busy', start: { dateTime: '2030-01-02T09:00:00' }, end: { dateTime: '2030-01-02T10:00:00' }, subject: 'Review' }] },
            { scheduleId: 'b@example.com', scheduleItems: [] },
            { scheduleId: 'c@example.org', error: { message: 'MailboxNotEnabledForRESTAPI' } },
        ] });
    };
    const r = await calendar({ fetch }).run('calendar.freebusy', M, { who: 'a@example.com, b@example.com, c@example.org' }, ctx());
    const q = calls.find((c) => c.url.includes('/me/calendar/getSchedule'));
    assert.ok(q && q.method === 'POST', 'POSTs to getSchedule');
    const sent = JSON.parse(q.body);
    assert.deepEqual(sent.schedules, ['a@example.com', 'b@example.com', 'c@example.org'], 'passes all three addresses, trimmed');
    assert.equal(sent.startTime.timeZone, 'Europe/Paris', 'window is in the person\'s own timezone');
    assert.match(r.text, /a@example\.com[\s\S]*busy  2030-01-02 09:00 — 2030-01-02 10:00  \(Review\)/, 'a busy block, local time');
    assert.match(r.text, /b@example\.com\n  free for the whole window/, 'b is free');
    assert.match(r.text, /c@example\.org\n  could not be read/, 'c could not be read (no access)');
});

test('calendar.freebusy needs at least one address', async () => {
    const s = server();
    await assert.rejects(calendar({ fetch: s.fetch }).run('calendar.freebusy', M, { who: '  ' }, ctx()), /at least one address/);
});

test('calendar refuses a target with no provider, and create without times', async () => {
    const s = server();
    const c = calendar({ fetch: s.fetch });
    await assert.rejects(c.run('calendar.list', { id: 'x', title: 'X', config: {}, secrets: { refresh: 'r' } }, {}, ctx()), /google or microsoft/);
    await assert.rejects(c.run('calendar.create', G, { title: 'x' }, ctx()), /start and an end/);
});

test('calendar.categories lists the mailbox categories by name and colour (Microsoft)', async () => {
    const fetch = async (url) => {
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('/me/outlook/masterCategories')) return json({ value: [{ displayName: 'Internal', color: 'preset7' }, { displayName: 'Travel', color: 'preset4' }] });
        return json({ error: { message: 'no' } }, 404);
    };
    const r = await calendar({ fetch }).run('calendar.categories', M, {}, ctx());
    assert.match(r.text, /Internal {2}\(blue\)/);
    assert.match(r.text, /Travel {2}\(green\)/);
});

test('calendar.create sends categories; calendar.update sets them and clears them with an empty list (Microsoft)', async () => {
    const s = server();
    await calendar({ fetch: s.fetch }).run('calendar.create', M, { title: 'Point', start: '2030-01-02T10:00:00', end: '2030-01-02T11:00:00', categories: ['Internal'] }, ctx());
    const created = JSON.parse(s.calls.find((c) => c.method === 'POST' && c.url.includes('/me/events')).body);
    assert.deepEqual(created.categories, ['Internal'], 'the event carries its category');
    await calendar({ fetch: s.fetch }).run('calendar.update', M, { id: 'm1', categories: ['Travel', 'External'] }, ctx());
    const patched = JSON.parse(s.calls.find((c) => c.method === 'PATCH').body);
    assert.deepEqual(patched.categories, ['Travel', 'External']);
    const s2 = server();
    await calendar({ fetch: s2.fetch }).run('calendar.update', M, { id: 'm1', categories: [] }, ctx());
    assert.deepEqual(JSON.parse(s2.calls.find((c) => c.method === 'PATCH').body).categories, [], 'an empty list clears them');
});

test('calendar.list shows each event categories and can keep only one (Microsoft, case-insensitive)', async () => {
    const fetch = async (url) => {
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ value: [
            { id: 'm1', subject: 'Internal sync', start: { dateTime: '2030-01-02T10:00:00' }, categories: ['Internal'] },
            { id: 'm2', subject: 'Client call', start: { dateTime: '2030-01-03T10:00:00' }, categories: ['External'] },
            { id: 'm3', subject: 'No tag', start: { dateTime: '2030-01-04T10:00:00' } },
        ] });
    };
    const all = await calendar({ fetch }).run('calendar.list', M, {}, ctx());
    assert.match(all.text, /Internal sync {2}\[Internal\]/);
    assert.match(all.text, /\[External\]/);
    const only = await calendar({ fetch }).run('calendar.list', M, { category: 'external' }, ctx());
    assert.match(only.text, /Client call/);
    assert.doesNotMatch(only.text, /Internal sync|No tag/, 'kept only the one category');
});

test('calendar.category-add creates a category with a named colour (Microsoft), refuses an unknown colour', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('/me/outlook/masterCategories') && (opts.method || 'GET') === 'POST') return json({ id: 'c1', displayName: 'Internal', color: 'preset7' }, 201);
        return json({ error: { message: 'no' } }, 404);
    };
    const r = await calendar({ fetch }).run('calendar.category-add', M, { name: 'Internal', color: 'blue' }, ctx());
    assert.match(r.text, /Created the category "Internal" \(blue\)/);
    assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'POST' && c.url.includes('masterCategories')).body), { displayName: 'Internal', color: 'preset7' });
    await assert.rejects(calendar({ fetch }).run('calendar.category-add', M, { name: 'X', color: 'chartreuse' }, ctx()), /unknown colour/);
});

test('calendar.category-rename and -delete resolve the category by name (Microsoft)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('/me/outlook/masterCategories') && (opts.method || 'GET') === 'GET') return json({ value: [{ id: 'c1', displayName: 'Internal', color: 'preset7' }] });
        if (opts.method === 'PATCH') return json({ id: 'c1', displayName: 'Interne', color: 'preset4' });
        if (opts.method === 'DELETE') return new Response(null, { status: 204 });
        return json({ error: { message: 'no' } }, 404);
    };
    const g = calendar({ fetch });
    await g.run('calendar.category-rename', M, { name: 'Internal', to: 'Interne', color: 'green' }, ctx());
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch.url.includes('/masterCategories/c1'));
    assert.deepEqual(JSON.parse(patch.body), { displayName: 'Interne', color: 'preset4' });
    await g.run('calendar.category-delete', M, { name: 'internal' }, ctx()); // case-insensitive
    assert.ok(calls.find((c) => c.method === 'DELETE').url.includes('/masterCategories/c1'));
    await assert.rejects(g.run('calendar.category-delete', M, { name: 'Ghost' }, ctx()), /no category "Ghost"/);
});

test('create makes a Teams meeting by default when there are participants, not without; --online none opts out', async () => {
    const mk = (calls) => async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('/me/events') && opts.method === 'POST') return json({ id: 'm-new' });
        return json({ error: { message: 'no' } }, 404);
    };
    const c1 = []; await calendar({ fetch: mk(c1) }).run('calendar.create', M, { title: 'Sync', start: '2030-01-02T10:00:00', end: '2030-01-02T11:00:00', with: 'a@example.com' }, ctx());
    const b1 = JSON.parse(c1.find((c) => c.method === 'POST' && c.url.includes('/me/events')).body);
    assert.equal(b1.isOnlineMeeting, true); assert.equal(b1.onlineMeetingProvider, 'teamsForBusiness');
    const c2 = []; await calendar({ fetch: mk(c2) }).run('calendar.create', M, { title: 'Solo', start: '2030-01-02T10:00:00', end: '2030-01-02T11:00:00' }, ctx());
    assert.equal(JSON.parse(c2.find((c) => c.method === 'POST' && c.url.includes('/me/events')).body).isOnlineMeeting, undefined, 'no participants -> no Teams');
    const c3 = []; await calendar({ fetch: mk(c3) }).run('calendar.create', M, { title: 'InPerson', start: '2030-01-02T10:00:00', end: '2030-01-02T11:00:00', with: 'a@example.com', online: 'none' }, ctx());
    assert.equal(JSON.parse(c3.find((c) => c.method === 'POST' && c.url.includes('/me/events')).body).isOnlineMeeting, undefined, '--online none opts out');
});

test('update --notes keeps an existing Teams meeting (never erases it); --online teams/none re-adds or removes', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('isOrganizer')) return json({ isOrganizer: true, attendees: [] });
        if (url.includes('$select=isOnlineMeeting')) return json({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }, body: { contentType: 'html', content: '<html><body><div>old notes</div><div>________________<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join</a><br>________________</div></body></html>' } });
        if (opts.method === 'PATCH') return json({ id: 'm1' });
        return json({ error: { message: 'no' } }, 404);
    };
    const r = await calendar({ fetch }).run('calendar.update', M, { id: 'm1', notes: 'maj <1>\nline 2' }, ctx());
    const patch = JSON.parse(calls.find((c) => c.method === 'PATCH').body);
    assert.equal(patch.body.contentType, 'html');
    assert.match(patch.body.content, /^<div>maj &lt;1&gt;<br>line 2<\/div>/, 'the new notes first, escaped, lines kept');
    assert.match(patch.body.content, /meetup-join\/abc">Join<\/a>/, 'the join block kept as it was');
    assert.doesNotMatch(patch.body.content, /old notes/, 'the old notes replaced');
    assert.equal(patch.isOnlineMeeting, true, 'the Teams meeting is preserved when the notes change');
    assert.match(r.text, /Teams meeting is kept/);
    const mk = (calls2) => async (url, opts = {}) => { calls2.push({ url, method: opts.method || 'GET', body: opts.body }); if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 }); if (url.includes('isOrganizer')) return json({ isOrganizer: true, attendees: [] }); if (opts.method === 'PATCH') return json({ id: 'm1' }); return json({ error: { message: 'no' } }, 404); };
    const a = []; await calendar({ fetch: mk(a) }).run('calendar.update', M, { id: 'm1', online: 'teams' }, ctx());
    assert.equal(JSON.parse(a.find((c) => c.method === 'PATCH').body).isOnlineMeeting, true);
    assert.equal(a.findIndex((c) => c.url.includes('$select=isOnlineMeeting')) > a.findIndex((c) => c.method === 'PATCH'), true, 'no needless fetch before the change when --online is explicit (only the check after)');
    const b = []; await calendar({ fetch: mk(b) }).run('calendar.update', M, { id: 'm1', online: 'none' }, ctx());
    assert.equal(JSON.parse(b.find((c) => c.method === 'PATCH').body).isOnlineMeeting, false);
});

test('update --notes: a Teams meeting Microsoft dropped anyway is checked and put back (03-11)', async () => {
    const calls = []; let gets = 0;
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if (url.includes('isOrganizer')) return json({ isOrganizer: true, attendees: [] });
        if (url.includes('$select=isOnlineMeeting,onlineMeetingProvider')) return json({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' }, body: { content: '<p>no block here</p>' } });
        if (url.endsWith('$select=isOnlineMeeting')) { gets++; return json({ isOnlineMeeting: false }); }
        if (opts.method === 'PATCH') return json({ id: 'm1' });
        return json({ error: { message: 'no' } }, 404);
    };
    const r = await calendar({ fetch }).run('calendar.update', M, { id: 'm1', notes: 'ordre du jour' }, ctx());
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body));
    assert.match(patches[0].body.content, /meetup-join\/x/, 'no block found: a plain join link is written');
    assert.equal(gets, 1, 'checked after the change');
    assert.deepEqual(patches[1], { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }, 'put back');
    assert.match(r.text, /put back: the join link is new/);
});

test('calendar.update (Microsoft) reads start/end as local time, like create (not UTC)', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ id: 'm1' });
    };
    const r = await calendar({ fetch }).run('calendar.update', M, { id: 'm1', start: '2026-11-10T16:00:00', end: '2026-11-10T17:00:00' }, ctx());
    const body = JSON.parse(calls.find((c) => c.method === 'PATCH').body);
    assert.deepEqual(body.start, { dateTime: '2026-11-10T16:00:00', timeZone: 'Europe/Paris' });
    assert.deepEqual(body.end, { dateTime: '2026-11-10T17:00:00', timeZone: 'Europe/Paris' });
    assert.match(r.text, /2026-11-10 16:00 — 2026-11-10 17:00 \(Europe\/Paris\)/, 'the result says the time it set, and in which zone');
});

/* ---------- Microsoft: what an act does to the others, all-day, a readable read, declines (audit 05-11) ---------- */
function graphCal(event) {
    const calls = [];
    const fetch = async (url, o = {}) => {
        const method = o.method || 'GET';
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        calls.push({ url, method, body: o.body ? JSON.parse(o.body) : undefined });
        if (method === 'GET' && url.includes('/me/events/E1')) return event ? json(event()) : json({ error: { message: 'gone' } }, 404);
        if (method === 'POST' && url.endsWith('/me/events')) return json({ id: 'E1' });
        if (method === 'POST') return new Response(null, { status: 202 });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        if (method === 'PATCH') return json({});
        return json({ error: { message: 'nope' } }, 404);
    };
    return { fetch, calls };
}
const ORG = (extra = {}) => ({ id: 'E1', subject: 'Comité', isOrganizer: true, organizer: { emailAddress: { address: 'me@example.com' } }, start: { dateTime: '2030-11-05T14:00:00' }, end: { dateTime: '2030-11-05T15:00:00' },
    attendees: [{ emailAddress: { address: 'a@example.com' }, status: { response: 'accepted' } }, { emailAddress: { address: 'b@example.com' }, status: { response: 'none' } }], ...extra });

test('Microsoft: a bare date is an all-day event (isAllDay, midnight, the day after as end)', async () => {
    const s = graphCal();
    await calendar({ fetch: s.fetch }).run('calendar.create', M, { title: 'Congés', start: '2030-11-10', end: '2030-11-10' }, ctx());
    const body = s.calls.find((c) => c.method === 'POST' && c.url.endsWith('/me/events')).body;
    assert.equal(body.isAllDay, true);
    assert.deepEqual([body.start.dateTime, body.end.dateTime], ['2030-11-10T00:00:00', '2030-11-11T00:00:00']);
});

test('Microsoft: delete and update say what goes to the others; an invitee\'s delete says the organiser is not told', async () => {
    let s = graphCal(() => ORG());
    assert.match((await calendar({ fetch: s.fetch }).run('calendar.delete', M, { id: 'E1' }, ctx())).text, /Microsoft sends a cancellation to a@example\.com, b@example\.com/);
    s = graphCal(() => ORG({ isOrganizer: false, organizer: { emailAddress: { address: 'boss@example.com' } } }));
    assert.match((await calendar({ fetch: s.fetch }).run('calendar.delete', M, { id: 'E1' }, ctx())).text, /You were invited \(organiser boss@example\.com\): the organiser is NOT told/);
    s = graphCal(() => ORG());
    const r = await calendar({ fetch: s.fetch }).run('calendar.update', M, { id: 'E1', with: 'a@example.com, c@example.com' }, ctx());
    assert.match(r.text, /Microsoft sends the update to a@example\.com, c@example\.com, and a cancellation to b@example\.com \(removed\)/);
    const about = await calendar({ fetch: s.fetch }).describe('calendar.update', M, { id: 'E1', with: 'a@example.com' }, ctx());
    assert.deepEqual(about.effects, ['the update goes to a@example.com', 'removed: b@example.com (they get a cancellation)']);
});

test('Microsoft: read is readable like CalDAV (who answered what), not a JSON dump', async () => {
    const s = graphCal(() => ORG({ location: { displayName: 'Salle 2' }, body: { contentType: 'html', content: '<html><body><p>Ordre du jour</p></body></html>' } }));
    const r = await calendar({ fetch: s.fetch }).run('calendar.read', M, { id: 'E1' }, ctx());
    assert.match(r.text, /^Comité\n  2030-11-05 14:00 — 2030-11-05 15:00/);
    assert.match(r.text, /with: a@example\.com \(accepted\), b@example\.com \(no answer\)/);
    assert.match(r.text, /Ordre du jour/); assert.match(r.text, /id: E1/);
    assert.doesNotMatch(r.text, /"subject"/);
});

test('an invitee who declines an event the agent made is told once (notice calendar.declined); the watch ends when it starts', async () => {
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    let answer = 'none';
    const s = graphCal(() => ORG({ attendees: [{ emailAddress: { address: 'a@example.com' }, status: { response: answer } }] }));
    const clock = { t: Date.parse('2030-11-01T09:00:00Z') };
    const notices = [];
    const conn = calendar({ fetch: s.fetch });
    conn.wake({ dir: mkdtempSync(join(tmpdir(), 'calw-')), now: () => clock.t, target: (id) => (id === M.id ? M : null), ctx: () => ctx(), notice: (n) => notices.push(n) });
    const r = await conn.run('calendar.create', M, { title: 'Comité', start: '2030-11-05T14:00', end: '2030-11-05T15:00', with: 'a@example.com' }, { ...ctx(), agent: 'agent:a' });
    assert.match(r.text, /invitations to a@example\.com \(sent by Microsoft\).*an invitee who declines is told to you/);
    clock.t += 16 * 60_000; await conn.tick();
    assert.equal(notices.length, 0);
    answer = 'declined';
    clock.t += 16 * 60_000; await conn.tick();
    clock.t += 16 * 60_000; await conn.tick();
    assert.equal(notices.length, 1, 'once');
    assert.equal(notices[0].kind, 'calendar.declined'); assert.equal(notices[0].agent, 'agent:a');
    assert.match(notices[0].text, /a@example\.com declined "Comité"/);
    clock.t = Date.parse('2030-11-06T00:00:00Z'); await conn.tick();
    assert.equal(conn.watched().length, 0);
});

test('Microsoft: an answer to an invitation says the organiser is told, as on CalDAV (loop 4)', async () => {
    const s = graphCal(() => ORG({ isOrganizer: false, organizer: { emailAddress: { address: 'boss@example.com' } } }));
    const r = await calendar({ fetch: s.fetch }).run('calendar.respond', M, { id: 'E1', answer: 'accept' }, ctx());
    assert.equal(r.text, 'Accepted the invitation. Microsoft tells the organiser (boss@example.com).');
});

test('loop 5: Microsoft attach refuses when the participants cannot be read (never "visible to you alone" by default)', async () => {
    const fetch = async (url) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : json({ error: { message: 'busy' } }, 503));
    await assert.rejects(calendar({ fetch }).run('calendar.attach', M, { id: 'E1', attach: 'SGk=', attachName: 'a.pdf' }, ctx()), /participants could not be read \(503\) -- nothing was attached/);
    await assert.rejects(calendar({ fetch }).run('calendar.update', M, { id: 'E1', notes: 'new' }, ctx()), /could not be read to keep its Teams meeting/);
});

test('loop 7: on a public mailbox domain, a namesake address is outside -- a file to it needs share', async () => {
    const { insideOf } = await import('../host/connectors/calendar.mjs');
    const at = (user, domain) => [user, domain].join('@');   /* a public provider's domain, no real mailbox */
    assert.equal(insideOf(at('me', 'gmail.com'))(at('stranger', 'gmail.com')), false);
    assert.equal(insideOf('me@example.com')('colleague@example.com'), true);
    assert.equal(insideOf(at('me', 'gmail.com'))(at('me', 'gmail.com')), true);
    const s = graphCal(() => ORG({ organizer: { emailAddress: { address: at('me', 'outlook.com') } }, attendees: [{ emailAddress: { address: at('someone', 'outlook.com') } }] }));
    await assert.rejects(calendar({ fetch: s.fetch }).run('calendar.attach', M, { id: 'E1', attach: 'SGk=', attachName: 'a.pdf' }, ctx()), /1 external participant\(s\): someone@outlook\.com/);
});

test('loop 8: Microsoft -- categories alone go to nobody; an invitee\'s file stays on their copy; an unchecked Teams meeting is said', async () => {
    let s = graphCal(() => ORG());
    const r = await calendar({ fetch: s.fetch }).run('calendar.update', M, { id: 'E1', categories: ['Interne'] }, ctx());
    assert.doesNotMatch(r.text, /sends the update/);
    s = graphCal(() => ORG({ isOrganizer: false, organizer: { emailAddress: { address: 'boss@example.org' } } }));
    const at = await calendar({ fetch: s.fetch }).run('calendar.attach', M, { id: 'E1', attach: 'SGk=', attachName: 'a.pdf' }, ctx());
    assert.match(at.text, /You are not the organiser: the file stays on your copy/);
});

test('loop 10: Microsoft delete/update refuse when who it concerns cannot be read; a Teams meeting not made is said', async () => {
    const fail = async (url, o = {}) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : (o.method || 'GET') === 'GET' ? json({ error: { message: 'busy' } }, 503) : new Response(null, { status: 204 }));
    await assert.rejects(calendar({ fetch: fail }).run('calendar.delete', M, { id: 'E1' }, ctx()), /could not be read first.*nothing was done/);
    await assert.rejects(calendar({ fetch: fail }).run('calendar.update', M, { id: 'E1', title: 'x' }, ctx()), /could not be read first.*nothing was done/);
    const made = async (url, o = {}) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : json({ id: 'E9', isOnlineMeeting: false }));
    const r = await calendar({ fetch: made }).run('calendar.create', M, { title: 'T', start: '2030-11-05T14:00', end: '2030-11-05T15:00', with: 'a@example.com' }, ctx());
    assert.match(r.text, /Microsoft did NOT make its Teams meeting/);
});

test('loop 13: Microsoft says a one-day all-day change as that day, as CalDAV does', async () => {
    const s = graphCal(() => ORG());
    const r = await calendar({ fetch: s.fetch }).run('calendar.update', M, { id: 'E1', start: '2030-11-10', end: '2030-11-10' }, ctx());
    assert.match(r.text, /Now 2030-11-10, all day \(Europe\/Paris\)\./);
});
