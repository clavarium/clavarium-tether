/* THE MAIL CONNECTOR, with no network and no real account: `fetch` (the token
 * refresh) and `connect` (the IMAP socket) are injected. A scripted IMAP server
 * answers over a fake socket; the token is a placeholder and nothing is a real box. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mail } from '../host/connectors/mail.mjs';

const okToken = async () => new Response(JSON.stringify({ access_token: 'ACCESS-Tok', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
const HEADERS = (from, subj) => `From: ${from}\r\nSubject: ${subj}\r\nDate: Wed, 01 Jan 2030 09:00:00 +0000\r\n\r\n`;

/* A scripted IMAP server over a fake socket: records commands, answers by command. */
function imapServer(store) {
    const commands = [];
    const connect = () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = (text) => {
            const line = text.replace(/\r\n$/, '');
            const sp = line.indexOf(' ');
            const tag = line.slice(0, sp);
            const cmd = line.slice(sp + 1);
            commands.push(cmd);
            let reply;
            if (cmd.startsWith('AUTHENTICATE XOAUTH2')) reply = `${tag} OK authenticated\r\n`;
            else if (cmd.startsWith('EXAMINE')) reply = `${tag} OK [READ-ONLY] done\r\n`;
            else if (cmd.startsWith('UID SEARCH')) reply = `* SEARCH ${store.map((m) => m.uid).join(' ')}\r\n${tag} OK\r\n`;
            else if (cmd.startsWith('UID FETCH')) {
                const uid = Number(cmd.split(' ')[2]);
                const m = store.find((x) => x.uid === uid) ?? store[0];
                if (cmd.includes('HEADER.FIELDS')) {
                    const hdr = HEADERS(m.from, m.subject);
                    reply = `* 1 FETCH (UID ${m.uid} INTERNALDATE "01-Jan-2030 09:00:00 +0000" BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(hdr)}}\r\n${hdr})\r\n${tag} OK\r\n`;
                } else {
                    const body = `${HEADERS(m.from, m.subject)}${m.body}`;
                    reply = `* 1 FETCH (UID ${m.uid} BODY[] {${Buffer.byteLength(body)}}\r\n${body})\r\n${tag} OK\r\n`;
                }
            } else reply = `${tag} OK\r\n`;
            const b = Buffer.from(reply); const cut = Math.max(1, Math.floor(b.length / 2));
            setImmediate(() => { socket.emit('data', b.subarray(0, cut)); setImmediate(() => socket.emit('data', b.subarray(cut))); });
        };
        setImmediate(() => socket.emit('data', Buffer.from('* OK Gimap ready\r\n')));
        return socket;
    };
    return { connect, commands };
}

const TARGET = { id: 't1', title: 'Inbox', config: { provider: 'google', user: 'me@example.com' }, secrets: { refresh: 'mail-refresh' } };
const ctx = () => ({ secret: async (k) => (k === 'refresh' ? 'REFRESH-TOK' : undefined) });
const STORE = [
    { uid: 5, from: 'Alice <alice@example.com>', subject: 'Lunch?', body: 'Are you free Friday?\r\n' },
    { uid: 6, from: 'Bob <bob@example.com>', subject: 'The report', body: 'It is attached.\r\n' },
];

test('mail.list: authenticates with XOAUTH2 (token minted from the refresh), read-only, and briefs the messages', async () => {
    const s = imapServer(STORE);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.list', TARGET, {}, ctx());
    assert.ok(r.text.includes('Alice') && r.text.includes('Lunch?'), 'shows sender and subject');
    const auth = s.commands.find((x) => x.startsWith('AUTHENTICATE XOAUTH2'));
    assert.ok(auth, 'used XOAUTH2, not LOGIN');
    assert.equal(Buffer.from(auth.split(' ')[2], 'base64').toString('utf8'), 'user=me@example.com\x01auth=Bearer ACCESS-Tok\x01\x01', 'the minted access token, never a password');
    assert.ok(s.commands.some((x) => x.startsWith('EXAMINE')), 'opened read-only');
    assert.ok(!s.commands.some((x) => /STORE|APPEND|UID MOVE|DELETE|EXPUNGE/i.test(x)), 'nothing was written');
});

test('mail.read returns a message in full by its uid', async () => {
    const s = imapServer(STORE);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.read', TARGET, { uid: '6' }, ctx());
    assert.ok(r.text.includes('The report') && r.text.includes('It is attached.'), 'headers and body');
});

test('mail.search runs a text search and briefs the hits', async () => {
    const s = imapServer(STORE);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.search', TARGET, { text: 'report' }, ctx());
    assert.ok(s.commands.some((x) => /^UID SEARCH TEXT "report"/.test(x)), 'a text search for the term');
    assert.ok(r.text.includes('Bob') || r.text.includes('Alice'), 'briefs results');
});

test('a classic IMAP box (host + password) signs in with LOGIN, not a token', async () => {
    const s = imapServer(STORE);
    const classic = { id: 'c1', title: 'Box', config: { host: 'imap.example.com', user: 'alice' }, secrets: { password: 'mail-pw' } };
    const pwCtx = { secret: async (k) => (k === 'password' ? 'SECRET-PW' : undefined) };
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.list', classic, {}, pwCtx);
    assert.ok(r.text.includes('Alice'), 'it reads the box');
    assert.ok(s.commands.some((x) => /^LOGIN "alice" "SECRET-PW"/.test(x)), 'LOGIN with the password');
    assert.ok(!s.commands.some((x) => x.startsWith('AUTHENTICATE')), 'no token auth for a classic box');
});

test('mail.move opens read-write and UID MOVEs; mail.flag UID STOREs the system flag', async () => {
    const s = imapServer(STORE);
    const c = mail({ fetch: okToken, connect: s.connect });
    const moved = await c.run('mail.move', TARGET, { uid: '6', mailbox: 'Archive' }, ctx());
    assert.ok(moved.text.includes('Moved #6 to Archive'), 'confirms the move');
    assert.ok(s.commands.some((x) => x.startsWith('SELECT')), 'opened read-write (SELECT, not EXAMINE)');
    assert.ok(s.commands.some((x) => /^UID MOVE 6 "Archive"/.test(x)), 'UID MOVE to the folder');
    const s2 = imapServer(STORE);
    const flagged = await mail({ fetch: okToken, connect: s2.connect }).run('mail.flag', TARGET, { uid: '5', flag: 'read' }, ctx());
    assert.ok(flagged.text.includes('Marked #5 read'), 'confirms the mark');
    assert.ok(s2.commands.some((x) => /^UID STORE 5 \+FLAGS \(\\Seen\)/.test(x)), 'marks \\Seen');
    await assert.rejects(c.run('mail.flag', TARGET, { uid: '5', flag: 'bogus' }, ctx()), /read, unread, flagged/);
});

test('mail refuses a target with no provider and no host, and an unknown verb', async () => {
    const s = imapServer(STORE);
    const c = mail({ fetch: okToken, connect: s.connect });
    await assert.rejects(c.run('mail.list', { id: 'x', title: 'X', config: { user: 'u' }, secrets: { password: 'p' } }, {}, ctx()), /mail server \(host\), or a google\/microsoft/);
    await assert.rejects(async () => c.run('mail.delete', TARGET, {}, ctx()), /not done by this connector/);
});
