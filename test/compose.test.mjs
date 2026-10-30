/* WRITING A MESSAGE: Markdown to text + HTML, Cc/Bcc, a reply in its thread, a
 * forward with (or without) the original's files, a draft kept instead of sent --
 * over IMAP/SMTP (Google, a classic box). A scripted IMAP server and a scripted
 * SMTP server over fake sockets; nothing real is reached. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mail, originalOf, decodeWords } from '../host/connectors/mail.mjs';
import { markdownToHtml, markdownToText, compose, replySubject, forwardSubject, keptFiles } from '../host/compose.mjs';
import { buildMessage, quotedPrintable, encodeWords } from '../host/smtp.mjs';

const qpDecode = (s) => Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');

test('Markdown becomes HTML: marks, lists, quotes, code, safe links only', () => {
    const h = markdownToHtml('# Plan\n\nHello **Bob**, see *this*:\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n`a<b>`\n\n[site](https://example.com) [bad](javascript:alert(1)) <script>x</script>');
    assert.match(h, /<h1>Plan<\/h1>/);
    assert.match(h, /Hello <strong>Bob<\/strong>, see <em>this<\/em>:/);
    assert.match(h, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(h, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(h, /<blockquote[^>]*><p>quoted<\/p><\/blockquote>/);
    assert.match(h, /<code>a&lt;b&gt;<\/code>/);
    assert.match(h, /<a href="https:\/\/example\.com">site<\/a>/);
    assert.doesNotMatch(h, /href="javascript/, 'no script link');
    assert.doesNotMatch(h, /<script>/, 'the agent\'s HTML is escaped, never passed');
});

test('Markdown becomes plain text: marks off, shape kept, lines kept', () => {
    const t = markdownToText('Hello **Bob**,\nsee [the site](https://example.com).\n\n- one\n- two');
    assert.equal(t, 'Hello Bob,\nsee the site (https://example.com).\n\n- one\n- two');
});

test('a file name with snake_case or a URL with underscores is not turned italic', () => {
    assert.doesNotMatch(markdownToHtml('see my_file_name.txt and https://ex.com/a_b_c'), /<em>/);
});

test('compose: text + HTML, the signature, then the quote; format "text" keeps the body', () => {
    const c = compose({ body: 'Hi **you**', signature: 'Alice\nACME', quote: { text: '> old', html: '<blockquote>old</blockquote>' } });
    assert.equal(c.text, 'Hi you\n\n-- \nAlice\nACME\n\n> old');
    assert.match(c.html, /<strong>you<\/strong>[\s\S]*-- <br>[\s\S]*Alice<br>\nACME[\s\S]*<blockquote>old/);
    assert.deepEqual(compose({ body: '**raw**', format: 'text' }), { text: '**raw**' });
});

test('subjects: Re/Fwd once, never doubled', () => {
    assert.equal(replySubject('Lunch'), 'Re: Lunch');
    assert.equal(replySubject('RE: Lunch'), 'RE: Lunch');
    assert.equal(forwardSubject('Lunch'), 'Fwd: Lunch');
    assert.equal(forwardSubject('TR: Lunch'), 'TR: Lunch');
});

test('keptFiles: all by default, none, some by name or number; an unknown name refused', () => {
    const f = [{ name: 'plan.pdf' }, { name: 'photo.png' }];
    assert.equal(keptFiles(f).length, 2);
    assert.equal(keptFiles(f, 'none').length, 0);
    assert.deepEqual(keptFiles(f, 'photo').map((x) => x.name), ['photo.png']);
    assert.deepEqual(keptFiles(f, '1').map((x) => x.name), ['plan.pdf']);
    assert.throws(() => keptFiles(f, 'budget'), /no attachment "budget"/);
});

test('buildMessage: Cc header, text + HTML alternative, thread ids, typed files, encoded accents', () => {
    const msg = buildMessage({ from: 'me@example.com', to: ['bob@example.com'], cc: ['carol@example.com'], subject: 'Réunion', text: 'Bonjour é', html: '<p>Bonjour é</p>',
        inReplyTo: '<m1@x>', references: '<m0@x> <m1@x>', attachments: [{ name: 'plan.pdf', bytes: 'QUJD' }, { name: 'été.txt', bytes: 'REVG' }] });
    assert.match(msg, /^Cc: carol@example\.com$/m);
    assert.match(msg, /^Subject: =\?UTF-8\?B\?/m);
    assert.equal(decodeWords(/^Subject: (.*)$/m.exec(msg)[1]), 'Réunion');
    assert.match(msg, /^In-Reply-To: <m1@x>$/m);
    assert.match(msg, /^References: <m0@x> <m1@x>$/m);
    assert.match(msg, /^Message-ID: <[^>]+@example\.com>$/m);
    assert.match(msg, /multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*text\/plain[\s\S]*text\/html/);
    assert.match(msg, /Content-Type: application\/pdf; name="plan\.pdf"/);
    assert.match(msg, /filename\*=UTF-8''%C3%A9t%C3%A9\.txt/);
    assert.ok(msg.split('\r\n').every((l) => l.length <= 998), 'no line over the SMTP limit');
});

test('quoted-printable keeps accents and cuts long lines softly', () => {
    const long = 'é'.repeat(200);
    const qp = quotedPrintable(long);
    assert.ok(qp.split('\r\n').every((l) => l.length <= 76));
    assert.equal(qpDecode(qp), long);
    assert.equal(encodeWords('plain'), 'plain');
});

/* ---------- over the wire ---------- */
const okToken = async () => new Response(JSON.stringify({ access_token: 'ACCESS-Tok', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
const TARGET = { id: 't1', title: 'Inbox', config: { provider: 'google', user: 'me@example.com', signature: 'Me' }, secrets: { refresh: 'r' } };
const ctx = () => ({ secret: async (k) => (k === 'refresh' ? 'REFRESH' : undefined) });

const ORIGINAL = [
    'From: Bob <bob@example.com>', 'To: me@example.com, Carol <carol@example.com>', 'Cc: dan@example.com', 'Subject: =?UTF-8?Q?Le_plan_=C3=A9t=C3=A9?=',
    'Date: Wed, 01 Jan 2030 09:00:00 +0000', 'Message-ID: <orig@example.com>', 'References: <older@example.com>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XX"', '', '--XX', 'Content-Type: text/plain; charset=utf-8', '', 'Here is the plan.', 'Two lines.',
    '--XX', 'Content-Type: application/pdf; name="plan.pdf"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="plan.pdf"', '', Buffer.from('%PDF-1.4 bytes').toString('base64'),
    '--XX', 'Content-Type: image/png; name="photo.png"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="photo.png"', '', Buffer.from('PNGDATA').toString('base64'),
    '--XX--', '',
].join('\r\n');

function imapServer(raw, { drafts = '[Gmail]/Brouillons' } = {}) {
    const commands = []; const appended = [];
    const connect = () => {
        const socket = new EventEmitter(); socket.destroy = () => {};
        let pending = null;
        const send = (t) => setImmediate(() => socket.emit('data', Buffer.from(t)));
        socket.write = (data) => {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
            if (pending) { appended.push({ box: pending.box, flags: pending.flags, message: text.replace(/\r\n$/, '') }); send(`${pending.tag} OK [APPENDUID 1 9] done\r\n`); pending = null; return; }
            const line = text.replace(/\r\n$/, ''); const sp = line.indexOf(' ');
            const tag = line.slice(0, sp); const cmd = line.slice(sp + 1);
            commands.push(cmd);
            const ap = /^APPEND "((?:[^"\\]|\\.)*)" \(([^)]*)\) \{(\d+)\}$/.exec(cmd);
            if (ap) { pending = { tag, box: ap[1], flags: ap[2] }; return send('+ Ready\r\n'); }
            if (cmd.startsWith('LIST')) return send(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Drafts) "/" "${drafts}"\r\n${tag} OK\r\n`);
            if (/RFC822\.SIZE/.test(cmd)) return send(`* 1 FETCH (UID 7 RFC822.SIZE ${Buffer.byteLength(raw)})\r\n${tag} OK\r\n`);
            if (/BODY\.PEEK\[\]/.test(cmd)) return send(`* 1 FETCH (UID 7 BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK\r\n`);
            return send(`${tag} OK\r\n`);
        };
        setImmediate(() => socket.emit('data', Buffer.from('* OK ready\r\n')));
        return socket;
    };
    return { connect, commands, appended };
}
function smtpServer() {
    const commands = []; const messages = [];
    const reply = (s, t) => setImmediate(() => s.emit('data', Buffer.from(t)));
    const make = () => {
        const s = new EventEmitter(); s.destroy = () => {}; s.login = 0;
        s.write = (text) => {
            if (/\r\n\.\r\n$/.test(text)) { messages.push(text); return reply(s, '250 queued\r\n'); }
            const cmd = text.replace(/\r\n$/, ''); commands.push(cmd);
            if (cmd === 'AUTH LOGIN') { s.login = 1; return reply(s, '334 VXNlcm5hbWU6\r\n'); }
            if (s.login === 1) { s.login = 2; return reply(s, '334 UGFzc3dvcmQ6\r\n'); }
            if (s.login === 2) { s.login = 0; return reply(s, '235 ok\r\n'); }
            if (/^EHLO/.test(cmd)) return reply(s, '250-hi\r\n250 AUTH XOAUTH2\r\n');
            if (cmd === 'STARTTLS') return reply(s, '220 go\r\n');
            if (/^AUTH XOAUTH2/.test(cmd)) return reply(s, '235 ok\r\n');
            if (cmd === 'DATA') return reply(s, '354 go\r\n');
            return reply(s, '250 ok\r\n');
        };
        return s;
    };
    return { commands, messages, connect: () => { const s = make(); reply(s, '220 ready\r\n'); return s; }, secure: () => make() };
}
const rcpts = (m) => m.commands.filter((c) => c.startsWith('RCPT TO:')).map((c) => c.slice(9, -1));
const partOf = (msg, type) => { const m = new RegExp(`Content-Type: ${type}; charset=utf-8\\r\\nContent-Transfer-Encoding: quoted-printable\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--b_`).exec(msg); return m ? qpDecode(m[1]).replace(/\r\n/g, "\n") : null; };

test('originalOf reads who, thread ids, text and files of a raw message', () => {
    const o = originalOf(ORIGINAL);
    assert.equal(o.subject, 'Le plan été');
    assert.equal(o.messageId, '<orig@example.com>');
    assert.match(o.text, /Here is the plan/);
    assert.deepEqual(o.files.map((f) => f.name), ['plan.pdf', 'photo.png']);
});

test('mail.send: Markdown body goes as text + HTML; Cc and Bcc all receive it, Bcc never in a header', async () => {
    const m = smtpServer();
    const r = await mail({ fetch: okToken, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.send', TARGET, { to: 'bob@example.com', cc: 'carol@example.com', bcc: 'hidden@example.com', subject: 'Hi', body: 'Hello **Bob**' }, ctx());
    assert.deepEqual(rcpts(m), ['bob@example.com', 'carol@example.com', 'hidden@example.com']);
    const msg = m.messages[0];
    assert.match(msg, /^Cc: carol@example\.com$/m);
    assert.doesNotMatch(msg, /hidden@example\.com/, 'a Bcc is never written in the message');
    assert.equal(partOf(msg, 'text/plain'), 'Hello Bob\n\n-- \nMe');
    assert.match(partOf(msg, 'text/html'), /Hello <strong>Bob<\/strong>/);
    assert.match(r.text, /Sent to bob@example\.com \(cc carol@example\.com\)/);
});

test('mail.reply: to the sender only, in the thread, Re: subject, original quoted', async () => {
    const s = imapServer(ORIGINAL); const m = smtpServer();
    await mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.reply', TARGET, { uid: '7', body: 'Thanks!' }, ctx());
    assert.deepEqual(rcpts(m), ['bob@example.com'], 'only the sender, not the others');
    const msg = m.messages[0];
    assert.match(msg, /^In-Reply-To: <orig@example\.com>$/m);
    assert.match(msg, /^References: <older@example\.com> <orig@example\.com>$/m);
    assert.equal(decodeWords(/^Subject: (.*)$/m.exec(msg)[1]), 'Re: Le plan été');
    const text = partOf(msg, 'text/plain');
    assert.match(text, /^Thanks!\n\n-- \nMe\n\nLe Wed, 01 Jan 2030 09:00:00 \+0000, Bob <bob@example\.com> a écrit :\n> Here is the plan\.\n> Two lines\./);
    assert.doesNotMatch(msg, /plan\.pdf/, 'the original files are not sent back');
    assert.ok(!s.commands.some((c) => /^(SELECT|UID STORE|APPEND)/.test(c)), 'the mailbox is only read');
});

test('mail.reply with all: everyone but this mailbox, the others in Cc', async () => {
    const s = imapServer(ORIGINAL); const m = smtpServer();
    await mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.reply', TARGET, { uid: '7', body: 'ok', all: true }, ctx());
    assert.deepEqual(rcpts(m), ['bob@example.com', 'carol@example.com', 'dan@example.com']);
    assert.match(m.messages[0], /^Cc: carol@example\.com, dan@example\.com$/m);
    assert.doesNotMatch(m.messages[0], /^Cc:.*me@example\.com/m, 'never to oneself');
});

test('mail.forward keeps the original files, whole and typed, by default', async () => {
    const s = imapServer(ORIGINAL); const m = smtpServer();
    const r = await mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.forward', TARGET, { uid: '7', to: 'eve@example.com', body: 'FYI' }, ctx());
    const msg = m.messages[0];
    assert.deepEqual(rcpts(m), ['eve@example.com']);
    assert.equal(decodeWords(/^Subject: (.*)$/m.exec(msg)[1]), 'Fwd: Le plan été');
    assert.match(msg, /Content-Type: application\/pdf; name="plan\.pdf"/);
    assert.match(msg, /Content-Type: image\/png; name="photo\.png"/);
    assert.ok(msg.includes(Buffer.from('%PDF-1.4 bytes').toString('base64')), 'the file bytes are the original ones');
    assert.match(partOf(msg, 'text/plain'), /---------- Message transféré ----------\nDe: Bob <bob@example\.com>[\s\S]*Objet: Le plan été[\s\S]*Here is the plan\./);
    assert.match(r.text, /with plan\.pdf, photo\.png/);
});

test('mail.forward with keep "none" or a name: only what was chosen goes', async () => {
    let s = imapServer(ORIGINAL); let m = smtpServer();
    await mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.forward', TARGET, { uid: '7', to: 'eve@example.com', keep: 'none' }, ctx());
    assert.doesNotMatch(m.messages[0], /plan\.pdf|photo\.png/);
    s = imapServer(ORIGINAL); m = smtpServer();
    await mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.forward', TARGET, { uid: '7', to: 'eve@example.com', keep: 'photo', attachments: [{ name: 'note.txt', bytes: 'Tk9URQ==' }] }, ctx());
    assert.doesNotMatch(m.messages[0], /plan\.pdf/);
    assert.match(m.messages[0], /photo\.png/);
    assert.match(m.messages[0], /Content-Type: text\/plain; name="note\.txt"/, 'a new file joined too');
});

test('mail.forward naming a file the original lacks is refused, nothing sent', async () => {
    const s = imapServer(ORIGINAL); const m = smtpServer();
    await assert.rejects(mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.forward', TARGET, { uid: '7', to: 'eve@example.com', keep: 'budget' }, ctx()), /no attachment "budget"/);
    assert.equal(m.messages.length, 0);
});

test('a draft is APPENDed to the server\'s \\Drafts folder (whatever its name), never sent', async () => {
    const s = imapServer(ORIGINAL); const m = smtpServer();
    const r = await mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.reply', TARGET, { uid: '7', body: 'Draft answer', draft: true }, ctx());
    assert.equal(m.messages.length, 0, 'nothing sent');
    assert.equal(s.appended.length, 1);
    assert.equal(s.appended[0].box, '[Gmail]/Brouillons');
    assert.match(s.appended[0].flags, /\\Draft/);
    assert.match(s.appended[0].message, /^In-Reply-To: <orig@example\.com>$/m);
    assert.match(r.text, /Draft saved in \[Gmail\]\/Brouillons/);
});

test('a classic box (no provider) replies the same way, over its own SMTP', async () => {
    const s = imapServer(ORIGINAL); const m = smtpServer();
    const classic = { id: 'c1', title: 'Box', config: { host: 'imap.example.com', smtpHost: 'smtp.example.com', user: 'me@example.com', lang: 'en' }, secrets: { password: 'pw' } };
    await mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure }).run('mail.reply', classic, { uid: '7', body: 'Thanks' }, { secret: async () => 'PW' });
    assert.ok(s.commands.some((c) => c.startsWith('LOGIN')), 'IMAP with its password');
    assert.match(partOf(m.messages[0], 'text/plain'), /On Wed, 01 Jan 2030 09:00:00 \+0000, Bob <bob@example\.com> wrote:/, 'the quote line in the box language');
});

/* ---------- what is asked, checked and summed up ---------- */
import { check, detail } from '../server/verbs.mjs';
import { read as cliRead } from '../bin/cli.mjs';

test('check: reply needs uid and body, forward needs uid and to; options kept, a bad format refused', () => {
    assert.throws(() => check('mail.reply', { target: 'box', uid: '7' }), /needs body/);
    assert.throws(() => check('mail.forward', { target: 'box', uid: '7' }), /needs to/);
    const r = check('mail.reply', { target: 'box', uid: '7', body: 'ok', all: true, draft: 'true', bcc: 'h@example.com', signature: false });
    assert.equal(r.all, true); assert.equal(r.draft, true); assert.equal(r.bcc, 'h@example.com'); assert.equal(r.signature, false);
    assert.equal(check('mail.forward', { target: 'box', uid: '7', to: 'e@example.com', keep: 'none' }).keep, 'none');
    assert.throws(() => check('mail.send', { target: 'box', to: 'a@example.com', subject: 's', body: 'b', format: 'rtf' }), /format is markdown/);
});

test('detail: the person approving sees what a reply or forward does', () => {
    assert.equal(detail('mail.reply', { all: true, cc: 'c@example.com' }), 'reply to all to a message, cc c@example.com');
    assert.equal(detail('mail.forward', { to: 'e@example.com', keep: 'none', draft: true }), 'draft: forward a message to e@example.com (without its files)');
    assert.equal(detail('mail.forward', { to: 'e@example.com' }), 'forward a message to e@example.com (with its files)');
    assert.equal(detail('mail.send', { to: 'a@example.com', bcc: 'h@example.com', subject: 'S' }), 'to a@example.com, bcc h@example.com: S');
});

test('cli: mail reply and forward', () => {
    assert.deepEqual(cliRead(['mail', 'box', 'reply', '7', '--body', 'ok', '--all', '--draft']), ['mail.reply', { target: 'box', uid: '7', body: 'ok', all: true, draft: true }]);
    assert.deepEqual(cliRead(['mail', 'box', 'forward', '7', '--to', 'e@example.com', '--keep', 'none']), ['mail.forward', { target: 'box', uid: '7', to: 'e@example.com', keep: 'none' }]);
    assert.ok(cliRead(['mail', 'box', 'forward', '7']).refused);
});

/* ---------- sent later ---------- */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAt } from '../host/compose.mjs';
import { graphMail } from '../host/connectors/graphmail.mjs';

test('sendAt: a bare date-time is Paris wall-clock (winter and summer); past or far refused', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    assert.equal(sendAt('2026-11-02T08:30', now).toISOString(), '2026-11-02T07:30:00.000Z');
    assert.equal(sendAt('2027-07-01T08:30', now).toISOString(), '2027-07-01T06:30:00.000Z');
    assert.equal(sendAt('2026-11-02T08:30:00Z', now).toISOString(), '2026-11-02T08:30:00.000Z');
    assert.throws(() => sendAt('2026-10-01T08:30', now), /in the past/);
    assert.throws(() => sendAt('2028-10-01T08:30', now), /more than a year/);
    assert.throws(() => sendAt('tomorrow', now), /date-time like/);
});

/* An IMAP server that keeps what is APPENDed, finds it by Message-ID, and expunges. */
function draftsServer() {
    const commands = []; const kept = new Map(); let next = 40;
    const connect = () => {
        const socket = new EventEmitter(); socket.destroy = () => {};
        let pending = null;
        const send = (t) => setImmediate(() => socket.emit('data', Buffer.from(t)));
        socket.write = (data) => {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
            if (pending) { kept.set(next++, text.replace(/\r\n$/, '')); send(`${pending} OK done\r\n`); pending = null; return; }
            const line = text.replace(/\r\n$/, ''); const sp = line.indexOf(' ');
            const tag = line.slice(0, sp); const cmd = line.slice(sp + 1);
            commands.push(cmd);
            if (/^APPEND /.test(cmd)) { pending = tag; return send('+ Ready\r\n'); }
            if (cmd.startsWith('LIST')) return send(`* LIST (\\Drafts) "/" "Drafts"\r\n${tag} OK\r\n`);
            const hm = /^UID SEARCH HEADER Message-ID "(.*)"$/.exec(cmd);
            if (hm) { const uid = [...kept].find(([, m]) => m.includes(`Message-ID: ${hm[1]}`))?.[0]; return send(`* SEARCH${uid ? ` ${uid}` : ''}\r\n${tag} OK\r\n`); }
            const fm = /^UID FETCH (\d+) \(BODY\.PEEK\[\]\)$/.exec(cmd);
            if (fm) { const m = kept.get(Number(fm[1])); return send(`* 1 FETCH (UID ${fm[1]} BODY[] {${Buffer.byteLength(m)}}\r\n${m})\r\n${tag} OK\r\n`); }
            const xm = /^UID EXPUNGE (\d+)$/.exec(cmd);
            if (xm) kept.delete(Number(xm[1]));
            return send(`${tag} OK\r\n`);
        };
        setImmediate(() => socket.emit('data', Buffer.from('* OK ready\r\n')));
        return socket;
    };
    return { connect, commands, kept };
}

function laterHost(target, clock) {
    const notes = []; const stopped = new Set();
    return { notes, stopped, hand: { dir: mkdtempSync(join(tmpdir(), 'later-')), now: () => clock.t, target: (id) => (id === target.id ? target : null), ctx: () => ctx(), stopped: (id) => stopped.has(id), note: (l) => notes.push(l) } };
}

test('send later (IMAP): waits in Drafts, leaves at its time with its Bcc, then leaves Drafts', async () => {
    const clock = { t: Date.now() };
    const s = draftsServer(); const m = smtpServer();
    const conn = mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = laterHost(TARGET, clock); conn.wake(h.hand);
    const at = new Date(clock.t + 3600_000).toISOString();
    const r = await conn.run('mail.send', TARGET, { to: 'bob@example.com', bcc: 'hidden@example.com', subject: 'Later', body: 'Hi', at }, { ...ctx(), agent: 'claude' });
    assert.match(r.text, /Scheduled for .* waits in Drafts/);
    assert.equal(m.messages.length, 0, 'not sent yet');
    assert.equal(s.kept.size, 1, 'kept in Drafts');
    assert.equal(JSON.parse(readFileSync(join(h.hand.dir, 'mail-later.json'), 'utf8')).length, 1, 'remembered across a restart');
    await conn.tick();
    assert.equal(m.messages.length, 0, 'not before its time');
    clock.t += 3601_000;
    await conn.tick();
    assert.equal(m.messages.length, 1, 'sent at its time');
    assert.deepEqual(rcpts(m), ['bob@example.com', 'hidden@example.com'], 'the Bcc kept outside the message still receives it');
    assert.doesNotMatch(m.messages[0], /hidden@example\.com/);
    assert.equal(s.kept.size, 0, 'taken out of Drafts');
    assert.equal(conn.later().length, 0);
    assert.equal(h.notes[0].ok, true);
});

test('send later (IMAP): a draft deleted by a person is cancelled; a stopped agent holds it', async () => {
    const clock = { t: Date.now() };
    const s = draftsServer(); const m = smtpServer();
    const conn = mail({ fetch: okToken, connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = laterHost(TARGET, clock); conn.wake(h.hand);
    await conn.run('mail.send', TARGET, { to: 'bob@example.com', subject: 'A', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, { ...ctx(), agent: 'claude' });
    clock.t += 200_000;
    h.stopped.add('claude');
    await conn.tick();
    assert.equal(m.messages.length, 0, 'held while the agent is stopped');
    assert.equal(conn.later().length, 1);
    h.stopped.clear();
    s.kept.clear();   /* a person deleted the draft */
    await conn.tick();
    assert.equal(m.messages.length, 0, 'never sent');
    assert.equal(conn.later().length, 0);
    assert.match(h.notes[0].error, /cancelled/);
});

test('send later refuses at with draft, and without a running keeper', async () => {
    const conn = mail({ fetch: okToken, connect: draftsServer().connect });
    const at = new Date(Date.now() + 3600_000).toISOString();
    await assert.rejects(conn.run('mail.send', TARGET, { to: 'b@example.com', subject: 's', body: 'b', at }, ctx()), /needs the keeper/);
    await assert.rejects(conn.run('mail.send', TARGET, { to: 'b@example.com', subject: 's', body: 'b', at, draft: true }, ctx()), /not both/);
    assert.ok(!existsSync(join(tmpdir(), 'mail-later.json')));
});

test('send later (Microsoft): Exchange holds it -- the deferred-send property, nothing kept here', async () => {
    const calls = [];
    const fetch = async (url, o) => { calls.push({ path: url.replace('https://graph.microsoft.com/v1.0', ''), method: o.method, body: o.body ? JSON.parse(o.body) : undefined }); return { ok: true, status: 202, text: async () => '' }; };
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const r = await graphMail({ fetch, token: async () => 'T' }).send({ title: 'O', config: {} }, { to: 'b@example.com', subject: 's', body: 'b', at }, {});
    assert.deepEqual(calls[0].body.message.singleValueExtendedProperties, [{ id: 'SystemTime 0x3FEF', value: at }]);
    assert.match(r.text, /Scheduled for .* Outbox/);
});
