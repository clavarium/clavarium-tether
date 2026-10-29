import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphMail } from '../host/connectors/graphmail.mjs';

const target = { title: 'Mail — a@example.com (Microsoft)', config: { provider: 'microsoft', user: 'a@example.com' } };
const ctx = { secret: async () => 'refresh-token' };

/* A fake Graph: records requests, answers from a script keyed by "METHOD path"
   (query string dropped). A route value is the JSON the call returns; `_status`
   overrides the status for acts that return no content. */
function fakeGraph(routes) {
    const calls = [];
    const fetch = async (url, opts) => {
        const path = url.replace('https://graph.microsoft.com/v1.0', '');
        calls.push({ method: opts.method, path, auth: opts.headers.authorization, body: opts.body ? JSON.parse(opts.body) : undefined });
        const hit = routes[`${opts.method} ${path.split('?')[0]}`];
        if (hit === undefined) return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
        const status = hit._status ?? 200;
        const empty = hit._status === 202 || hit._status === 204;  /* these answer with no body */
        return { ok: status < 400, status, json: async () => hit, text: async () => (empty ? '' : JSON.stringify(hit)) };
    };
    return { fetch, calls };
}
const mint = async () => 'ACCESS';

test('list reads the inbox, newest first, with a Bearer token (never a password)', async () => {
    const { fetch, calls } = fakeGraph({ 'GET /me/mailFolders/inbox/messages': { value: [
        { id: 'AAA', receivedDateTime: '2026-10-27T10:00:00Z', from: { emailAddress: { address: 'x@example.com' } }, subject: 'Hi' },
    ] } });
    const g = graphMail({ fetch, token: mint });
    const r = await g.list(target, {}, ctx);
    assert.match(r.text, /#AAA/); assert.match(r.text, /From: x@example\.com/); assert.match(r.text, /Subject: Hi/);
    assert.equal(calls[0].auth, 'Bearer ACCESS');
    assert.match(calls[0].path, /\$orderby=receivedDateTime/);
});

test('list filters by a since/before window on the property it orders by', async () => {
    const { fetch, calls } = fakeGraph({ 'GET /me/mailFolders/inbox/messages': { value: [] } });
    const g = graphMail({ fetch, token: mint });
    const r = await g.list(target, { since: '2026-01-01', before: '2026-02-01' }, ctx);
    const path = decodeURIComponent(calls[0].path);
    assert.match(path, /\$filter=receivedDateTime ge 2026-01-01T00:00:00\.000Z and receivedDateTime lt 2026-02-01T00:00:00\.000Z/);
    assert.match(path, /\$orderby=receivedDateTime/);
    assert.match(r.text, /in that range/);
});

test('read returns decoded body (html stripped) and lists attachments by name, never bytes', async () => {
    const { fetch } = fakeGraph({
        'GET /me/messages/AAA': { id: 'AAA', receivedDateTime: '2026-10-27T10:00:00Z', from: { emailAddress: { address: 'x@example.com' } }, toRecipients: [{ emailAddress: { address: 'me@example.com' } }], subject: 'Hi', hasAttachments: true, body: { contentType: 'html', content: '<p>Bonjour<br>monde</p><script>bad()</script>' } },
        'GET /me/messages/AAA/attachments': { value: [{ name: 'photo.png', contentType: 'image/png', size: 2048 }] },
    });
    const g = graphMail({ fetch, token: mint });
    const r = await g.read(target, { uid: 'AAA' }, ctx);
    assert.match(r.text, /From: x@example\.com/); assert.match(r.text, /Bonjour\nmonde/); assert.doesNotMatch(r.text, /<p>|script|bad\(\)/);
    assert.match(r.text, /photo\.png \(image\/png, 2 KB\)/);
});

test('read surfaces a meeting invitation date for an event message', async () => {
    const { fetch } = fakeGraph({
        'GET /me/messages/INV': { id: 'INV', from: { emailAddress: { address: 'org@example.com' } }, subject: 'PG X Emilie', body: { contentType: 'text', content: 'Join on Teams' }, hasAttachments: false },
        'GET /me/messages/INV/microsoft.graph.eventMessage/event': { subject: 'PG X Emilie', start: { dateTime: '2026-11-10T16:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-10T17:00:00', timeZone: 'UTC' }, location: { displayName: 'Microsoft Teams' } },
    });
    const g = graphMail({ fetch, token: mint });
    const r = await g.read(target, { uid: 'INV' }, ctx);
    assert.match(r.text, /--- Invitation ---/);
    assert.match(r.text, /2026-11-10 16:00/, 'the event date, not just the body');
    assert.match(r.text, /Microsoft Teams/);
});

test('a plain message has no invitation section (the event cast fails and is ignored)', async () => {
    const { fetch } = fakeGraph({ 'GET /me/messages/N': { id: 'N', from: { emailAddress: { address: 'a@example.com' } }, subject: 'Hi', body: { contentType: 'text', content: 'hello there' }, hasAttachments: false } });
    const g = graphMail({ fetch, token: mint });
    const r = await g.read(target, { uid: 'N' }, ctx);
    assert.doesNotMatch(r.text, /Invitation/);
    assert.match(r.text, /hello there/);
});

test('send posts a well-formed Graph message from the fields', async () => {
    const { fetch, calls } = fakeGraph({ 'POST /me/sendMail': { _status: 202 } });
    const g = graphMail({ fetch, token: mint });
    await g.send(target, { to: 'c@example.com, e@example.org', subject: 'Yo', body: 'text' }, ctx);
    const sent = calls[0];
    assert.equal(sent.method, 'POST');
    assert.deepEqual(sent.body.message.toRecipients.map((r) => r.emailAddress.address), ['c@example.com', 'e@example.org']);
    assert.equal(sent.body.message.body.content, 'text');
    assert.equal(sent.body.message.attachments, undefined, 'no attachments key without a file');
});

test('a 202 with an empty body (sendMail) is a success, not a JSON-parse crash', async () => {
    // Real fetch throws "Unexpected end of JSON input" on .json() of an empty 202.
    const fetch = async () => ({ ok: true, status: 202, text: async () => '', json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
    const g = graphMail({ fetch, token: mint });
    const r = await g.send(target, { to: 'x@example.com', subject: 'S', body: 'b' }, ctx);
    assert.match(r.text, /[Ss]ent/, 'the send reports success, the empty body does not crash it');
});

test('send joins a file as a Graph fileAttachment when given one', async () => {
    const { fetch, calls } = fakeGraph({ 'POST /me/sendMail': { _status: 202 } });
    const g = graphMail({ fetch, token: mint });
    await g.send(target, { to: 'c@example.com', subject: 'Yo', body: 'text', attach: 'SGVsbG8=', attachName: 'note.txt' }, ctx);
    const att = calls[0].body.message.attachments;
    assert.equal(att.length, 1);
    assert.equal(att[0]['@odata.type'], '#microsoft.graph.fileAttachment');
    assert.equal(att[0].name, 'note.txt');
    assert.equal(att[0].contentBytes, 'SGVsbG8=', 'the base64 is passed straight through (what Graph wants)');
});

test('send joins SEVERAL files (attachments array), none dropped', async () => {
    const { fetch, calls } = fakeGraph({ 'POST /me/sendMail': { _status: 202 } });
    const g = graphMail({ fetch, token: mint });
    const r = await g.send(target, { to: 'c@example.com', subject: 'Yo', body: 't', attachments: [{ name: 'a.html', bytes: 'QUJD' }, { name: 'b.html', bytes: 'REVG' }] }, ctx);
    const att = calls[0].body.message.attachments;
    assert.equal(att.length, 2, 'both files are attached, not just the last');
    assert.deepEqual(att.map((x) => x.name), ['a.html', 'b.html']);
    assert.match(r.text, /a\.html.*b\.html/, 'the result lists both');
});

test('source fetches the raw MIME via $value (not JSON)', async () => {
    const fetch = async (url) => (url.endsWith('/$value')
        ? { ok: true, status: 200, text: async () => 'From: a@example.com\r\nSubject: S\r\n\r\nraw body here' }
        : { ok: false, status: 404, json: async () => ({}) });
    const g = graphMail({ fetch, token: mint });
    const r = await g.source(target, { uid: 'X' }, ctx);
    assert.match(r.text, /Subject: S/);
    assert.match(r.text, /raw body here/);
});

test('attachment lists without contentBytes (the bug), then fetches the chosen file in full for its bytes', async () => {
    const { fetch, calls } = fakeGraph({
        'GET /me/messages/X/attachments': { value: [{ id: 'a1', name: 'r.pdf', contentType: 'application/pdf', size: 9 }] },
        'GET /me/messages/X/attachments/a1': { id: 'a1', name: 'r.pdf', contentType: 'application/pdf', size: 9, contentBytes: Buffer.from('PDF-BYTES').toString('base64') },
    });
    const g = graphMail({ fetch, token: mint });
    const r = await g.attachment(target, { uid: 'X', which: 'r.pdf' }, ctx);
    assert.match(r.text, /r\.pdf \(application\/pdf/);
    assert.equal(Buffer.from(r.text.split('\n\n').pop().trim(), 'base64').toString(), 'PDF-BYTES');
    assert.doesNotMatch(decodeURIComponent(calls[0].path), /contentBytes/, 'the list query no longer asks for contentBytes on the mixed collection');
    assert.ok(calls.some((c) => c.path.includes('/attachments/a1')), 'it fetches the chosen attachment in full');
});

test('attachment refuses a non-file attachment (no contentBytes) with a clear message', async () => {
    const { fetch } = fakeGraph({
        'GET /me/messages/X/attachments': { value: [{ id: 'ref1', name: 'shared.docx', contentType: 'application/vnd...', size: 0 }] },
        'GET /me/messages/X/attachments/ref1': { id: 'ref1', name: 'shared.docx', '@odata.type': '#microsoft.graph.referenceAttachment' },
    });
    const g = graphMail({ fetch, token: mint });
    await assert.rejects(g.attachment(target, { uid: 'X', which: 'shared.docx' }, ctx), /not a downloadable file attachment/);
});

test('move and flag hit the right Graph endpoints (acts)', async () => {
    const { fetch, calls } = fakeGraph({ 'POST /me/messages/AAA/move': { _status: 201 }, 'PATCH /me/messages/AAA': { _status: 200 } });
    const g = graphMail({ fetch, token: mint });
    await g.move(target, { uid: 'AAA', mailbox: 'archive' }, ctx);
    assert.equal(calls[0].body.destinationId, 'archive');
    await g.flag(target, { uid: 'AAA', flag: 'read' }, ctx);
    assert.deepEqual(calls[1].body, { isRead: true });
});

test('remove soft-deletes a message via Graph DELETE', async () => {
    const { fetch, calls } = fakeGraph({ 'DELETE /me/messages/X': { _status: 204 } });
    const g = graphMail({ fetch, token: mint });
    const r = await g.remove(target, { uid: 'X' }, ctx);
    assert.match(r.text, /Deleted X/);
    assert.equal(calls[0].method, 'DELETE');
    assert.match(calls[0].path, /\/me\/messages\/X/);
});

test('a 401 says to reconnect (scope may be missing)', async () => {
    const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const g = graphMail({ fetch, token: mint });
    await assert.rejects(() => g.list(target, {}, ctx), /reconnect the account/);
});
