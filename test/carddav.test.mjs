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
    assert.match(p1, /TEL;TYPE=CELL;TYPE=PREF:\+33699999999\r\nTEL;TYPE=CELL:\+33600000000/, 'the new phone first and preferred, the old one kept');
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

test('contacts.update changes one email or phone, never all of them; a type replaces that one; the card is otherwise kept (05-11)', async () => {
    const s = davServer();
    const id = '/dav/books/me/default/p1.vcf';
    const RICH = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:Paul Martin\r\nN:Martin;Paul;;;\r\nEMAIL;TYPE=INTERNET,WORK,PREF:paul.work@example.org\r\nitem1.EMAIL;TYPE=INTERNET,HOME:paul.home@example.org\r\nitem1.X-ABLabel:perso\r\nTEL;TYPE=CELL:+33600000000\r\nTEL;TYPE=WORK:+33100000000\r\nADR;TYPE=HOME:;;1 rue X;Paris;;75001;FR\r\nNOTE:client depuis 2019\r\nEND:VCARD\r\n';
    s.files.set(id, { text: RICH, etag: '"1"' });
    const r1 = await run(s, 'contacts.update', { id, email: 'paul.new@example.org' });
    let t = s.files.get(id).text;
    assert.deepEqual(cardOf(t).emails, ['paul.new@example.org', 'paul.work@example.org'], 'added first; the others kept');
    assert.match(t, /^EMAIL;TYPE=INTERNET;TYPE=PREF:paul\.new@example\.org\r\nEMAIL;TYPE=INTERNET,WORK:paul\.work@example\.org\r\n/m, 'the new one preferred, the old one no longer');
    assert.match(t, /item1\.EMAIL;TYPE=INTERNET,HOME:paul\.home@example\.org\r\nitem1\.X-ABLabel:perso/, 'a grouped (Apple) email kept, with its label');
    assert.match(r1.text, /paul\.new@example\.org is now the first email, the others kept/);
    const r2 = await run(s, 'contacts.update', { id, phone: '+33 1 99 99 99 99', type: 'work' });
    t = s.files.get(id).text;
    assert.match(t, /TEL;TYPE=WORK:\+33 1 99 99 99 99/);
    assert.doesNotMatch(t, /\+33100000000/, 'the work one replaced');
    assert.match(t, /TEL;TYPE=CELL:\+33600000000/, 'the mobile kept');
    assert.match(r2.text, /replaced the work phone \+33100000000 with \+33 1 99 99 99 99/);
    await run(s, 'contacts.update', { id, email: 'paul.home2@example.org', type: 'home' });
    t = s.files.get(id).text;
    assert.match(t, /item1\.EMAIL;TYPE=INTERNET,HOME:paul\.home2@example\.org/, 'replaced in place, its group and parameters kept');
    await run(s, 'contacts.update', { id, phone: '', type: 'mobile' });
    t = s.files.get(id).text;
    assert.doesNotMatch(t, /\+33600000000/, 'an empty value with a type removes that one');
    for (const keep of ['ADR;TYPE=HOME:;;1 rue X;Paris;;75001;FR', 'NOTE:client depuis 2019', 'UID:p1', 'FN:Paul Martin']) assert.ok(t.includes(keep), `kept: ${keep}`);
    await assert.rejects(run(s, 'contacts.update', { id, email: '' }), /give its type/);
    await assert.rejects(run(s, 'contacts.update', { id, phone: '1', type: 'fax' }), /work, home or mobile/);
    const r3 = await run(s, 'contacts.update', { id, email: 'PAUL.work@example.org' });
    assert.deepEqual(cardOf(s.files.get(id).text).emails.slice(0, 2), ['paul.work@example.org', 'paul.new@example.org'], 'one it had already moves up, not doubled');
    assert.match(r3.text, /Updated the contact/);
});

test('describe: a contact to change or delete is shown by its name and email on the card, not an id (CardDAV)', async () => {
    const s = davServer();
    const c = contacts({ fetch: s.fetch });
    assert.deepEqual(await c.describe('contacts.delete', C, { id: '/dav/books/me/default/p1.vcf' }, ctx()), { name: 'Paul Martin', email: 'paul@example.org', emails: ['paul@example.org'], phones: ['+33600000000'] });
    assert.equal(await c.describe('contacts.create', C, { name: 'x' }, ctx()), null, 'nothing to look up for a new one');
});
