/* WHAT HAPPENS AFTER "SENT" (audit 05-11): a mail that comes back is told to the agent and the
 * person; a scheduled mail never leaves twice, nor fails in silence; a write is never doubled.
 * A scripted IMAP server keeps folders in memory, a scripted SMTP server takes the message;
 * nothing real is reached and every address is example.com. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mail, readBounce } from '../host/connectors/mail.mjs';

const BOX = { id: 'c1', title: 'Box', config: { host: 'imap.example.com', user: 'me@example.com', smtpHost: 'smtp.example.com' }, secrets: { password: 'pw' } };
const ctx = (agent = 'agent:a') => ({ agent, secret: async () => 'pw-secret' });

/* Folders in memory: { name: { flags, msgs: Map(uid -> raw) } }. `hooks.append(box)` may throw to cut the line. */
function imapBox({ hooks = {} } = {}) {
    const folders = { INBOX: { flags: '', msgs: new Map() }, Drafts: { flags: '\\Drafts', msgs: new Map() }, Sent: { flags: '\\Sent', msgs: new Map() } };
    let next = 100; const commands = []; const sockets = [];
    const put = (box, raw) => { folders[box].msgs.set(next, raw); return next++; };
    const connect = () => {
        const socket = new EventEmitter(); sockets.push(socket);
        socket.destroy = () => { socket.dead = true; };
        let current = 'INBOX'; let pending = null;
        const send = (t) => setImmediate(() => { if (!socket.dead) socket.emit('data', Buffer.from(t)); });
        socket.write = (data) => {
            if (socket.dead) return;
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
            if (pending) {
                const p = pending; pending = null;
                if (hooks.append?.(p.box) === 'cut') { socket.dead = true; setImmediate(() => socket.emit('close')); put(p.box, text.replace(/\r\n$/, '')); return; }
                put(p.box, text.replace(/\r\n$/, '')); return send(`${p.tag} OK done\r\n`);
            }
            const line = text.replace(/\r\n$/, ''); const sp = line.indexOf(' ');
            const tag = line.slice(0, sp); const cmd = line.slice(sp + 1);
            commands.push(cmd);
            if (hooks.cmd?.(cmd) === 'cut') { socket.dead = true; setImmediate(() => socket.emit('close')); return; }
            if (/^UID FETCH \d+ \(BODYSTRUCTURE/.test(cmd) && hooks.structure) return send(`* 1 FETCH (UID 1 BODYSTRUCTURE ${hooks.structure} BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {20}\r\nSubject: Devis\r\n\r\n\r\n)\r\n${tag} OK\r\n`);
            const ap = /^APPEND "([^"]*)"/.exec(cmd);
            if (ap) { pending = { tag, box: ap[1] }; return send('+ Ready\r\n'); }
            if (cmd.startsWith('LIST')) return send(`${Object.entries(folders).map(([n, f]) => `* LIST (${f.flags}) "/" "${n}"\r\n`).join('')}${tag} OK\r\n`);
            const sel = /^(SELECT|EXAMINE) "([^"]*)"/.exec(cmd);
            if (sel) { current = sel[2]; return send(`${tag} OK\r\n`); }
            const hm = /^UID SEARCH HEADER Message-ID "(.*)"$/.exec(cmd);
            if (hm) { const uids = [...folders[current].msgs].filter(([, m]) => m.includes(`Message-ID: ${hm[1]}`)).map(([u]) => u); return send(`* SEARCH${uids.map((u) => ` ${u}`).join('')}\r\n${tag} OK\r\n`); }
            const um = /^UID SEARCH UID (\d+)$/.exec(cmd);
            if (um) return send(`* SEARCH${folders[current].msgs.has(Number(um[1])) ? ` ${um[1]}` : ''}\r\n${tag} OK\r\n`);
            if (cmd.startsWith('UID SEARCH')) return send(`* SEARCH${[...folders[current].msgs.keys()].map((u) => ` ${u}`).join('')}\r\n${tag} OK\r\n`);
            const sz = /^UID FETCH (\d+) \(RFC822\.SIZE\)$/.exec(cmd);
            if (sz) { const m = folders[current].msgs.get(Number(sz[1])) ?? ''; return send(`* 1 FETCH (UID ${sz[1]} RFC822.SIZE ${Buffer.byteLength(m)})\r\n${tag} OK\r\n`); }
            const fm = /^UID FETCH (\d+) \(BODY\.PEEK\[\]/.exec(cmd);
            if (fm) { const m = folders[current].msgs.get(Number(fm[1])) ?? ''; return send(`* 1 FETCH (UID ${fm[1]} BODY[] {${Buffer.byteLength(m)}}\r\n${m})\r\n${tag} OK\r\n`); }
            const xm = /^UID EXPUNGE (\d+)$/.exec(cmd);
            if (xm) folders[current].msgs.delete(Number(xm[1]));
            return send(`${tag} OK\r\n`);
        };
        send('* OK ready\r\n');
        return socket;
    };
    return { connect, commands, folders, put, sockets };
}
function smtp({ rcpt = () => '250 ok' } = {}) {
    const messages = [];
    const make = (greet) => {
        const s = new EventEmitter(); s.destroy = () => {}; s.login = 0;
        const reply = (t) => setImmediate(() => s.emit('data', Buffer.from(t)));
        s.write = (text) => {
            if (/\r\n\.\r\n$/.test(text)) { messages.push(text); return reply('250 queued\r\n'); }
            const cmd = text.replace(/\r\n$/, '');
            if (cmd === 'AUTH LOGIN') { s.login = 1; return reply('334 go\r\n'); }
            if (s.login === 1) { s.login = 2; return reply('334 go\r\n'); }
            if (s.login === 2) { s.login = 0; return reply('235 ok\r\n'); }
            if (/^EHLO/.test(cmd)) return reply('250-hi\r\n250 AUTH LOGIN\r\n');
            if (cmd === 'STARTTLS') return reply('220 go\r\n');
            const r = /^RCPT TO:<(.*)>$/.exec(cmd);
            if (r) return reply(`${rcpt(r[1])}\r\n`);
            if (cmd === 'DATA') return reply('354 go\r\n');
            return reply('250 ok\r\n');
        };
        if (greet) reply('220 ready\r\n');
        return s;
    };
    return { messages, connect: () => make(true), secure: () => make(false) };
}
function hostOf(target, clock) {
    const notices = []; const notes = [];
    return { notices, notes, hand: { dir: mkdtempSync(join(tmpdir(), 'bounce-')), now: () => clock.t, target: (id) => (id === target.id ? target : null), ctx: (t, agent) => ctx(agent), stopped: () => false, note: (l) => notes.push(l), notice: (n) => notices.push(n) } };
}
/* A Postfix-style report for one recipient, carrying the original's headers. */
const dsn = (messageId, to, { status = '5.1.1', action = 'failed', diag = 'smtp; 550 5.1.1 <x> User unknown' } = {}) => [
    'From: MAILER-DAEMON@example.com (Mail Delivery System)', 'To: me@example.com', 'Subject: Undelivered Mail Returned to Sender', 'Date: Thu, 05 Nov 2026 10:00:00 +0000',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="R1"', '', '--R1', 'Content-Type: text/plain', '', 'I could not deliver your message.', '',
    '--R1', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example.com', '', `Final-Recipient: rfc822; ${to}`, `Original-Recipient: rfc822;${to}`, `Action: ${action}`, `Status: ${status}`,
    `Diagnostic-Code: ${diag.slice(0, 20)}`, ` ${diag.slice(20)}`, '', '--R1', 'Content-Type: text/rfc822-headers', '', 'From: me@example.com', `To: ${to}`, 'Subject: Devis', `Message-ID: ${messageId}`, '', '--R1--', ''].join('\r\n');

