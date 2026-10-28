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

test('contacts.attach (Microsoft) PUTs the photo bytes to the contact', async () => {
    const s = server();
    const r = await contacts({ fetch: s.fetch }).run('contacts.attach', M, { id: 'm1', attach: Buffer.from('img').toString('base64') }, ctx());
    assert.ok(r.text.includes('Set the photo'));
    const put = s.calls.find((c) => c.method === 'PUT' && c.url.includes('/contacts/m1/photo/$value'));
    assert.ok(put, 'PUT to the photo endpoint');
    assert.ok(Buffer.isBuffer(put.body) || put.body, 'sends the decoded bytes');
});

test('contacts.attach is Microsoft-only for now', async () => {
    const s = server();
    await assert.rejects(contacts({ fetch: s.fetch }).run('contacts.attach', G, { id: 'x', attach: 'SGk=' }, ctx()), /Microsoft-only/);
});
