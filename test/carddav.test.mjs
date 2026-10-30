/* A CLASSIC ADDRESS BOOK (OVH, Nextcloud...) over CardDAV, and Google over the same
 * path: an in-memory CardDAV server stands in -- found from the server's address,
 * a folder of .vcf files with version tags. Nothing real is reached. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contacts } from '../host/connectors/contacts.mjs';
import { cardOf } from '../host/dav.mjs';

const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const ms = (rows) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${rows.join('')}</d:multistatus>`;
const row = (href, prop) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop></d:propstat></d:response>`;
const VC = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:Paul Martin\r\nN:Martin;Paul;;;\r\nEMAIL;TYPE=INTERNET:paul@example.org\r\nTEL;TYPE=CELL:+33600000000\r\nNOTE:client depuis 2019\r\nEND:VCARD\r\n';

function davServer(root = '/dav/') {
    const book = `${root}books/me/default/`;
    const files = new Map([[`${book}p1.vcf`, { text: VC, etag: '"1"' }]]);
    const calls = [];
    const fetch = async (url, o = {}) => {
        const path = new URL(url).pathname; const method = o.method || 'GET';
        calls.push({ method, path, auth: o.headers?.Authorization, headers: o.headers ?? {}, body: o.body });
        const say = (t, status = 207) => new Response(t, { status, headers: { 'content-type': 'application/xml' } });
        if (method === 'PROPFIND') {
            if (path === '/.well-known/carddav') return say(ms([row('/', '<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>')]));
            if (path === '/principals/me/') return say(ms([row(path, `<card:addressbook-home-set><d:href>${root}books/me/</d:href></card:addressbook-home-set>`)]));
            if (path === `${root}books/me/`) return say(ms([row(path, '<d:resourcetype><d:collection/></d:resourcetype>'), row(book, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname>')]));
            if (path === book) return say(ms([row(book, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'), ...[...files].map(([p, f]) => row(p, `<d:getetag>${f.etag}</d:getetag>`))]));
            if (path === '/') return say(ms([row('/', '<d:resourcetype><d:collection/></d:resourcetype>')]));
            return new Response('', { status: 404 });
        }
        if (method === 'REPORT') return say(ms([...files].map(([p, f]) => row(p, `<d:getetag>${f.etag}</d:getetag><card:address-data>${enc(f.text)}</card:address-data>`))));
        if (method === 'GET') { const f = files.get(path); return f ? new Response(f.text, { status: 200, headers: { etag: f.etag } }) : new Response('', { status: 404 }); }
        if (method === 'PUT') {
            const f = files.get(path);
            if (o.headers['If-None-Match'] === '*' && f) return new Response(null, { status: 412 });
            if (o.headers['If-Match'] && (!f || f.etag !== o.headers['If-Match'])) return new Response(null, { status: 412 });
            files.set(path, { text: o.body, etag: `"${Number((f?.etag ?? '"0"').replace(/"/g, '')) + 1}"` });
            return new Response(null, { status: f ? 204 : 201 });
        }
        if (method === 'DELETE') return files.delete(path) ? new Response(null, { status: 204 }) : new Response('', { status: 404 });
        return new Response('', { status: 405 });
    };
    return { fetch, calls, files, book };
}
const C = { id: 'b1', title: 'Carnet OVH', config: { carddav: 'dav.example.com', user: 'me@example.com' }, secrets: { password: 'pw' } };
const ctx = () => ({ secret: async (k) => (k === 'password' ? 'PW' : undefined) });
const run = (s, verb, a, t = C, c = ctx()) => contacts({ fetch: s.fetch }).run(verb, t, a, c);

test('a classic address book is found from its server (well-known, principal, home), signed in with its password; list and search', async () => {
    const s = davServer();
    const r = await run(s, 'contacts.list', {});
    assert.match(r.text, /\/dav\/books\/me\/default\/p1\.vcf\n {2}Paul Martin {2}<paul@example\.org> {2}tel \+33600000000/);
    assert.ok(s.calls.every((c) => c.auth === `Basic ${Buffer.from('me@example.com:PW').toString('base64')}`));
    assert.match((await run(s, 'contacts.search', { text: 'martin' })).text, /Paul Martin/);
    assert.match((await run(s, 'contacts.search', { text: 'zzz' })).text, /No contact matches/);
});

test('read shows name, emails and phones, then the card', async () => {
    const s = davServer();
    const r = await run(s, 'contacts.read', { id: '/dav/books/me/default/p1.vcf' });
    assert.match(r.text, /^Paul Martin\n {2}email: paul@example\.org\n {2}tel: \+33600000000/);
});

test('create, change only what is given (the rest of the card kept), photo, delete', async () => {
    const s = davServer();
    const made = await run(s, 'contacts.create', { name: 'Julie Petit', email: 'julie@example.org', phone: '0611' });
    const id = /Its id is (\S+)\./.exec(made.text)[1];
    assert.equal(s.calls.find((c) => c.method === 'PUT').headers['If-None-Match'], '*');
    assert.deepEqual(cardOf(s.files.get(id).text), { uid: cardOf(s.files.get(id).text).uid, name: 'Julie Petit', emails: ['julie@example.org'], tels: ['0611'], photo: false });
    await run(s, 'contacts.update', { id: '/dav/books/me/default/p1.vcf', phone: '+33699999999' });
    const p1 = s.files.get('/dav/books/me/default/p1.vcf').text;
    assert.match(p1, /TEL;TYPE=CELL:\+33699999999/);
    assert.match(p1, /EMAIL;TYPE=INTERNET:paul@example\.org/, 'the email untouched');
    assert.match(p1, /NOTE:client depuis 2019/, 'what Tether does not know is kept');
    await run(s, 'contacts.attach', { id: '/dav/books/me/default/p1.vcf', attach: 'SGk=' });
    assert.ok(cardOf(s.files.get('/dav/books/me/default/p1.vcf').text).photo);
    await run(s, 'contacts.delete', { id });
    assert.ok(!s.files.has(id));
    await assert.rejects(run(s, 'contacts.update', { id: '/dav/books/me/default/p1.vcf' }), /at least one of/);
});

test('Google writes over the same CardDAV, with its token', async () => {
    const s = davServer('/carddav/v1/principals/me%40example.com/lists/');
    const fetch = async (url, o = {}) => {
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'G-Tok', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        return s.fetch(url.replace('/lists/default/', '/lists/books/me/default/'), o);
    };
    const G = { id: 'g', title: 'Google', config: { provider: 'google', user: 'me@example.com' }, secrets: { refresh: 'r' } };
    const r = await contacts({ fetch }).run('contacts.create', G, { name: 'Ana' }, { secret: async () => 'R' });
    assert.match(r.text, /Created Ana/);
    const put = s.calls.find((c) => c.method === 'PUT');
    assert.equal(put.auth, 'Bearer G-Tok');
});