test('readBounce: a delivery report per recipient (folded diagnostic); an auto-reply is no bounce', () => {
    const b = readBounce(dsn('<m1@example.com>', 'bob@example.com'));
    assert.deepEqual(b.recipients, [{ to: 'bob@example.com', action: 'failed', status: '5.1.1', diag: '550 5.1.1 <x> User unknown' }]);
    assert.equal(readBounce('From: Bob <bob@example.com>\r\nAuto-Submitted: auto-replied\r\nSubject: Out of office\r\n\r\naway'), null);
    assert.equal(readBounce('From: Bob <bob@example.com>\r\nSubject: Lunch\r\n\r\nhi'), null);
    assert.ok(readBounce('From: postmaster@example.org\r\nSubject: Delivery Status Notification (Failure)\r\n\r\nfailed'), 'an older bounce, by its sender');
});

test('a mail sent from a classic box that comes back: the agent and the person are told, once; a delay keeps the watch longer', async () => {
    const clock = { t: Date.parse('2026-11-05T09:00:00Z') };
    const s = imapBox(); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    const r = await conn.run('mail.send', BOX, { to: 'bob@example.com, carol@example.com', subject: 'Devis', body: 'hello' }, ctx());
    const mid = /Message-ID (<[^>]+>)/.exec(r.text)?.[1];
    assert.ok(mid, 'the Message-ID is told'); assert.match(r.text, /accepted by the server/); assert.match(r.text, /watches for a return for 48 h/);
    assert.equal(conn.watched().length, 1);
    s.put('INBOX', dsn(mid, 'bob@example.com'));
    s.put('INBOX', 'From: Carol <carol@example.com>\r\nAuto-Submitted: auto-replied\r\nSubject: Re: Devis\r\n\r\naway');
    await conn.tick();
    assert.equal(h.notices.length, 0, 'not looked before 2 minutes');
    clock.t += 3 * 60_000; await conn.tick();
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].kind, 'mail.bounced'); assert.equal(h.notices[0].agent, 'agent:a'); assert.equal(h.notices[0].ref, mid);
    assert.match(h.notices[0].text, /"Devis" to bob@example\.com was NOT delivered: 5\.1\.1 550 5\.1\.1 <x> User unknown/);
    clock.t += 3 * 60_000; await conn.tick();
    assert.equal(h.notices.length, 1, 'told once');
    s.put('INBOX', dsn(mid, 'carol@example.com', { status: '4.4.1', action: 'delayed', diag: 'smtp; 451 4.4.1 try again later' }));
    clock.t += 3 * 60_000; await conn.tick();
    assert.equal(h.notices[1].kind, 'mail.delayed');
    assert.ok(conn.watched()[0].until > clock.t + 4 * 86_400_000, 'watched up to 5 days after a delay');
    clock.t += 6 * 86_400_000; await conn.tick();
    assert.equal(conn.watched().length, 0, 'and no longer after');
});

