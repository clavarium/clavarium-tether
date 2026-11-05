/* A CLASSIC CALENDAR (OVH, Infomaniak, Nextcloud...) over CalDAV, and Google over
 * the same path: an in-memory CalDAV server stands in -- discovery from the
 * server's address, a folder of .ics files with version tags, a scheduling
 * outbox. Nothing real is reached. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendar } from '../host/connectors/calendar.mjs';
import { setProps, eventOf, localToUtc, readTime, props } from '../host/dav.mjs';

const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const ms = (rows) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${rows.join('')}</d:multistatus>`;
const row = (href, prop) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const ev = (uid, summary, start, extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:${start}\r\nDTEND:${start.replace(/T(\d\d)/, (m, h) => `T${String(+h + 1).padStart(2, '0')}`)}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;

/* The server: /.well-known/caldav -> principal -> home -> two calendars. */
function davServer({ outbox = true, keepsFiles = true } = {}) {
    const files = new Map([
        ['/cal/me/work/a.ics', { text: ev('a', 'Chantier Dupont', '20301104T080000Z', 'CATEGORIES:Client\r\nORGANIZER:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com\r\n'), etag: '"1"' }],
        ['/cal/me/work/b.ics', { text: ev('b', 'Devis', '20301105T090000Z', 'CATEGORIES:Client,Admin\r\n'), etag: '"1"' }],
    ]);
    const calls = [];
    const fetch = async (url, o = {}) => {
        const u = new URL(url); const method = o.method || 'GET'; const path = u.pathname;
        calls.push({ method, path, auth: o.headers?.Authorization, headers: o.headers ?? {}, body: o.body });
        if (o.headers?.Authorization !== `Basic ${Buffer.from('me@example.com:PW').toString('base64')}`) return new Response('no', { status: 401 });
        const say = (text, status = 207) => new Response(text, { status, headers: { 'content-type': 'application/xml' } });
        if (method === 'PROPFIND') {
            if (path === '/') return say(ms([row('/', '<d:resourcetype><d:collection/></d:resourcetype>')]));
            if (path === '/.well-known/caldav') return say(ms([row('/', '<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>')]));
            if (path === '/principals/me/') return say(ms([row('/principals/me/', o.body.includes('schedule-outbox-URL')
                ? (outbox ? '<cal:schedule-outbox-URL><d:href>/cal/me/outbox/</d:href></cal:schedule-outbox-URL>' : '') : '<cal:calendar-home-set><d:href>/cal/me/</d:href></cal:calendar-home-set>')]));
            if (path === '/cal/me/') return say(ms([row('/cal/me/', '<d:resourcetype><d:collection/></d:resourcetype>'),
                row('/cal/me/perso/', '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Perso</d:displayname>'),
                row('/cal/me/work/', '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Travail</d:displayname>')]));
            if (path.startsWith('/cal/me/work/')) return say(ms([row(path, '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>')]));
            return new Response('', { status: 404 });
        }
        if (method === 'REPORT') return say(ms([...files].filter(([p]) => p.startsWith(path)).map(([p, f]) => row(p, `<d:getetag>${f.etag}</d:getetag><cal:calendar-data>${enc(f.text)}</cal:calendar-data>`))));
        if (method === 'GET') { const f = files.get(path); return f ? new Response(f.text, { status: 200, headers: { etag: f.etag } }) : new Response('', { status: 404 }); }
        if (method === 'PUT') {
            const f = files.get(path);
            if (o.headers['If-None-Match'] === '*' && f) return new Response('', { status: 412 });
            if (o.headers['If-Match'] && (!f || f.etag !== o.headers['If-Match'])) return new Response('', { status: 412 });
            const text = keepsFiles ? o.body : setProps(o.body, 'ATTACH', []);
            files.set(path, { text, etag: `"${Number((f?.etag ?? '"0"').replace(/"/g, '')) + 1}"` });
            return new Response(null, { status: f ? 204 : 201 });
        }
        if (method === 'DELETE') return files.delete(path) ? new Response(null, { status: 204 }) : new Response('', { status: 404 });
        if (method === 'POST' && path === '/cal/me/outbox/') {
            return say(`<?xml version="1.0"?><cal:schedule-response xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:response><cal:recipient><d:href>mailto:boss@example.com</d:href></cal:recipient><cal:request-status>2.0;Success</cal:request-status><cal:calendar-data>${enc('BEGIN:VCALENDAR\r\nBEGIN:VFREEBUSY\r\nFREEBUSY;FBTYPE=BUSY:20301104T080000Z/20301104T090000Z\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n')}</cal:calendar-data></cal:response></cal:schedule-response>`, 200);
        }
        return new Response('', { status: 405 });
    };
    return { fetch, calls, files };
}
const T = { id: 'k1', title: 'Agenda OVH', config: { caldav: 'https://dav.example.com', calendar: 'Travail', user: 'me@example.com' }, secrets: { password: 'ovh-pw' } };
const ctx = () => ({ secret: async (k) => (k === 'password' ? 'PW' : undefined) });
const run = (s, verb, a) => calendar({ fetch: s.fetch }).run(verb, T, a, ctx());

