/* THE CONTACTS CONNECTOR, with no network: `fetch` is injected. Microsoft is Graph
 * JSON; Google is a CardDAV REPORT whose multistatus carries vCards. The token is a
 * placeholder and nothing is a real account. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contacts } from '../host/connectors/contacts.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const xml = (body, status = 207) => new Response(body, { status, headers: { 'content-type': 'application/xml' } });

const MULTISTATUS = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
 <D:response>
  <D:href>/carddav/v1/principals/me/lists/default/alice.vcf</D:href>
  <D:propstat><D:prop><D:getetag>"1"</D:getetag>
   <C:address-data>BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alice Smith\r\nEMAIL:alice@example.com\r\nTEL:+1 555 0001\r\nEND:VCARD\r\n</C:address-data>
  </D:prop></D:propstat>
 </D:response>
 <D:response>
  <D:href>/carddav/v1/principals/me/lists/default/bob.vcf</D:href>
  <D:propstat><D:prop><D:getetag>"2"</D:getetag>
   <C:address-data>BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bob Jones\r\nEMAIL:bob@example.com\r\nEND:VCARD\r\n</C:address-data>
  </D:prop></D:propstat>
 </D:response>
</D:multistatus>`;

/* A PROPFIND lists the collection and its entries (hrefs + etags, no data). */
const LISTING = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
 <D:response><D:href>/carddav/v1/principals/me/lists/default/</D:href><D:propstat><D:prop><D:getetag>"c"</D:getetag></D:prop></D:propstat></D:response>
 <D:response><D:href>/carddav/v1/principals/me/lists/default/alice.vcf</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag></D:prop></D:propstat></D:response>
 <D:response><D:href>/carddav/v1/principals/me/lists/default/bob.vcf</D:href><D:propstat><D:prop><D:getetag>"2"</D:getetag></D:prop></D:propstat></D:response>