test('a mail Microsoft sent that comes back: found by its own mark in the returned headers', async () => {
    const clock = { t: Date.parse('2026-11-05T09:00:00Z') };
    const MS = { id: 'ms', title: 'Outlook', config: { provider: 'microsoft', user: 'me@example.com' }, secrets: { refresh: 'r' } };
    let ref = null;
    const fetch = async (url, o = {}) => {
        if (url.includes('oauth2') || url.includes('login.microsoftonline')) return new Response(JSON.stringify({ access_token: 'A', expires_in: 3600 }), { status: 200 });
        const path = url.replace('https://graph.microsoft.com/v1.0', '');
        if (path === '/me/sendMail') { ref = JSON.parse(o.body).message.internetMessageHeaders[0].value; return new Response(null, { status: 202 }); }
        if (path.startsWith('/me/mailFolders/inbox/messages')) return Response.json({ value: [{ id: 'N1', subject: 'Undeliverable: Devis', from: { emailAddress: { address: 'postmaster@example.org' } } }, { id: 'N2', subject: 'Lunch', from: { emailAddress: { address: 'bob@example.com' } } }] });
        if (path === '/me/messages/N1/$value') return new Response(dsn('<other@x>', 'bob@example.com').replace('Subject: Devis', `Subject: Devis\r\nX-Tether-Ref: ${ref}`));
        return new Response('{}', { status: 404 });
    };
    const conn = mail({ fetch });
    const h = hostOf(MS, clock); conn.wake(h.hand);
    const r = await conn.run('mail.send', MS, { to: 'bob@example.com', subject: 'Devis', body: 'b' }, { ...ctx(), secret: async () => 'REFRESH' });
    assert.match(r.text, /accepted by Microsoft\)\. Tether watches/);
    clock.t += 3 * 60_000; await conn.tick();
    assert.equal(h.notices.length, 1); assert.equal(h.notices[0].kind, 'mail.bounced');
    assert.match(h.notices[0].text, /bob@example\.com was NOT delivered/);
});