test('dav: local Paris times to UTC and back, winter and summer', () => {
    assert.equal(localToUtc('2030-11-04T09:00').toISOString(), '2030-11-04T08:00:00.000Z');
    assert.equal(localToUtc('2030-07-04T09:00').toISOString(), '2030-07-04T07:00:00.000Z');
    assert.equal(readTime({ value: '20301104T080000Z' }), '2030-11-04 09:00');
    assert.equal(readTime({ value: '20301104' }), '2030-11-04');
});

test('dav: changing one property keeps every other line, alarms included', () => {
    const t = ev('x', 'Old', '20301104T080000Z', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:alarm text\r\nEND:VALARM\r\nX-CUSTOM:keep me\r\n');
    const n = setProps(t, 'SUMMARY', ['SUMMARY:New']);
    assert.match(n, /SUMMARY:New/);
    assert.match(n, /SUMMARY:alarm text/, 'the alarm\'s own summary untouched');
    assert.match(n, /X-CUSTOM:keep me/);
    assert.equal(eventOf(n).summary, 'New');
});

test('a classic calendar is found from its server address (well-known, principal, home, the one named), signed in with its password', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.list', { from: '2030-11-01', to: '2030-12-01' });
    assert.match(r.text, /\/cal\/me\/work\/a\.ics\n {2}2030-11-04 09:00 — Chantier Dupont {2}\[Client\]/);
    assert.match(r.text, /Devis {2}\[Client, Admin\]/);
    const rep = s.calls.find((c) => c.method === 'REPORT');
    assert.equal(rep.path, '/cal/me/work/', 'the calendar named "Travail", not the first one');
    assert.ok(s.calls.every((c) => c.auth.startsWith('Basic ')), 'user and password, from the host');
});

test('a wrong password is said plainly', async () => {
    const s = davServer();
    await assert.rejects(calendar({ fetch: s.fetch }).run('calendar.list', T, {}, { secret: async () => 'bad' }), /refused the user or the password/);
});

test('list by category; read in full', async () => {
    const s = davServer();
    const only = await run(s, 'calendar.list', { from: '2030-11-01', to: '2030-12-01', category: 'admin' });
    assert.match(only.text, /Devis/); assert.doesNotMatch(only.text, /Chantier/);
    const r = await run(s, 'calendar.read', { id: '/cal/me/work/a.ics' });
    assert.match(r.text, /Chantier Dupont\n {2}2030-11-04 09:00 — 2030-11-04 10:00/);
    assert.match(r.text, /with: me@example\.com \(needs-action\), boss@example\.com \(accepted\)/);
});

test('create: a new .ics, never over an existing one, invitees with this account as organiser', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.create', { title: 'RDV client', start: '2030-11-06T14:00', end: '2030-11-06T15:00', where: 'Atelier', with: 'client@example.org', categories: ['Client'] });
    const put = s.calls.find((c) => c.method === 'PUT');
    assert.equal(put.headers['If-None-Match'], '*');
    assert.match(put.body, /DTSTART:20301106T130000Z/, '14:00 in Paris');
    assert.match(put.body, /ORGANIZER:mailto:me@example\.com/);
    assert.match(put.body.replace(/\r\n /g, ''), /ATTENDEE;[^\r\n]*mailto:client@example\.org/);
    assert.match(put.body, /CATEGORIES:Client/);
    assert.match(r.text, /Created: RDV client .* invitations to client@example\.org/);
    await assert.rejects(run(s, 'calendar.create', { title: 'x', start: '2030-11-06T14:00', end: '2030-11-06T15:00', online: 'teams' }), /no online meeting/);
});

