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
        return { ok: status < 400, status, json: async () => hit };
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

test('send posts a well-formed Graph message from the fields', async () => {
    const { fetch, calls } = fakeGraph({ 'POST /me/sendMail': { _status: 202 } });
    const g = graphMail({ fetch, token: mint });
    await g.send(target, { to: 'c@example.com, e@example.org', subject: 'Yo', body: 'text' }, ctx);
    const sent = calls[0];
    assert.equal(sent.method, 'POST');
    assert.deepEqual(sent.body.message.toRecipients.map((r) => r.emailAddress.address), ['c@example.com', 'e@example.org']);
    assert.equal(sent.body.message.body.content, 'text');
});

test('move and flag hit the right Graph endpoints (acts)', async () => {
    const { fetch, calls } = fakeGraph({ 'POST /me/messages/AAA/move': { _status: 201 }, 'PATCH /me/messages/AAA': { _status: 200 } });
    const g = graphMail({ fetch, token: mint });
    await g.move(target, { uid: 'AAA', mailbox: 'archive' }, ctx);
    assert.equal(calls[0].body.destinationId, 'archive');
    await g.flag(target, { uid: 'AAA', flag: 'read' }, ctx);
    assert.deepEqual(calls[1].body, { isRead: true });
});

test('a 401 says to reconnect (scope may be missing)', async () => {
    const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const g = graphMail({ fetch, token: mint });
    await assert.rejects(() => g.list(target, {}, ctx), /reconnect the account/);
});