test('a scheduled mail refused for good fails at once, told; one sent late says so; never sent twice after a cut', async () => {
    const clock = { t: Date.now() };
    const s = imapBox(); const m = smtp({ rcpt: (to) => (to === 'nobody@example.com' ? '550 5.1.1 no such user' : '250 ok') });
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    await conn.run('mail.send', BOX, { to: 'nobody@example.com', subject: 'Rappel', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    clock.t += 180_000; await conn.tick();
    assert.equal(conn.later().length, 0, 'a 5xx is not tried 30 times');
    assert.equal(h.notices[0].kind, 'mail.later-failed');
    assert.match(h.notices[0].text, /"Rappel" to nobody@example\.com.*could NOT be sent: .*nobody@example\.com was refused \(550 5\.1\.1 no such user\).*still in Drafts/);
    /* late: the keeper was away an hour */
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Tard', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    clock.t += 3600_000; await conn.tick();
    assert.equal(m.messages.length, 1);
    assert.equal(h.notices.at(-1).kind, 'mail.later-late');
    assert.match(h.notices.at(-1).text, /"Tard" .* left late/);
    /* a cut after the send (a try begun, never marked sent): found in Sent, not sent again, draft removed */
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Once', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    const rec = conn.later()[0];
    const draft = [...s.folders.Drafts.msgs.values()].find((x) => x.includes(rec.id));
    s.put('Sent', draft);
    const file = join(h.hand.dir, 'mail-later.json');
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).map((x) => ({ ...x, trying: clock.t }))));
    conn.wake(h.hand);
    clock.t += 180_000; await conn.tick();
    assert.equal(m.messages.length, 1, 'not sent a second time');
    assert.equal(conn.later().length, 0);
    assert.ok(![...s.folders.Drafts.msgs.values()].some((x) => x.includes(rec.id)), 'its draft removed');
});

test('a write is never doubled: a dead warm connection is checked first; a cut in the middle of an APPEND is said, not retried; a Sent copy the server keeps is not doubled', async () => {
    let cut = false;
    const s = imapBox({ hooks: { append: () => (cut ? 'cut' : undefined) } });
    const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'a', body: 'x', draft: true }, ctx());
    const before = s.sockets.length;
    const warm = s.sockets.at(-1); warm.dead = true; warm.emit('close');   /* the warm connection died while idle */
    const r = await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'b', body: 'x', draft: true }, ctx());
    assert.match(r.text, /Draft saved/);
    assert.equal(s.folders.Drafts.msgs.size, 2, 'one draft each');
    assert.equal(s.sockets.length, before + 1, 'the dead connection was found by NOOP and opened again, once');
    cut = true;
    await assert.rejects(conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'c', body: 'x', draft: true }, ctx()));
    assert.equal(s.folders.Drafts.msgs.size, 3, 'kept once by the server, never appended again');
    cut = false;
    /* a server that files what it relays: the copy is already in Sent */
    const s2 = imapBox(); const m2 = smtp();
    const conn2 = mail({ connect: s2.connect, smtpConnect: (o) => { const sock = m2.connect(o); const w = sock.write; sock.write = (t) => { if (/\r\n\.\r\n$/.test(t)) s2.put('Sent', t.replace(/\r\n\.\r\n$/, '')); return w(t); }; return sock; }, smtpSecure: m2.secure });
    const r2 = await conn2.run('mail.send', BOX, { to: 'bob@example.com', subject: 'd', body: 'x' }, ctx());
    assert.match(r2.text, /A copy is in Sent/);
    assert.equal(s2.folders.Sent.msgs.size, 1, 'not doubled');
});

test('a scheduled mail the server took but never confirmed is not sent again, and is told as maybe sent (loop 2)', async () => {
    const clock = { t: Date.now() };
    const s = imapBox(); const m = smtp();
    const silent = (o) => { const sock = m.secure(o); const w = sock.write; sock.write = (t) => (/\r\n\.\r\n$/.test(t) ? undefined : w(t)); return sock; };
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: silent, smtpWait: { dataMs: 50 } });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Peut-être', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    clock.t += 180_000;
    await conn.tick();
    assert.equal(conn.later().length, 0, 'not tried again');
    assert.equal(h.notices[0]?.kind, 'mail.later-unsure');
    assert.match(h.notices[0].text, /MAY have been sent/);
});