test('update: only the fields given, on the version read (If-Match), sequence raised', async () => {
    const s = davServer();
    await run(s, 'calendar.update', { id: '/cal/me/work/b.ics', title: 'Devis signé', start: '2030-11-05T11:00' });
    const put = s.calls.find((c) => c.method === 'PUT');
    assert.equal(put.headers['If-Match'], '"1"');
    const now = eventOf(s.files.get('/cal/me/work/b.ics').text);
    assert.equal(now.summary, 'Devis signé');
    assert.equal(now.start, '2030-11-05 11:00');
    assert.deepEqual(now.categories, ['Client', 'Admin'], 'untouched');
    assert.match(s.files.get('/cal/me/work/b.ics').text, /SEQUENCE:1/);
});

test('respond: this account\'s answer on the invitation, the others untouched', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.respond', { id: '/cal/me/work/a.ics', answer: 'accept' });
    assert.match(r.text, /Accepted/);
    const who = eventOf(s.files.get('/cal/me/work/a.ics').text).attendees;
    assert.deepEqual(who, [{ email: 'me@example.com', status: 'accepted' }, { email: 'boss@example.com', status: 'accepted' }]);
    await assert.rejects(run(s, 'calendar.respond', { id: '/cal/me/work/b.ics', answer: 'accept' }), /not invited/);
});

test('attach keeps the file in the event (checked by reading back), detach takes it off; a server that drops it is said', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.attach', { id: '/cal/me/work/b.ics', attach: 'SGVsbG8=', attachName: 'devis.pdf' });
    assert.match(r.text, /Attached devis\.pdf/);
    assert.deepEqual(eventOf(s.files.get('/cal/me/work/b.ics').text).files.map((f) => f.name), ['devis.pdf']);
    await run(s, 'calendar.detach', { id: '/cal/me/work/b.ics', which: 'devis' });
    assert.equal(props(s.files.get('/cal/me/work/b.ics').text, 'ATTACH').length, 0);
    const dropping = davServer({ keepsFiles: false });
    await assert.rejects(run(dropping, 'calendar.attach', { id: '/cal/me/work/b.ics', attach: 'SGVsbG8=', attachName: 'x.pdf' }), /did not keep the file/);
    await run(s, 'calendar.update', { id: '/cal/me/work/b.ics', with: 'client@example.org' });
    await assert.rejects(run(s, 'calendar.attach', { id: '/cal/me/work/b.ics', attach: 'SGVsbG8=' }), /1 external participant\(s\): client@example\.org/);
});

test('categories: those in use; rename and remove rewrite the events that wear them; no colour list to add to', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.categories', {});
    assert.match(r.text, /^Admin\nClient\n/);
    const ren = await run(s, 'calendar.category-rename', { name: 'client', to: 'Clients' });
    assert.match(ren.text, /on 2 events/);
    assert.deepEqual(eventOf(s.files.get('/cal/me/work/b.ics').text).categories, ['Clients', 'Admin']);
    await run(s, 'calendar.category-delete', { name: 'Admin' });
    assert.deepEqual(eventOf(s.files.get('/cal/me/work/b.ics').text).categories, ['Clients']);
    await assert.rejects(run(s, 'calendar.category-add', { name: 'Urgent', color: 'red' }), /keeps no list of categories/);
});

test('delete', async () => {
    const s = davServer();
    await run(s, 'calendar.delete', { id: '/cal/me/work/a.ics' });
    assert.ok(!s.files.has('/cal/me/work/a.ics'));
    await assert.rejects(run(s, 'calendar.delete', { id: '/cal/me/work/a.ics' }), /no such event/);
});

test('freebusy over the scheduling outbox, busy blocks in Paris time; a server without one says so', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.freebusy', { who: 'boss@example.com', from: '2030-11-04', to: '2030-11-05' });
    assert.match(r.text, /boss@example\.com\n {2}busy {2}2030-11-04 09:00 — 2030-11-04 10:00/);
    const post = s.calls.find((c) => c.method === 'POST');
    assert.match(post.body, /BEGIN:VFREEBUSY[\s\S]*ATTENDEE:mailto:boss@example\.com/);
    await assert.rejects(run(davServer({ outbox: false }), 'calendar.freebusy', { who: 'boss@example.com' }), /does not share others' availability/);
});