</D:multistatus>`;

function server() {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, auth: opts.headers?.Authorization, body: opts.body });
        if (url.includes('oauth2.googleapis.com/token') || url.includes('login.microsoftonline.com')) return json({ access_token: 'CON-Tok', expires_in: 3600 });
        if (url.includes('googleapis.com/carddav')) {
            if (method === 'PROPFIND') return xml(LISTING);
            if (method === 'REPORT') return xml(MULTISTATUS);
            if (url.endsWith('alice.vcf')) return new Response('BEGIN:VCARD\r\nFN:Alice Smith\r\nEMAIL:alice@example.com\r\nEND:VCARD\r\n', { status: 200 });
            return new Response('not found', { status: 404 });
        }
        if (url.includes('graph.microsoft.com')) {
            if (url.includes('/contacts/m1')) return json({ id: 'm1', displayName: 'Carol', emailAddresses: [{ address: 'carol@example.com' }] });
            return json({ value: [{ id: 'm1', displayName: 'Carol', emailAddresses: [{ address: 'carol@example.com' }], mobilePhone: '+1 555 9' }] });
        }
        return json({ error: { message: 'nope' } }, 404);
    };
    return { fetch, calls };
}
const G = { id: 'g', title: 'Book', config: { provider: 'google', user: 'me@example.com' }, secrets: { refresh: 'r' } };
const M = { id: 'm', title: 'Book', config: { provider: 'microsoft', user: 'me@example.com' }, secrets: { refresh: 'r' } };
const ctx = () => ({ secret: async (k) => (k === 'refresh' ? 'REFRESH' : undefined) });

test('contacts.list (Google CardDAV): parses the vCards from the multistatus', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.list', G, {}, ctx());
    assert.ok(r.text.includes('Alice Smith') && r.text.includes('alice@example.com'), 'name and email');
    assert.ok(r.text.includes('Bob Jones'), 'the second contact too');
    assert.ok(r.text.includes('+1 555 0001'), 'and the phone');
    const report = s.calls.find((c) => c.method === 'REPORT');
    assert.equal(report.auth, 'Bearer CON-Tok', 'Bearer the minted token');
    assert.ok(s.calls.some((c) => c.method === 'PROPFIND'), 'enumerated the entries with a PROPFIND first (no filter-less query)');
    assert.ok(report.body.includes('addressbook-multiget') && report.body.includes('alice.vcf') && report.body.includes('bob.vcf'), 'then an addressbook-multiget for the enumerated vCards');
});

test('contacts.read (Google) fetches the vCard by its href', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.read', G, { id: '/carddav/v1/principals/me/lists/default/alice.vcf' }, ctx());
    assert.ok(r.text.includes('Alice Smith'));
});

test('contacts.list (Microsoft) over Graph briefs the contacts', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.list', M, {}, ctx());
    assert.ok(r.text.includes('Carol') && r.text.includes('carol@example.com'));
    assert.ok(s.calls.some((c) => c.url.includes('graph.microsoft.com/v1.0/me/contacts')), 'the Graph endpoint');
});

test('contacts.search (Google) keeps only the contacts whose name/email matches', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.search', G, { text: 'alice' }, ctx());
    assert.ok(r.text.includes('Alice Smith'), 'the match is kept');
    assert.ok(!r.text.includes('Bob Jones'), 'the non-match is dropped');
});

test('contacts.search (Microsoft) filters host-side on a substring; no match says so', async () => {
    const s = server();
    const hit = await contacts({ fetch: s.fetch }).run('contacts.search', M, { text: 'car' }, ctx());
    assert.ok(hit.text.includes('Carol'), 'a substring of the name matches');
    assert.ok(s.calls.some((c) => c.url.includes('graph.microsoft.com/v1.0/me/contacts')), 'listed over Graph');
    const miss = await contacts({ fetch: s.fetch }).run('contacts.search', M, { text: 'zzz' }, ctx());
    assert.match(miss.text, /No contact matches/);
});

test('contacts.read (Microsoft) returns one contact; unknown provider refused', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.read', M, { id: 'm1' }, ctx());
    assert.ok(r.text.includes('Carol'));
    await assert.rejects(contacts({ fetch: s.fetch }).run('contacts.list', { id: 'x', title: 'X', config: { user: 'u' }, secrets: { refresh: 'r' } }, {}, ctx()), /google or microsoft/);
});

test('contacts.create / update / delete (Microsoft) hit the right Graph endpoints', async () => {
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: (() => { try { return opts.body ? JSON.parse(opts.body) : undefined; } catch { return opts.body; } })() });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'CON-Tok', expires_in: 3600 });
        if ((opts.method || 'GET') === 'POST') return json({ id: 'new1' });
        return new Response(null, { status: 204 });
    };
    const c = contacts({ fetch });
    const made = await c.run('contacts.create', M, { name: 'Alice Martin', email: 'alice@example.com', phone: '+33 1' }, ctx());
    assert.match(made.text, /Created Alice Martin/);
    const post = calls.find((x) => x.method === 'POST' && x.url.endsWith('/me/contacts'));
    assert.equal(post.body.displayName, 'Alice Martin');
    assert.equal(post.body.givenName, 'Alice');
    assert.equal(post.body.surname, 'Martin');
    assert.equal(post.body.emailAddresses[0].address, 'alice@example.com');
    await c.run('contacts.update', M, { id: 'm1', phone: '+33 2' }, ctx());
    const patch = calls.find((x) => x.method === 'PATCH' && x.url.includes('/me/contacts/m1'));
    assert.equal(patch.body.mobilePhone, '+33 2');
    assert.equal(patch.body.displayName, undefined, 'only the given field is sent');
    const del = await c.run('contacts.delete', M, { id: 'm1' }, ctx());
    assert.match(del.text, /Deleted the contact/);
    assert.ok(calls.some((x) => x.method === 'DELETE' && x.url.includes('/me/contacts/m1')), 'DELETE to the contact');
});

test('contacts.attach (Microsoft) PUTs the photo bytes to the contact', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.attach', M, { id: 'm1', attach: Buffer.from('img').toString('base64') }, ctx());
    assert.ok(r.text.includes('Set the photo'));
    const put = s.calls.find((c) => c.method === 'PUT' && c.url.includes('/contacts/m1/photo/$value'));
    assert.ok(put, 'PUT to the photo endpoint');
    assert.ok(Buffer.isBuffer(put.body) || put.body, 'sends the decoded bytes');
});


test('contacts.update (Microsoft): an email goes first, the others kept; a phone is the mobile, or the work/home one with a type; the result names what it replaced (05-11)', async () => {
    const calls = [];
    const was = { displayName: 'Carol Diaz', emailAddresses: [{ address: 'carol@example.com', name: 'Carol' }, { address: 'carol.work@example.com', name: 'Carol' }], mobilePhone: '+33 6 1', businessPhones: ['+33 1 1', '+33 1 2'], homePhones: [] };
    const fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: (() => { try { return opts.body ? JSON.parse(opts.body) : undefined; } catch { return opts.body; } })() });
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        if ((opts.method || 'GET') === 'GET') return json(was);
        return new Response(null, { status: 204 });
    };
    const c = contacts({ fetch });
    const r = await c.run('contacts.update', M, { id: 'm1', email: 'carol.new@example.com' }, ctx());
    let patch = calls.filter((x) => x.method === 'PATCH').at(-1).body;
    assert.deepEqual(patch.emailAddresses.map((e) => e.address), ['carol.new@example.com', 'carol@example.com', 'carol.work@example.com']);
    assert.equal(patch.mobilePhone, undefined, 'the phones untouched');
    assert.match(r.text, /carol\.new@example\.com is now the first email, the others kept/);
    const w = await c.run('contacts.update', M, { id: 'm1', phone: '+33 1 9', type: 'work' }, ctx());
    patch = calls.filter((x) => x.method === 'PATCH').at(-1).body;
    assert.deepEqual(patch.businessPhones, ['+33 1 9', '+33 1 2'], 'the first work number replaced, the second kept');
    assert.equal(patch.mobilePhone, undefined);
    assert.match(w.text, /work phone \+33 1 9 \(was \+33 1 1\)/);
    const m = await c.run('contacts.update', M, { id: 'm1', phone: '+33 6 9' }, ctx());
    assert.equal(calls.filter((x) => x.method === 'PATCH').at(-1).body.mobilePhone, '+33 6 9');
    assert.match(m.text, /mobile \+33 6 9 \(was \+33 6 1\)/, 'says the mobile it replaced');
    was.emailAddresses.push({ address: 'carol.third@example.com' });
    const full = await c.run('contacts.update', M, { id: 'm1', email: 'carol.fourth@example.com' }, ctx());
    assert.equal(calls.filter((x) => x.method === 'PATCH').at(-1).body.emailAddresses.length, 3);
    assert.match(full.text, /Microsoft keeps 3: carol\.third@example\.com removed/, 'a dropped address is said, not silent');
});

test('describe (Microsoft): the contact to delete is named on the card', async () => {
    const fetch = async (url) => {
        if (url.includes('login.microsoftonline.com')) return json({ access_token: 'T', expires_in: 3600 });
        return json({ displayName: 'Carol Diaz', emailAddresses: [{ address: 'carol@example.com' }], mobilePhone: '+33 6 1' });
    };
    const about = await contacts({ fetch }).describe('contacts.delete', M, { id: 'm1' }, ctx());
    assert.equal(about.name, 'Carol Diaz');
    assert.equal(about.email, 'carol@example.com');
});

/* ---------- the same promise on every address book (audit 05-11) ---------- */
test('contacts.read (Microsoft) is readable like CardDAV, not a JSON dump', async () => {
    const fetch = async (url) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 })
        : json({ id: 'm1', displayName: 'Carol Martin', emailAddresses: [{ address: 'carol@example.com' }], mobilePhone: '+33 6', businessPhones: ['+33 1'], companyName: 'ACME', businessAddress: { street: '1 rue X', city: 'Paris', postalCode: '75001' } }));
    const r = await contacts({ fetch }).run('contacts.read', M, { id: 'm1' }, ctx());
    assert.match(r.text, /^Carol Martin\n  email: carol@example\.com\n  tel \(mobile\): \+33 6\n  tel \(work\): \+33 1\n  company: ACME\n  address \(work\): 1 rue X, 75001 Paris/);
    assert.match(r.text, /id: m1$/); assert.doesNotMatch(r.text, /"displayName"/);
});

test('a list never caps in silence: CardDAV and Microsoft say how many there are', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `<D:response><D:href>/carddav/v1/principals/me/lists/default/p${i}.vcf</D:href></D:response>`).join('');
    const data = (hrefs) => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${hrefs.map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop><C:address-data>BEGIN:VCARD\r\nFN:${h.slice(-7, -4)}\r\nEND:VCARD\r\n</C:address-data></D:prop></D:propstat></D:response>`).join('')}</D:multistatus>`;
    const fetch = async (url, o = {}) => {
        if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'T', expires_in: 3600 });
        if (o.method === 'PROPFIND') return xml(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${many}</D:multistatus>`);
        if (o.method === 'REPORT') return xml(data([...String(o.body).matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1])));
        return json({}, 404);
    };
    const r = await contacts({ fetch }).run('contacts.list', G, {}, ctx());
    assert.match(r.text, /\(Showing 50 of 60 contacts — use contacts-search to find one\.\)/);
    const found = await contacts({ fetch }).run('contacts.search', G, { text: 'p59' }, ctx());
    assert.match(found.text, /p59/, 'a search looks past the first 50');
    const ms = async (url) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : json({ value: [{ id: 'm1', displayName: 'Carol' }], '@odata.count': 120, '@odata.nextLink': 'https://graph.microsoft.com/next' }));
    assert.match((await contacts({ fetch: ms }).run('contacts.list', M, {}, ctx())).text, /\(Showing the first 1 of 120 contacts/);
});