test('a returned reply sent by Microsoft is tied by its subject even when accented (encoded in the returned headers) (loop 3)', async () => {
    const clock = { t: Date.parse('2026-11-05T09:00:00Z') };
    const MS = { id: 'ms', title: 'Outlook', config: { provider: 'microsoft', user: 'me@example.com' }, secrets: { refresh: 'r' } };
    const fetch = async (url, o = {}) => {
        if (url.includes('login.microsoftonline')) return new Response(JSON.stringify({ access_token: 'A', expires_in: 3600 }), { status: 200 });
        const path = url.replace('https://graph.microsoft.com/v1.0', '');
        if (path === '/me/messages/AAA/createReply') return Response.json({ id: 'R1', subject: 'RE: Réunion été', toRecipients: [{ emailAddress: { address: 'bob@example.com' } }], body: { content: '' } });
        if (path === '/me/messages/R1' || path === '/me/messages/R1/send') return new Response(null, { status: 202 });
        if (path.startsWith('/me/mailFolders/inbox/messages')) return Response.json({ value: [{ id: 'N1', subject: 'Undeliverable: RE: Réunion été', from: { emailAddress: { address: 'postmaster@example.org' } } }] });
        if (path === '/me/messages/N1/$value') return new Response(dsn('<other@x>', 'bob@example.com').replace('Subject: Devis', 'Subject: =?UTF-8?B?UkU6IFLDqXVuaW9uIMOpdMOp?='));
        return new Response('{}', { status: 404 });
    };
    const conn = mail({ fetch });
    const h = hostOf(MS, clock); conn.wake(h.hand);
    await conn.run('mail.reply', MS, { uid: 'AAA', body: 'ok' }, { ...ctx(), secret: async () => 'REFRESH' });
    clock.t += 3 * 60_000; await conn.tick();
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0].text, /"RE: Réunion été" to bob@example\.com was NOT delivered/);
});

test('a scheduled mail says, on both kinds of box, that it is watched once it leaves (loop 4)', async () => {
    const s = imapBox(); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    conn.wake(hostOf(BOX, { t: Date.now() }).hand);
    const r = await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 's', body: 'b', at: new Date(Date.now() + 3600_000).toISOString() }, ctx());
    assert.match(r.text, /Once it leaves, Tether watches for a return for 48 h/);
    const MS = { id: 'ms', title: 'Outlook', config: { provider: 'microsoft', user: 'me@example.com' }, secrets: { refresh: 'r' } };
    const fetch = async (url) => (url.includes('login.microsoftonline') ? new Response(JSON.stringify({ access_token: 'A', expires_in: 3600 }), { status: 200 }) : new Response(null, { status: 202 }));
    const g = mail({ fetch }); g.wake(hostOf(MS, { t: Date.now() }).hand);
    const r2 = await g.run('mail.send', MS, { to: 'bob@example.com', subject: 's', body: 'b', at: new Date(Date.now() + 3600_000).toISOString() }, { ...ctx(), secret: async () => 'R' });
    assert.match(r2.text, /Outbox .*Once it leaves, Tether watches for a return for 48 h/);
});

test('loop 5: an IMAP draft keeps its Bcc (never in a sent message); an unknown uid is refused, never "done"', async () => {
    const s = imapBox(); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    await conn.run('mail.send', BOX, { to: 'bob@example.com', bcc: 'hidden@example.com', subject: 'd', body: 'x', draft: true }, ctx());
    assert.match([...s.folders.Drafts.msgs.values()][0], /^Bcc: hidden@example\.com$/m);
    await conn.run('mail.send', BOX, { to: 'bob@example.com', bcc: 'hidden@example.com', subject: 'e', body: 'x' }, ctx());
    assert.doesNotMatch(m.messages[0], /hidden@example\.com/, 'a sent message carries no Bcc');
    const t = imapBox();
    t.put('INBOX', 'Subject: a\r\n\r\nx');
    const c2 = mail({ connect: t.connect });
    for (const [verb, a] of [['mail.delete', { uid: '999' }], ['mail.move', { uid: '999', mailbox: 'Sent' }], ['mail.flag', { uid: '999', flag: 'read' }]]) {
        await assert.rejects(c2.run(verb, BOX, a, ctx()), /no message #999 in INBOX/, verb);
    }
});

test('loop 5: an attachment with no bytes is refused, never dropped in silence', async () => {
    const { check } = await import('../server/verbs.mjs');
    assert.throws(() => check('mail.send', { target: 'm', to: 'a@example.com', subject: 's', body: 'b', attachments: [{ name: 'a.pdf', bytes: 'QUJD' }, { name: 'b.pdf', bytes: '' }] }), /b\.pdf: no bytes -- nothing was done/);
});

test('loop 10: a classic box whose scheduled try was cut and is not in Sent is told "maybe sent", never sent again', async () => {
    const clock = { t: Date.now() };
    const s = imapBox(); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Coupé', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    const { writeFileSync, readFileSync } = await import('node:fs');
    const file = join(h.hand.dir, 'mail-later.json');
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).map((x) => ({ ...x, trying: clock.t }))));
    conn.wake(h.hand);
    clock.t += 180_000; await conn.tick();
    assert.equal(m.messages.length, 0, 'not sent again');
    assert.equal(h.notices[0].kind, 'mail.later-unsure');
});