/* ---------- does the server tell the others? (audit 05-11, #8) ---------- */
const scheduling = (s, yes) => ({ ...s, fetch: async (url, o = {}) => ((o.method || 'GET') === 'OPTIONS' ? new Response(null, { status: 200, headers: { dav: yes ? '1, 2, access-control, calendar-access, calendar-auto-schedule' : '1, 2, calendar-access' } }) : s.fetch(url, o)) });

test('CalDAV: invitations, changes, cancellations and answers are said sent only when the server schedules', async () => {
    const no = scheduling(davServer(), false);
    const made = await run(no, 'calendar.create', { title: 'RDV', start: '2030-11-04T10:00', end: '2030-11-04T11:00', with: 'client@example.org' });
    assert.match(made.text, /invitations to client@example\.org: this calendar server sends no invitations .* NOT told -- tell them yourself/);
    const id = /Its id is (\S+)\./.exec(made.text)[1];
    assert.match((await run(no, 'calendar.update', { id, title: 'RDV 2' })).text, /Invitees \(client@example\.org\): .*NOT told/);
    assert.match((await run(no, 'calendar.respond', { id: '/cal/me/work/a.ics', answer: 'decline' })).text, /organiser \(boss@example\.com\) is NOT told/);
    assert.match((await run(no, 'calendar.delete', { id })).text, /Invitees \(client@example\.org\): .*cancellations.*NOT told/);
    const yes = scheduling(davServer(), true);
    const made2 = await run(yes, 'calendar.create', { title: 'RDV', start: '2030-11-04T10:00', end: '2030-11-04T11:00', with: 'client@example.org' });
    assert.match(made2.text, /invitations to client@example\.org \(sent by the calendar server\)/);
    const id2 = /Its id is (\S+)\./.exec(made2.text)[1];
    assert.match((await run(yes, 'calendar.update', { id: id2, with: 'other@example.org' })).text, /sends the change to other@example\.org, and a cancellation to client@example\.org \(removed\)/);
    assert.match((await run(yes, 'calendar.respond', { id: '/cal/me/work/a.ics', answer: 'accept' })).text, /server tells the organiser \(boss@example\.com\)/);
    assert.match((await run(yes, 'calendar.delete', { id: '/cal/me/work/a.ics' })).text, /You were invited \(organiser boss@example\.com\).*decline is the way/);
    assert.equal(yes.calls.filter((c) => c.method === 'OPTIONS').length, 0, 'the wrapper answered OPTIONS itself');
});

test('CalDAV: an all-day event from the 10th to the 10th is one day (the end is the day after); a date with a time refused', async () => {
    const s = davServer();
    const made = await run(s, 'calendar.create', { title: 'Congés', start: '2030-11-10', end: '2030-11-10' });
    const text = s.files.get(/Its id is (\S+)\./.exec(made.text)[1]).text;
    assert.match(text, /DTSTART;VALUE=DATE:20301110/); assert.match(text, /DTEND;VALUE=DATE:20301111/);
    await assert.rejects(run(s, 'calendar.create', { title: 'x', start: '2030-11-10', end: '2030-11-10T10:00' }), /dates for both start and end/);
});

test('CalDAV: the card says what the act does to the others', async () => {
    const s = scheduling(davServer(), false);
    const about = await calendar({ fetch: s.fetch }).describe('calendar.respond', T, { id: '/cal/me/work/a.ics', answer: 'accept' }, ctx());
    assert.deepEqual(about.effects, ['the organiser is NOT told (this server does not schedule)']);
    const del = await calendar({ fetch: s.fetch }).describe('calendar.delete', T, { id: '/cal/me/work/a.ics' }, ctx());
    assert.deepEqual(del.effects, ['the organiser is not told that you will not come (decline tells them)']);
});

test('CalDAV: a category renamed on several events that fails in the middle says how far it went (#23)', async () => {
    const s = davServer();
    let puts = 0;
    const flaky = { ...s, fetch: async (url, o = {}) => ((o.method === 'PUT' && ++puts === 2) ? new Response('', { status: 500 }) : s.fetch(url, o)) };
    await assert.rejects(run(flaky, 'calendar.category-rename', { name: 'client', to: 'Clients' }), /done on 1 of 2 events; asking again does the rest/);
});

