/* THE MAIL CONNECTOR, with no network and no real account: `fetch` (the token
 * refresh) and `connect` (the IMAP socket) are injected. A scripted IMAP server
 * answers over a fake socket; the token is a placeholder and nothing is a real box. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mail, renderMessage } from '../host/connectors/mail.mjs';
import { Exchange } from '../host/imap.mjs';
import { buildMessage } from '../host/smtp.mjs';

test('buildMessage joins a file as a multipart/mixed message', () => {
    const msg = buildMessage({ from: 'me@example.com', to: ['bob@example.com'], subject: 'Hi', body: 'see attached', attach: 'QUJDREVG', attachName: 'r.txt' });
    assert.match(msg, /Content-Type: multipart\/mixed; boundary="/);
    assert.match(msg, /Content-Disposition: attachment; filename="r\.txt"/);
    assert.match(msg, /Content-Transfer-Encoding: base64/);
    assert.ok(msg.includes('QUJDREVG'), 'the base64 bytes are in the file part');
    assert.match(msg, /see attached/, 'the text is still there');
});

test('buildMessage joins SEVERAL files, each its own part', () => {
    const msg = buildMessage({ from: 'me@example.com', to: ['bob@example.com'], subject: 'Hi', body: 'both attached',
        attachments: [{ name: 'a.html', bytes: 'QUJD' }, { name: 'b.html', bytes: 'REVG' }] });
    assert.match(msg, /multipart\/mixed/);
    assert.match(msg, /filename="a\.html"/, 'first file is there');
    assert.match(msg, /filename="b\.html"/, 'second file is there too (not dropped)');
    assert.match(msg, /both attached/, 'the text is still there');
});

test('buildMessage without a file stays plain text', () => {
    const msg = buildMessage({ from: 'me@example.com', to: ['bob@example.com'], subject: 'Hi', body: 'hello' });
    assert.match(msg, /Content-Type: text\/plain/);
    assert.doesNotMatch(msg, /multipart/);
});

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
                const set = cmd.split(' ')[2].split(',').map(Number);
                const wanted = store.filter((x) => set.includes(x.uid));
                const picked = wanted.length ? wanted : [store[0]];
                if (cmd.includes('HEADER.FIELDS')) {
                    reply = picked.map((m, i) => { const hdr = HEADERS(m.from, m.subject); return `* ${i + 1} FETCH (UID ${m.uid} INTERNALDATE "01-Jan-2030 09:00:00 +0000" BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(hdr)}}\r\n${hdr})\r\n`; }).join('') + `${tag} OK\r\n`;
                } else {
                    const m = picked[0];
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
    assert.ok(r.text.includes('Bob') && r.text.includes('The report'), 'every message, not just one');
    assert.equal(s.commands.filter((x) => x.startsWith('UID FETCH')).length, 1, 'one fetch for all the briefs, not one per message');
    const auth = s.commands.find((x) => x.startsWith('AUTHENTICATE XOAUTH2'));
    assert.ok(auth, 'used XOAUTH2, not LOGIN');
    assert.equal(Buffer.from(auth.split(' ')[2], 'base64').toString('utf8'), 'user=me@example.com\x01auth=Bearer ACCESS-Tok\x01\x01', 'the minted access token, never a password');
    assert.ok(s.commands.some((x) => x.startsWith('EXAMINE')), 'opened read-only');
    assert.ok(!s.commands.some((x) => /STORE|APPEND|UID MOVE|DELETE|EXPUNGE/i.test(x)), 'nothing was written');
});

test('mail.list takes a since/before window over IMAP, else the default lookback', async () => {
    const s = imapServer(STORE);
    await mail({ fetch: okToken, connect: s.connect }).run('mail.list', TARGET, { since: '2026-01-01', before: '2026-02-01' }, ctx());
    assert.ok(s.commands.some((x) => x === 'UID SEARCH SINCE 1-Jan-2026 BEFORE 1-Feb-2026'), 'a dated window search');
    const s2 = imapServer(STORE);
    await mail({ fetch: okToken, connect: s2.connect }).run('mail.list', TARGET, {}, ctx());
    const bare = s2.commands.find((x) => x.startsWith('UID SEARCH'));
    assert.ok(/^UID SEARCH SINCE /.test(bare) && !/BEFORE/.test(bare), 'a bare list looks back a window, no BEFORE');
});

test('mail.list rejects a date it cannot read', async () => {
    const s = imapServer(STORE);
    await assert.rejects(() => mail({ fetch: okToken, connect: s.connect }).run('mail.list', TARGET, { since: 'whenever' }, ctx()), /since must be a date/);
});

test('renderMessage surfaces a calendar invitation (title and date) from a text/calendar part', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:PG X Emilie\r\nDTSTART:20261110T160000Z\r\nDTEND:20261110T170000Z\r\nLOCATION:Microsoft Teams\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const raw = ['Subject: Invitation', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'Join on Teams: https://teams.example', '--b', 'Content-Type: text/calendar; method=REQUEST', '', ics, '--b--', ''].join('\r\n');
    const m = renderMessage(raw);
    assert.match(m, /--- Invitation ---/, 'an invitation section');
    assert.match(m, /PG X Emilie/, 'its title');
    assert.match(m, /2026-11-10 16:00/, 'the real start date, not just the Teams link');
    assert.match(m, /Microsoft Teams/, 'where');
});

test('mail.list says when more than the cap matched, never truncating in silence', async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ uid: i + 1, from: `p${i} <p${i}@example.com>`, subject: `m${i}`, body: 'x\r\n' }));
    const s = imapServer(big);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.list', TARGET, {}, ctx());
    assert.match(r.text, /Showing the 30 most recent of 40/, 'the cap is announced with the real total');
});

test('mail.read returns a message in full by its uid', async () => {
    const s = imapServer(STORE);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.read', TARGET, { uid: '6' }, ctx());
    assert.ok(r.text.includes('The report') && r.text.includes('It is attached.'), 'headers and body');
});

/* A server that returns one crafted raw message for any UID FETCH (for source/attachment). */
function imapWithRaw(uid, raw) {
    const connect = () => {
        const socket = new EventEmitter(); socket.destroy = () => {};
        socket.write = (text) => {
            const line = text.replace(/\r\n$/, ''); const sp = line.indexOf(' '); const tag = line.slice(0, sp); const cmd = line.slice(sp + 1);
            let reply = `${tag} OK\r\n`;
            if (cmd.startsWith('AUTHENTICATE XOAUTH2')) reply = `${tag} OK authenticated\r\n`;
            else if (cmd.startsWith('EXAMINE')) reply = `${tag} OK [READ-ONLY] done\r\n`;
            else if (cmd.startsWith('UID FETCH')) reply = `* 1 FETCH (UID ${uid} BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK\r\n`;
            setImmediate(() => socket.emit('data', Buffer.from(reply)));
        };
        setImmediate(() => socket.emit('data', Buffer.from('* OK ready\r\n')));
        return socket;
    };
    return { connect };
}

