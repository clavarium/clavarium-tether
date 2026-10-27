/* THE CALENDAR CONNECTOR, with no network: `fetch` is injected and stands in for
 * the token endpoint and the provider's calendar API. No real account; the token is
 * a placeholder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendar } from '../host/connectors/calendar.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
function server() {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, auth: opts.headers?.Authorization, body: opts.body });
        if (url.includes('oauth2.googleapis.com/token') || url.includes('login.microsoftonline.com')) return json({ access_token: 'CAL-Tok', expires_in: 3600 });
        if (url.includes('googleapis.com/calendar')) {
            if (method === 'POST') return json({ id: 'g-new' });
            if (url.includes('/events/g1')) return json({ id: 'g1', summary: 'Standup', start: { dateTime: '2030-01-02T09:00:00Z' } });
            return json({ items: [{ id: 'g1', summary: 'Standup', start: { dateTime: '2030-01-02T09:00:00Z' }, location: 'Room 1' }] });
        }
        if (url.includes('graph.microsoft.com')) {
            if (method === 'POST') return json({ id: 'm-new' });
            return json({ value: [{ id: 'm1', subject: 'Review', start: { dateTime: '2030-01-02T10:00:00' }, location: { displayName: 'Teams' } }] });
        }
        return json({ error: { message: 'nope' } }, 404);
    };
    return { fetch, calls };
}
const G = { id: 'c1', title: 'Cal', config: { provider: 'google' }, secrets: { refresh: 'cal-refresh' } };
const M = { id: 'c2', title: 'Cal', config: { provider: 'microsoft' }, secrets: { refresh: 'cal-refresh' } };
const ctx = () => ({ secret: async (k) => (k === 'refresh' ? 'REFRESH' : undefined) });

test('calendar.list (Google): minted token as Bearer, briefs the upcoming events', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.list', G, {}, ctx());
    assert.ok(r.text.includes('Standup'), 'shows the event');
    const listCall = s.calls.find((c) => c.url.includes('/events') && c.method === 'GET');
    assert.equal(listCall.auth, 'Bearer CAL-Tok', 'Bearer the minted token, never a password');
    assert.ok(listCall.url.includes('singleEvents=true'), 'upcoming, expanded');
});

test('calendar.read (Google) returns the event', async () => {
    const s = server();
    const r = await calendar({ fetch: s.fetch }).run('calendar.read', G, { id: 'g1' }, ctx());
    assert.ok(r.text.includes('Standup'));
});

test('calendar.create posts the event body', async () => {
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
    const gc = g.calls.find((c) => c.url.includes('googleapis.com/calendar') && c.method === 'GET');
    assert.ok(gc.url.includes('timeMin=') && gc.url.includes('2026-03-01'), 'Google window start');
    assert.ok(gc.url.includes('timeMax=') && gc.url.includes('2026-03-31'), 'Google window end');
    const m = server();
    await calendar({ fetch: m.fetch }).run('calendar.list', M, { from: '2026-03-01', to: '2026-03-31' }, ctx());
    const mc = m.calls.find((c) => c.url.includes('graph.microsoft.com') && c.method === 'GET');
    assert.ok(mc.url.includes('calendarView') && mc.url.includes('startDateTime=') && mc.url.includes('endDateTime='), 'MS calendarView window');
    assert.ok(mc.url.includes('2026-03-01') && mc.url.includes('2026-03-31'), 'MS window dates');
});

test('calendar refuses a target with no provider, and create without times', async () => {
    const s = server();
    const c = calendar({ fetch: s.fetch });
    await assert.rejects(c.run('calendar.list', { id: 'x', title: 'X', config: {}, secrets: { refresh: 'r' } }, {}, ctx()), /google or microsoft/);
    await assert.rejects(c.run('calendar.create', G, { title: 'x' }, ctx()), /start and an end/);
});