test('CalDAV attach says who receives the file only when the server schedules (loop 2); an invitee\'s file stays on their copy (loop 8)', async () => {
    for (const yes of [false, true]) {
        const srv = scheduling(davServer(), yes);
        const made = await run(srv, 'calendar.create', { title: 'RDV', start: '2030-11-04T10:00', end: '2030-11-04T11:00', with: 'client@example.org' });
        const id = /Its id is (\S+)\./.exec(made.text)[1];
        const r = await run(srv, 'calendar.attach', { id, attach: 'SGVsbG8=', attachName: 'plan.pdf', share: true });
        assert.match(r.text, yes ? /The calendar server sends it with the event to client@example\.org\./ : /Kept in the event on this calendar; client@example\.org do NOT receive it/);
    }
    const r = await run(scheduling(davServer(), true), 'calendar.attach', { id: '/cal/me/work/a.ics', attach: 'SGVsbG8=', attachName: 'plan.pdf' });
    assert.match(r.text, /You are not the organiser \(boss@example\.com\): the file stays on this calendar/);
});

test('CalDAV: the answers of invitees are watched only on a server that schedules (they never come back otherwise) (loop 3)', async () => {
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    for (const yes of [false, true]) {
        const s = scheduling(davServer(), yes);
        const conn = calendar({ fetch: s.fetch });
        conn.wake({ dir: mkdtempSync(join(tmpdir(), 'cw-')), now: () => Date.parse('2030-01-01T00:00:00Z'), target: () => T, ctx: () => ctx(), notice: () => {} });
        const r = await conn.run('calendar.create', T, { title: 'RDV', start: '2030-11-04T10:00', end: '2030-11-04T11:00', with: 'client@example.org' }, { ...ctx(), agent: 'agent:a' });
        assert.equal(conn.watched().length, yes ? 1 : 0);
        assert.equal(/watches the answers/.test(r.text), yes);
    }
});

test('CalDAV: a change of time says the time set, as on Microsoft (loop 4)', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.update', { id: '/cal/me/work/b.ics', start: '2030-11-05T15:00', end: '2030-11-05T16:00' });
    assert.match(r.text, /^Updated the event\. Now 2030-11-05 15:00 — 2030-11-05 16:00 \(Europe\/Paris\)\./);
});

test('loop 5: an invitee changing an event on CalDAV is told the others do not see it', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.update', { id: '/cal/me/work/a.ics', title: 'Chantier (moi)' });
    assert.match(r.text, /You are not the organiser \(boss@example\.com\): the change stays on this calendar, the others do not see it\./);
});

test('loop 10: a second file of the same name that the server drops is said, not "attached"', async () => {
    const s = davServer();
    await run(s, 'calendar.attach', { id: '/cal/me/work/b.ics', attach: 'SGVsbG8=', attachName: 'devis.pdf' });
    const dropNew = { ...s, fetch: async (url, o = {}) => (o.method === 'PUT' ? s.fetch(url, { ...o, body: o.body.replace(/\r\nATTACH[^\r\n]*(\r\n [^\r\n]*)*(?=\r\n(?!ATTACH))(?![\s\S]*\r\nATTACH)/, '') }) : s.fetch(url, o)) };
    await assert.rejects(run(dropNew, 'calendar.attach', { id: '/cal/me/work/b.ics', attach: 'V29ybGQ=', attachName: 'devis.pdf' }), /did not keep the file/);
});

test('loop 13: a one-day all-day change reads as that day, as on Microsoft', async () => {
    const s = davServer();
    const r = await run(s, 'calendar.update', { id: '/cal/me/work/b.ics', start: '2030-11-10', end: '2030-11-10' });
    assert.match(r.text, /Now 2030-11-10, all day \(Europe\/Paris\)\./);
});

test('loop 14: CalDAV says the days covered as Microsoft does', async () => {
    const s = davServer();
    assert.match((await run(s, 'calendar.create', { title: 'Salon', start: '2030-11-10', end: '2030-11-12' })).text, /Created: Salon \(2030-11-10 to 2030-11-11 included, all day\)/);
    assert.match((await run(s, 'calendar.update', { id: '/cal/me/work/b.ics', start: '2030-11-10', end: '2030-11-12' })).text, /Now 2030-11-10 to 2030-11-11 included, all day/);
});

test('loop 15: an end alone on a CalDAV all-day event follows the same rule as create', async () => {
    const s = davServer();
    const made = await run(s, 'calendar.create', { title: 'Congés', start: '2030-11-10', end: '2030-11-13' });
    const id = /Its id is (\S+)\./.exec(made.text)[1];
    const r = await run(s, 'calendar.update', { id, end: '2030-11-10' });
    assert.match(r.text, /Now 2030-11-10, all day/);
    assert.match(s.files.get(id).text, /DTEND;VALUE=DATE:20301111/);
});