test('a contact deleted is named in the result; a PNG photo is said PNG (by its bytes) on both providers', async () => {
    const s = server();
    const del = await contacts({ fetch: s.fetch }).run('contacts.delete', G, { id: '/carddav/v1/principals/me/lists/default/alice.vcf' }, ctx());
    assert.equal(del.text, 'Deleted the contact Alice Smith <alice@example.com>.');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]).toString('base64');
    const calls = [];
    const fetch = async (url, o = {}) => { calls.push({ url, o }); return url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : new Response(null, { status: 204 }); };
    await contacts({ fetch }).run('contacts.attach', M, { id: 'm1', attach: png }, ctx());
    assert.equal(calls.find((c) => c.url.includes('/photo/')).o.headers['Content-Type'], 'image/png');
});

test('a search with more matches than shown says so, on both providers (loop 3)', async () => {
    const people = Array.from({ length: 70 }, (_, i) => ({ id: `m${i}`, displayName: `Martin ${i}` }));
    const ms = async (url) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : json({ value: people }));
    const r = await contacts({ fetch: ms }).run('contacts.search', M, { text: 'martin' }, ctx());
    assert.match(r.text, /\(Showing the first 50 matches — give more of the name to narrow it\.\)$/);
    assert.equal(r.text.split('\n').filter((l) => /^m\d+$/.test(l)).length, 50);
    const many = people.map((p) => `<D:response><D:href>/carddav/v1/principals/me/lists/default/${p.id}.vcf</D:href></D:response>`).join('');
    const fetch = async (url, o = {}) => {
        if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'T', expires_in: 3600 });
        if (o.method === 'PROPFIND') return xml(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${many}</D:multistatus>`);
        const hrefs = [...String(o.body).matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]);
        return xml(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${hrefs.map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop><C:address-data>BEGIN:VCARD\r\nFN:Martin ${h}\r\nEND:VCARD\r\n</C:address-data></D:prop></D:propstat></D:response>`).join('')}</D:multistatus>`);
    };
    assert.match((await contacts({ fetch }).run('contacts.search', G, { text: 'martin' }, ctx())).text, /Showing the first 50 matches/);
});

test('loop 10: removing a phone a Microsoft contact does not have is refused, as on CardDAV', async () => {
    const fetch = async (url, o = {}) => (url.includes('login.microsoftonline.com') ? json({ access_token: 'T', expires_in: 3600 }) : (o.method || 'GET') === 'GET' ? json({ displayName: 'C', businessPhones: [] }) : new Response(null, { status: 204 }));
    await assert.rejects(contacts({ fetch }).run('contacts.update', M, { id: 'm1', phone: '', type: 'work' }, ctx()), /no work phone to remove/);
});