test('loop 11: a classic server away for a while delays a scheduled mail, never cancels it as "maybe sent"', async () => {
    const clock = { t: Date.now() };
    const s = imapBox(); const m = smtp();
    let down = true;
    const conn = mail({ connect: s.connect, smtpConnect: (o) => { if (down) { const e = new EventEmitter(); e.write = () => {}; e.destroy = () => {}; setImmediate(() => e.emit('error', new Error('refused'))); return e; } return m.connect(o); }, smtpSecure: m.secure });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Plus tard', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    clock.t += 180_000; await conn.tick();
    clock.t += 60_000; await conn.tick();
    assert.equal(conn.later().length, 1, 'still waiting');
    assert.equal(h.notices.length, 0);
    down = false;
    clock.t += 60_000; await conn.tick();
    assert.equal(m.messages.length, 1, 'sent once the server is back');
});

test('loop 13: an IMAP write cut in the middle says it may have been done; a scheduled draft shows its Bcc', async () => {
    const s = imapBox({ hooks: { append: () => 'cut' } });
    const conn = mail({ connect: s.connect });
    await assert.rejects(conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'c', body: 'x', draft: true }, ctx()), /it may have been done: check before asking again/);
    const s2 = imapBox(); const conn2 = mail({ connect: s2.connect });
    conn2.wake(hostOf(BOX, { t: Date.now() }).hand);
    await conn2.run('mail.send', BOX, { to: 'bob@example.com', bcc: 'hidden@example.com', subject: 'l', body: 'x', at: new Date(Date.now() + 3600_000).toISOString() }, ctx());
    assert.match([...s2.folders.Drafts.msgs.values()][0], /^Bcc: hidden@example\.com$/m);
});

test('loop 18: a keeper store that cannot be written never turns a done act into "not done"', async () => {
    const { mkdirSync } = await import('node:fs');
    const s = imapBox(); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = hostOf(BOX, { t: Date.now() });
    mkdirSync(join(h.hand.dir, 'mail-sent.json.tmp'));   /* the watch file cannot be written */
    mkdirSync(join(h.hand.dir, 'mail-later.json.tmp'));
    conn.wake(h.hand);
    const r = await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 's', body: 'b' }, ctx());
    assert.match(r.text, /^Sent to bob@example\.com.*its watch list could not be saved/);
    const e = await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'l', body: 'b', at: new Date(Date.now() + 3600_000).toISOString() }, ctx()).catch((x) => x);
    assert.match(e.message, /waits in Drafts, but could not be scheduled .* it will NOT leave by itself/);
    assert.equal(conn.later().length, 0);
});

test('loop 20: a scheduled mail whose APPEND line is lost says it is NOT scheduled; an empty single file is refused', async () => {
    const s = imapBox({ hooks: { append: () => 'cut' } });
    const conn = mail({ connect: s.connect }); conn.wake(hostOf(BOX, { t: Date.now() }).hand);
    await assert.rejects(conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'l', body: 'x', at: new Date(Date.now() + 3600_000).toISOString() }, ctx()), /it is NOT scheduled and will not leave by itself/);
    assert.equal(conn.later().length, 0);
    const { check } = await import('../server/verbs.mjs');
    assert.throws(() => check('mail.send', { target: 'm', to: 'a@example.com', subject: 's', body: 'b', attach: '', attachName: 'plan.pdf' }), /plan\.pdf: no bytes -- nothing was done/);
});

test('loop 20: that answer is headed Uncertain', async () => {
    const { failed } = await import('../server/mcp.mjs');
    assert.match(failed('Box: the line was lost while keeping it in Drafts -- it may have been kept there, but it is NOT scheduled and will not leave by itself'), /^Uncertain/);
});