test('loop 17: a file put in an event whose read-back fails is "may have been done", never "not done"', async () => {
    const s = davServer(); let puts = 0;
    const flaky = { ...s, fetch: async (url, o = {}) => { if (o.method === 'PUT') puts++; if ((o.method || 'GET') === 'GET' && puts) return new Response('', { status: 503 }); return s.fetch(url, o); } };
    const e = await run(flaky, 'calendar.attach', { id: '/cal/me/work/b.ics', attach: 'SGVsbG8=', attachName: 'devis.pdf' }).catch((x) => x);
    assert.match(e.message, /it may have been done: read the event before asking again/);
    const { failed } = await import('../server/mcp.mjs');
    assert.match(failed(e.message), /^Uncertain/);
    assert.match(failed('Box: that message was marked deleted, but could not be removed now: the next clean-up of Trash by any mail program removes it for good'), /^Done in part/);
});

test('loop 22: a repeating CalDAV event -- listed as the whole series, and a change, delete or answer says it applied to every occurrence', async () => {
    const s = davServer();
    s.files.set('/cal/me/work/r.ics', { text: ev('r', 'Point hebdo', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\nORGANIZER:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\n'), etag: '"1"' });
    const about = await calendar({ fetch: s.fetch }).describe('calendar.delete', T, { id: '/cal/me/work/r.ics' }, ctx());
    assert.equal(about.effects[0], 'the WHOLE repeating series (every occurrence), not one date');
    assert.match((await run(s, 'calendar.respond', { id: '/cal/me/work/r.ics', answer: 'accept' })).text, /repeating event: this applied to the WHOLE series/);
    assert.match((await run(s, 'calendar.update', { id: '/cal/me/work/r.ics', title: 'Point' })).text, /WHOLE series/);
    assert.match((await run(s, 'calendar.delete', { id: '/cal/me/work/r.ics' })).text, /WHOLE series/);
    assert.doesNotMatch((await run(s, 'calendar.delete', { id: '/cal/me/work/b.ics' })).text, /series/);
});

test('loop 22: the list marks a repeating event as the whole series', async () => {
    const s = davServer();
    s.files.set('/cal/me/work/r.ics', { text: ev('r', 'Point hebdo', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\n'), etag: '"1"' });
    const r = await run(s, 'calendar.list', { from: '2030-11-01', to: '2030-12-31' });
    assert.match(r.text, /\/cal\/me\/work\/r\.ics  \(repeats: this id is the WHOLE series\)/);
});

test('loop 23: a series with a date changed on its own says that date keeps its own values', async () => {
    const s = davServer();
    const text = ev('r', 'Point hebdo', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\nORGANIZER:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\n')
        .replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:20301111T080000Z\r\nSUMMARY:Point hebdo (déplacé)\r\nDTSTART:20301112T080000Z\r\nDTEND:20301112T090000Z\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR');
    s.files.set('/cal/me/work/r.ics', { text, etag: '"1"' });
    const r = await run(s, 'calendar.respond', { id: '/cal/me/work/r.ics', answer: 'decline' });
    assert.match(r.text, /repeating event: this applied to the series, not one date\. 1 date changed on its own \(2030-11-11\) keeps its own values\./);
});

test('loop 23: an .ics whose first part is one date of a series is refused, nothing done', async () => {
    const s = davServer();
    const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:20301111T080000Z\r\nSUMMARY:x\r\nDTSTART:20301112T080000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:r\r\nSUMMARY:x\r\nDTSTART:20301104T080000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    s.files.set('/cal/me/work/r.ics', { text, etag: '"1"' });
    await assert.rejects(run(s, 'calendar.update', { id: '/cal/me/work/r.ics', title: 'y' }), /first part is one date of a series.*nothing was done/);
    assert.equal(s.files.get('/cal/me/work/r.ics').text, text);
});

test('loop 24: the approval card names the dates of a series changed on their own', async () => {
    const s = davServer();
    const text = ev('r', 'Point hebdo', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\n')
        .replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:20301111T080000Z\r\nSUMMARY:x\r\nDTSTART:20301112T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
    s.files.set('/cal/me/work/r.ics', { text, etag: '"1"' });
    const c = calendar({ fetch: s.fetch });
    assert.equal((await c.describe('calendar.respond', T, { id: '/cal/me/work/r.ics', answer: 'decline' }, ctx())).effects[0], 'the repeating series, not one date; a date changed on its own (2030-11-11) keeps its own values');
    assert.equal((await c.describe('calendar.delete', T, { id: '/cal/me/work/r.ics' }, ctx())).effects[0], 'the WHOLE repeating series (every occurrence), not one date');
});

test('loop 26: invitees split on ; as on the card; attach on a series says the whole series', async () => {
    const s = davServer();
    const made = await run(s, 'calendar.create', { title: 'RDV', start: '2030-11-04T10:00', end: '2030-11-04T11:00', with: 'a@example.org; b@example.org' });
    const id = /Its id is (\S+)\./.exec(made.text)[1];
    assert.deepEqual(eventOf(s.files.get(id).text).attendees.map((x) => x.email), ['a@example.org', 'b@example.org']);
    s.files.set('/cal/me/work/r.ics', { text: ev('r', 'Point', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\n'), etag: '"1"' });
    assert.match((await run(s, 'calendar.attach', { id: '/cal/me/work/r.ics', attach: 'SGk=', attachName: 'a.pdf' })).text, /WHOLE series/);
});

test('loop 28: deleting an invitation where you are the only attendee says the organiser is not told (result and card)', async () => {
    const s = davServer();
    s.files.set('/cal/me/work/i.ics', { text: ev('i', 'Invit', '20301104T080000Z', 'ORGANIZER:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\n'), etag: '"1"' });
    const about = await calendar({ fetch: s.fetch }).describe('calendar.delete', T, { id: '/cal/me/work/i.ics' }, ctx());
    assert.ok(about.effects.some((x) => /organiser is not told/.test(x)));
    assert.match((await run(s, 'calendar.delete', { id: '/cal/me/work/i.ics' })).text, /You were invited \(organiser boss@example\.com\)/);
});

test('loop 28-29: a category rename reaches every VEVENT, dates changed on their own included', async () => {
    const s = davServer();
    const text = ev('r', 'Point', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\nCATEGORIES:Client\r\n')
        .replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:20301111T080000Z\r\nSUMMARY:x\r\nDTSTART:20301112T080000Z\r\nCATEGORIES:Client\r\nEND:VEVENT\r\nEND:VCALENDAR');
    s.files.set('/cal/me/work/r.ics', { text, etag: '"1"' });
    const r = await run(s, 'calendar.category-rename', { name: 'Client', to: 'Clients' });
    assert.match(r.text, /Renamed "Client" to "Clients" on 3 events/);
    const after = s.files.get('/cal/me/work/r.ics').text;
    assert.equal((after.match(/^CATEGORIES:Clients$/gm) ?? []).length, 2, 'the series and its date changed on its own');
    s.files.set('/cal/me/work/d.ics', { text: ev('d', 'Prix', '20301104T080000Z', 'DESCRIPTION:10$$ et $\' de plus\r\nCATEGORIES:Interne\r\n'), etag: '"1"' });
    await run(s, 'calendar.category-rename', { name: 'Interne', to: 'Interne 2' });
    assert.match(s.files.get('/cal/me/work/d.ics').text, /DESCRIPTION:10\$\$ et \$' de plus/, 'the rest of the event kept as it was');
    /* only a date changed on its own wears it: found and changed too */
    const only = ev('o', 'Point', '20301104T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\n').replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:o\r\nRECURRENCE-ID:20301111T080000Z\r\nSUMMARY:x\r\nDTSTART:20301112T080000Z\r\nCATEGORIES:Congé\r\nEND:VEVENT\r\nEND:VCALENDAR');
    s.files.set('/cal/me/work/o.ics', { text: only, etag: '"1"' });
    assert.match((await run(s, 'calendar.category-delete', { name: 'congé' })).text, /Removed the category "congé" from 1 event/);
    assert.doesNotMatch(s.files.get('/cal/me/work/o.ics').text, /Congé/);
});

test('loop 32: invitees removed on a server that does not schedule are named on the card', async () => {
    const s = scheduling(davServer(), false);
    const made = await run(s, 'calendar.create', { title: 'RDV', start: '2030-11-04T10:00', end: '2030-11-04T11:00', with: 'client@example.org' });
    const id = /Its id is (\S+)\./.exec(made.text)[1];
    const about = await calendar({ fetch: s.fetch }).describe('calendar.update', T, { id, with: '' }, ctx());
    assert.ok(about.effects.includes('removed: client@example.org'));
});