test('mail.source returns the raw message (headers and body), not just the readable view', async () => {
    const raw = 'From: A <a@example.com>\r\nSubject: hi\r\nContent-Type: text/html\r\n\r\n<p>body here</p>';
    const r = await mail({ fetch: okToken, connect: imapWithRaw(7, raw).connect }).run('mail.source', TARGET, { uid: '7' }, ctx());
    assert.match(r.text, /Subject: hi/);
    assert.match(r.text, /<p>body here<\/p>/, 'the raw HTML, untouched');
});

test('mail.attachment extracts one attachment and returns its real bytes as base64', async () => {
    const raw = ['From: A <a@example.com>', 'Subject: files', 'Content-Type: multipart/mixed; boundary="xb"', '', '--xb', 'Content-Type: text/plain', '', 'see attached', '--xb', 'Content-Type: application/pdf; name="r.pdf"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="r.pdf"', '', Buffer.from('PDF-BYTES').toString('base64'), '--xb--', ''].join('\r\n');
    const r = await mail({ fetch: okToken, connect: imapWithRaw(9, raw).connect }).run('mail.attachment', TARGET, { uid: '9', which: 'r.pdf' }, ctx());
    assert.match(r.text, /r\.pdf \(application\/pdf/, 'names the file and its type');
    assert.equal(Buffer.from(r.text.split('\n\n').pop().trim(), 'base64').toString(), 'PDF-BYTES', 'the decoded bytes are the file itself');
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

test('a warm connection is reused across verbs: one sign-in, not one per verb', async () => {
    const s = imapServer(STORE);
    let connects = 0;
    const m = mail({ fetch: okToken, connect: (...args) => { connects++; return s.connect(...args); } });
    await m.run('mail.list', TARGET, {}, ctx());
    await m.run('mail.read', TARGET, { uid: '6' }, ctx());
    assert.equal(connects, 1, 'the second verb reused the open connection');
    assert.equal(s.commands.filter((x) => x.startsWith('AUTHENTICATE XOAUTH2')).length, 1, 'signed in once, not twice');
    m.shutdown();
});

test('two verbs at once are serialized on the one connection, not interleaved', async () => {
    const s = imapServer(STORE);
    let connects = 0;
    const m = mail({ fetch: okToken, connect: (...args) => { connects++; return s.connect(...args); } });
    const [a, b] = await Promise.all([m.run('mail.list', TARGET, {}, ctx()), m.run('mail.read', TARGET, { uid: '5' }, ctx())]);
    assert.ok(a.text.includes('Alice') && b.text.includes('Alice'), 'both verbs got their answer');
    assert.equal(connects, 1, 'one connection served both');
    m.shutdown();
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

test('mail.delete marks the message \\Deleted and expunges just that uid (IMAP)', async () => {
    const s = imapServer(STORE);
    const r = await mail({ fetch: okToken, connect: s.connect }).run('mail.delete', TARGET, { uid: '6' }, ctx());
    assert.match(r.text, /Deleted #6/);
    assert.ok(s.commands.some((x) => /^SELECT/.test(x)), 'opened read-write');
    assert.ok(s.commands.some((x) => /^UID STORE 6 \+FLAGS \(\\Deleted\)/.test(x)), 'flagged it deleted');
    assert.ok(s.commands.some((x) => /^UID EXPUNGE 6/.test(x)), 'expunged that one uid');
});

test('mail refuses a target with no provider and no host, and an unknown verb', async () => {
    const s = imapServer(STORE);
    const c = mail({ fetch: okToken, connect: s.connect });
    await assert.rejects(c.run('mail.list', { id: 'x', title: 'X', config: { user: 'u' }, secrets: { password: 'p' } }, {}, ctx()), /mail server \(host\), or a google\/microsoft/);
    await assert.rejects(async () => c.run('mail.nope', TARGET, {}, ctx()), /not done by this connector/);
});