test('loop 26: a reply to a message with a large file is not refused; a scheduled mail whose box is gone is told', async () => {
    const big = `From: Bob <bob@example.com>\r\nTo: me@example.com\r\nSubject: Gros\r\nMessage-ID: <big@example.com>\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nvoici\r\n--B\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${'QUJD'.repeat(200_000)}\r\n--B--\r\n`;
    const s = imapBox(); const uid = s.put('INBOX', big); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const r = await conn.run('mail.reply', BOX, { uid: String(uid), body: 'merci' }, ctx());
    assert.match(r.text, /^Sent to bob@example\.com/);
    const clock = { t: Date.now() }; const h = hostOf(BOX, clock);
    const c2 = mail({ connect: imapBox().connect }); c2.wake(h.hand);
    await c2.run('mail.send', BOX, { to: 'bob@example.com', subject: 'x', body: 'y', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    h.hand.target = () => null; c2.wake(h.hand);
    clock.t += 180_000; await c2.tick();
    assert.equal(h.notices[0]?.kind, 'mail.later-failed');
    assert.match(h.notices[0].text, /its mailbox is gone/);
});

test('loop 28: a wrong uid makes no Trash folder; a forward card names the files on IMAP too', async () => {
    const s = imapBox();
    delete s.folders.Trash;
    await assert.rejects(mail({ connect: s.connect }).run('mail.delete', BOX, { uid: '999' }, ctx()), /no message #999/);
    assert.ok(!s.commands.some((c) => c.startsWith('CREATE')), 'nothing made');
});

test('loop 28: an IMAP mark whose line is lost says it may have been done; the forward card lists the files', async () => {
    const s = imapBox({ hooks: { cmd: (c) => (c.startsWith('UID STORE') ? 'cut' : undefined) } });
    s.put('INBOX', 'Subject: a\r\n\r\nx');
    await assert.rejects(mail({ connect: s.connect }).run('mail.flag', BOX, { uid: '100', flag: 'read' }, ctx()), /it may have been done/);
    const t = imapBox({ hooks: { structure: '(("text" "plain" NIL NIL NIL "7bit" 5 1)("application" "pdf" ("name" "devis.pdf") NIL NIL "base64" 400 NIL ("attachment" ("filename" "devis.pdf"))) "mixed")' } });
    const about = await mail({ connect: t.connect }).describe('mail.forward', BOX, { uid: '1', to: 'x@example.com' }, ctx());
    assert.deepEqual(about.files, [{ name: 'devis.pdf' }]);
    const u = imapBox({ hooks: { structure: '(("text" "plain" NIL NIL NIL "7bit" 5 1)("application" "octet-stream" NIL NIL NIL "base64" 400 NIL ("attachment" NIL)) "mixed")' } });
    assert.deepEqual((await mail({ connect: u.connect }).describe('mail.forward', BOX, { uid: '1', to: 'x@example.com' }, ctx())).files, [{ name: '1 more file (name not readable here)' }]);
    const v = imapBox({ hooks: { structure: '(("text" "plain" NIL NIL NIL "7bit" 5 1)("image" "png" ("name" "logo.png") NIL NIL "base64" 400 NIL ("inline" ("filename" "logo.png")))("application" "octet-stream" NIL NIL NIL "base64" 400 NIL ("attachment" NIL)) "mixed")' } });
    assert.deepEqual((await mail({ connect: v.connect }).describe('mail.forward', BOX, { uid: '1', to: 'x@example.com' }, ctx())).files, [{ name: 'logo.png' }, { name: '1 more file (name not readable here)' }]);
});

test('loop 31: a file whose name and filename both come as literals counts once', async () => {
    const w = imapBox({ hooks: { structure: '(("text" "plain" NIL NIL NIL "7bit" 5 1)("application" "pdf" ("name" {9}\r\nété.pdf) NIL NIL "base64" 400 NIL ("attachment" ("filename" {9}\r\nété.pdf))) "mixed")' } });
    assert.deepEqual((await mail({ connect: w.connect }).describe('mail.forward', BOX, { uid: '1', to: 'x@example.com' }, ctx())).files, [{ name: '1 more file (name not readable here)' }]);
});

test('loop 34: the reply card shows who it goes to (Reply-To first, all: To and Cc), on IMAP and Microsoft', async () => {
    const s = imapBox();
    const raw = 'From: Bob <bob@example.com>\r\nReply-To: desk@example.com\r\nTo: me@example.com, carol@example.com\r\nCc: dan@example.com\r\nSubject: s\r\n\r\n';
    const conn = mail({ connect: (o) => { const sock = s.connect(o); const w = sock.write; sock.write = (d) => { const line = String(d); if (/BODYSTRUCTURE/.test(line)) { const tag = line.split(' ')[0]; setImmediate(() => sock.emit('data', Buffer.from(`* 1 FETCH (UID 1 BODYSTRUCTURE ("text" "plain" NIL NIL NIL "7bit" 5 1) BODY[HEADER.FIELDS (FROM REPLY-TO TO CC SUBJECT DATE)] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK\r\n`))); return; } return w(d); }; return sock; } });
    const about = await conn.describe('mail.reply', BOX, { uid: '1', body: 'ok', all: true }, ctx());
    assert.deepEqual(about.replyTo, { to: ['desk@example.com'], cc: ['carol@example.com', 'dan@example.com'] });
    const { graphMail } = await import('../host/connectors/graphmail.mjs');
    const fetch = async () => new Response(JSON.stringify({ from: { emailAddress: { address: 'bob@example.com' } }, replyTo: [{ emailAddress: { address: 'desk@example.com' } }], toRecipients: [{ emailAddress: { address: 'me@example.com' } }], subject: 's' }), { status: 200 });
    const g = await graphMail({ fetch, token: async () => 'T' }).about({ title: 'O', config: { user: 'me@example.com' } }, { uid: 'M', body: 'ok' }, {}, 'mail.reply');
    assert.deepEqual(g.replyTo, { to: ['desk@example.com'], cc: [] });
    const { cardOf } = await import('../server/cards.mjs');
    assert.deepEqual(cardOf('contacts.update', { id: 'c', phone: '', type: 'work' }).cleared, ['phone (work)']);
});

test('loop 36: a delete from the Trash is "for good" on the card before; emptied title and name show on the card', async () => {
    const s = imapBox();
    s.folders.Trash = { flags: '\\Trash', msgs: new Map() };
    const conn = mail({ connect: s.connect });
    assert.equal((await conn.describe('mail.delete', BOX, { uid: '1', mailbox: 'Trash' }, ctx())).forGood, true);
    assert.equal((await conn.describe('mail.delete', BOX, { uid: '1' }, ctx())).forGood, undefined);
    assert.ok(!s.commands.some((c) => c.startsWith('CREATE')));
    const { graphMail } = await import('../host/connectors/graphmail.mjs');
    const fetch = async (url) => new Response(JSON.stringify(url.includes('deleteditems') ? { id: 'BIN' } : { parentFolderId: 'BIN', subject: 's' }), { status: 200 });
    assert.equal((await graphMail({ fetch, token: async () => 'T' }).about({ title: 'O', config: {} }, { uid: 'M' }, {}, 'mail.delete')).forGood, true);
    const { cardOf } = await import('../server/cards.mjs');
    assert.deepEqual(cardOf('calendar.update', { id: 'e', title: '' }, {}).cleared, ['title']);
    assert.deepEqual(cardOf('contacts.update', { id: 'c', name: '' }).cleared, ['name']);
});

test('loop 38: a scheduled mail sent whose draft cannot be removed is told, so it is not sent again', async () => {
    const clock = { t: Date.now() };
    const s = imapBox({ hooks: { cmd: (c) => (c.startsWith('UID STORE') ? 'cut' : undefined) } }); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Parti', body: 'x', at: new Date(clock.t + 120_000).toISOString() }, ctx());
    clock.t += 180_000; await conn.tick();
    assert.equal(m.messages.length, 1);
    assert.ok(h.notices.some((n) => n.kind === 'mail.later-draft-kept' && /do not send it again/.test(n.text)));
});

test('loop 43: a scheduled mail on a box with no SMTP server is refused at once, never "Scheduled"', async () => {
    const s = imapBox(); const conn = mail({ connect: s.connect }); conn.wake(hostOf(BOX, { t: Date.now() }).hand);
    const box = { ...BOX, config: { host: 'imap.example.com', user: 'me@example.com' } };
    await assert.rejects(conn.run('mail.send', box, { to: 'b@example.com', subject: 's', body: 'b', at: new Date(Date.now() + 3600_000).toISOString() }, ctx()), /set its SMTP server/);
    assert.equal(s.folders.Drafts.msgs.size, 0);
});

test('loop 49: an older bounce of a mail with the same subject is never told against a new one', async () => {
    const clock = { t: Date.parse('2026-11-05T09:00:00Z') };
    const s = imapBox(); const m = smtp();
    const conn = mail({ connect: s.connect, smtpConnect: m.connect, smtpSecure: m.secure });
    const h = hostOf(BOX, clock); conn.wake(h.hand);
    s.put('INBOX', dsn('<old@example.com>', 'bob@example.com').replace('Date: Thu, 05 Nov 2026 10:00:00 +0000', 'Date: Thu, 05 Nov 2026 07:00:00 +0000'));
    await conn.run('mail.send', BOX, { to: 'bob@example.com', subject: 'Devis', body: 'x' }, ctx());
    clock.t += 3 * 60_000; await conn.tick();
    assert.equal(h.notices.length, 0, 'the old report is another mail\'s');
    const { failed } = await import('../server/mcp.mjs');
    assert.match(failed('Outlook: Microsoft did not answer in time -- nothing was sent'), /^Not done/);
});
