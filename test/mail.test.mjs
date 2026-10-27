/* THE MAIL CONNECTOR, with no network and no real account: `fetch` (the token
 * refresh) and `connect` (the IMAP socket) are injected. A scripted IMAP server
 * answers over a fake socket; the token is a placeholder and nothing is a real box. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mail, renderMessage } from '../host/connectors/mail.mjs';
import { Exchange } from '../host/imap.mjs';

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

test('a server that connects but never answers fails in time, it does not hang', async () => {
    const socket = Object.assign(new EventEmitter(), { write() {} });
    const imap = new Exchange(socket, 1_000_000, 40); /* 40ms idle for the test */
    await assert.rejects(imap.greeting(), /did not answer in time/);
});

test('renderMessage: decodes the text, prefers plain, strips HTML, lists attachments', () => {
    /* quoted-printable with an accent, soft line break */
    const qp = 'Subject: QP\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 =\r\nchaud';
    assert.ok(renderMessage(qp).includes('Café chaud'), 'quoted-printable decoded');
    /* multipart/alternative: the plain part is chosen, not the HTML */
    const alt = 'Subject: Alt\r\nContent-Type: multipart/alternative; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nplain wins\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--B--';
    const a = renderMessage(alt);
    assert.ok(a.includes('plain wins') && !a.includes('<p>'), 'plain chosen, no html tags');
    /* an attachment is listed by name and type, never its bytes */
    const mixed = 'Subject: Att\r\nContent-Type: multipart/mixed; boundary="X"\r\n\r\n--X\r\nContent-Type: text/plain\r\n\r\nbody text\r\n--X\r\nContent-Type: application/pdf; name="r.pdf"\r\nContent-Disposition: attachment; filename="r.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nQUJDREVG\r\n--X--';
    const m = renderMessage(mixed);
    assert.ok(m.includes('body text') && /Attachments \(1\)/.test(m) && m.includes('r.pdf') && m.includes('application/pdf'), 'body plus an attachment line');
    assert.ok(!m.includes('QUJDREVG'), 'the attachment bytes are never printed');
    /* HTML-only falls back to stripped text */
    assert.ok(renderMessage('Subject: H\r\nContent-Type: text/html\r\n\r\n<h1>Hi</h1><p>x &amp; y</p>').includes('x & y'), 'html stripped to text');
});

test('mail.search runs a text search and briefs the hits', async () => {
    const s = imapServer(STORE);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.search', TARGET, { text: 'report' }, ctx());
    assert.ok(s.commands.some((x) => /^UID SEARCH TEXT "report"/.test(x)), 'a text search for the term');
    assert.ok(r.text.includes('Bob') || r.text.includes('Alice'), 'briefs results');
});

/* A scripted SMTP server: a plain socket (greeting, EHLO, STARTTLS), then `secure`
   returns a fresh socket for the TLS phase (EHLO, AUTH, MAIL/RCPT/DATA). */
function smtpServer() {
    const commands = [];
    const reply = (s, text) => setImmediate(() => s.emit('data', Buffer.from(text)));
    const make = () => {
        const s = new EventEmitter(); s.destroy = () => {}; s._auth = 0;
        s.write = (text) => {
            if (/\r\n\.\r\n$/.test(text)) { commands.push('<message>'); return reply(s, '250 queued\r\n'); }
            const cmd = text.replace(/\r\n$/, '');
            commands.push(cmd.length > 70 ? `${cmd.slice(0, 70)}…` : cmd);
            if (s._auth === 1) { s._auth = 2; return reply(s, '334 UGFzc3dvcmQ6\r\n'); }
            if (s._auth === 2) { s._auth = 0; return reply(s, '235 ok\r\n'); }
            if (/^EHLO/.test(cmd)) return reply(s, '250-hi\r\n250-STARTTLS\r\n250 AUTH XOAUTH2 LOGIN\r\n');
            if (cmd === 'STARTTLS') return reply(s, '220 go ahead\r\n');
            if (/^AUTH XOAUTH2/.test(cmd)) return reply(s, '235 accepted\r\n');
            if (cmd === 'AUTH LOGIN') { s._auth = 1; return reply(s, '334 VXNlcm5hbWU6\r\n'); }
            if (cmd === 'DATA') return reply(s, '354 go ahead\r\n');
            if (cmd === 'QUIT') return reply(s, '221 bye\r\n');
            return reply(s, '250 ok\r\n');
        };
        return s;
    };
    return { commands, connect: () => { const s = make(); reply(s, '220 smtp ready\r\n'); return s; }, secure: () => make() };
}

test('mail.send (provider): STARTTLS, XOAUTH2, and the message is accepted', async () => {
    const m = smtpServer();
    const r = await mail({ fetch: okToken, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.send', TARGET, { to: 'bob@example.com', subject: 'Hi', body: 'Hello there.' }, ctx());
    assert.ok(r.text.includes('Sent to bob@example.com'), 'confirms the send');
    assert.ok(m.commands.includes('STARTTLS'), 'upgraded to TLS first');
    assert.ok(m.commands.some((x) => x.startsWith('AUTH XOAUTH2')), 'XOAUTH2, not a password');
    assert.ok(m.commands.some((x) => x.startsWith('MAIL FROM:<me@example.com>')), 'from the mailbox itself');
    assert.ok(m.commands.some((x) => x.startsWith('RCPT TO:<bob@example.com>')), 'to the recipient');
    assert.ok(m.commands.includes('<message>'), 'the message body went out');
});

test('mail.send (classic): AUTH LOGIN on the SMTP server', async () => {
    const m = smtpServer();
    const classic = { id: 'c2', title: 'Box', config: { host: 'imap.example.com', smtpHost: 'smtp.example.com', user: 'alice@example.com' }, secrets: { password: 'pw' } };
    const r = await mail({ fetch: okToken, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.send', classic, { to: 'bob@example.com', subject: 'Hi', body: 'yo' }, { secret: async (k) => (k === 'password' ? 'PW' : undefined) });
    assert.ok(r.text.includes('Sent to bob@example.com'));
    assert.ok(m.commands.includes('AUTH LOGIN'), 'password auth for a classic box');
    assert.ok(!m.commands.some((x) => x.startsWith('AUTH XOAUTH2')), 'no token auth');
});

test('mail.send refuses a bad recipient address', async () => {
    const m = smtpServer();
    await assert.rejects(mail({ fetch: okToken, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.send', TARGET, { to: 'not an address', subject: 'x', body: 'y' }, ctx()), /not a usable address/);
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
