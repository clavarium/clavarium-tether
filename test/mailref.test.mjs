/* A MAIL BY ITS REFERENCE (mail:TARGET/MESSAGE-ID): given by mail.list, mail.search and mail.read,
 * opened again by mail.open wherever the mail is now -- where it was seen (the hint, checked), moved
 * to another folder (searched by Message-ID), or gone (said so). A person's read from a page
 * (keeper.read) gets the bytes whole and is journaled as theirs, never asked. A scripted IMAP server
 * with folders, and a scripted Graph; nothing is a real box. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mail } from '../host/connectors/mail.mjs';
import { graphMail } from '../host/connectors/graphmail.mjs';
import { keeper } from '../host/keeper.mjs';
import { check, detail, mailRef, readMailRef, VERBS, reads } from '../server/verbs.mjs';
import { TOOLS, asked } from '../server/mcp.mjs';

const msg = (id, subject, body = 'Hello.\r\n') => `Message-ID: <${id}>\r\nFrom: Ann <ann@example.com>\r\nSubject: ${subject}\r\nDate: Wed, 04 Nov 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;

/* An IMAP server with folders over a fake socket. Messages are bytes (latin1 strings: one char, one byte). */
function imapBox(folders) {
    const commands = [];
    const connect = () => {
        let open = null;
        const socket = new EventEmitter(); socket.destroy = () => {};
        const send = (text) => setImmediate(() => socket.emit('data', Buffer.from(text, 'latin1')));
        socket.write = (text) => {
            const line = String(text).replace(/\r\n$/, ''); const sp = line.indexOf(' '); const tag = line.slice(0, sp); const cmd = line.slice(sp + 1);
            commands.push(cmd);
            const box = folders.find((f) => f.name === open);
            if (/^(LOGIN|AUTHENTICATE)/.test(cmd) || cmd === 'NOOP') return send(`${tag} OK\r\n`);
            if (cmd.startsWith('LIST')) return send(`${folders.map((f) => `* LIST (${f.flags ?? ''}) "/" "${f.name}"\r\n`).join('')}${tag} OK\r\n`);
            if (cmd.startsWith('EXAMINE')) {
                const name = /^EXAMINE "(.*)"$/.exec(cmd)?.[1];
                if (!folders.some((f) => f.name === name)) return send(`${tag} NO no such folder\r\n`);
                open = name; return send(`${tag} OK [READ-ONLY]\r\n`);
            }
            if (cmd.startsWith('UID SEARCH HEADER Message-ID')) {
                const id = /"(.*)"$/.exec(cmd)[1];
                return send(`* SEARCH ${(box?.msgs ?? []).filter((m) => m.raw.includes(`Message-ID: ${id}`)).map((m) => m.uid).join(' ')}\r\n${tag} OK\r\n`);
            }
            if (cmd.startsWith('UID SEARCH')) return send(`* SEARCH ${(box?.msgs ?? []).map((m) => m.uid).join(' ')}\r\n${tag} OK\r\n`);
            if (cmd.startsWith('UID FETCH')) {
                const set = cmd.split(' ')[2].split(',').map(Number);
                const picked = (box?.msgs ?? []).filter((m) => set.includes(m.uid));
                let out = '';
                picked.forEach((m, i) => {
                    const head = m.raw.slice(0, m.raw.indexOf('\r\n\r\n') + 4);
                    if (cmd.includes('HEADER.FIELDS')) {
                        const want = /HEADER\.FIELDS \(([^)]*)\)/.exec(cmd)[1].split(' ').map((x) => x.toLowerCase());
                        const block = `${head.split('\r\n').filter((l) => want.includes(l.split(':')[0].toLowerCase())).join('\r\n')}\r\n\r\n`;
                        out += `* ${i + 1} FETCH (UID ${m.uid} INTERNALDATE "04-Nov-2026 09:00:00 +0000" BODY[HEADER.FIELDS (${want.join(' ').toUpperCase()})] {${block.length}}\r\n${block})\r\n`;
                    } else {
                        const max = Number(/<0\.(\d+)>/.exec(cmd)?.[1] ?? Infinity);
                        const raw = m.raw.slice(0, max);
                        out += `* ${i + 1} FETCH (UID ${m.uid} BODY[]<0> {${raw.length}}\r\n${raw})\r\n`;
                    }
                });
                return send(`${out}${tag} OK\r\n`);
            }
            return send(`${tag} OK\r\n`);
        };
        setImmediate(() => socket.emit('data', Buffer.from('* OK ready\r\n')));
        return socket;
    };
    return { connect, commands };
}

const BOX = { id: 'work-box', title: 'Work box', kind: 'mail', connector: 'mail', config: { user: 'me@example.org', host: 'imap.example.org' }, secrets: { password: 'box-pass' } };
const ctx = (extra = {}) => ({ secret: async (k) => (k === 'password' ? 'pw-not-real' : undefined), ...extra });
const BOT = { id: 'agent:mail', kind: 'agent', name: 'Assistant · mail' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };

test('a mail reference: made from a target and a Message-ID, read back; hints kept; anything else is not one', () => {
    const ref = mailRef('work-box', '<CAF12+x@example.com>', { folder: 'Archives/2026', uid: 42 });
    assert.equal(ref, 'mail:work-box/CAF12%2Bx%40example.com?in=Archives%2F2026&uid=42');
    assert.deepEqual(readMailRef(ref), { target: 'work-box', messageId: '<CAF12+x@example.com>', folder: 'Archives/2026', uid: '42' });
    assert.deepEqual(readMailRef('mail:work-box/abc%40example.org'), { target: 'work-box', messageId: '<abc@example.org>' });
    for (const bad of ['', '42', 'mail:', 'mail:work-box', 'mail:work-box/', 'mail:a b/x', 'file:/x.eml', 'mail:t/%3Cx%0Ay%3E']) assert.equal(readMailRef(bad), null, bad);
    assert.equal(mailRef('work-box', ''), '', 'no Message-ID, no reference');
    /* mail.open: a read, its target taken from the reference; another target given is refused. */
    assert.equal(VERBS['mail.open'].reads, true); assert.ok(reads('mail.open'));
    assert.deepEqual(check('mail.open', { ref }), { target: 'work-box', ref });
    assert.throws(() => check('mail.open', { ref, target: 'other' }), /reference is of the target work-box/);
    assert.throws(() => check('mail.open', { ref: '42' }), /mail reference/);
    assert.equal(detail('mail.open', { ref }), '<CAF12+x@example.com>');
    assert.ok(TOOLS.some((t) => t.name === 'mail-open'));
    assert.deepEqual(asked('mail-open', { ref }), ['mail.open', { ref }]);
});

test('mail.list, mail.search and mail.read give each mail its reference, with where it was seen', async () => {
    const s = imapBox([{ name: 'INBOX', msgs: [{ uid: 7, raw: msg('one@example.com', 'Quote') }] }]);
    const m = mail({ connect: s.connect });
    const list = await m.run('mail.list', BOX, {}, ctx());
    assert.match(list.text, /#7 .*\n {2}From: Ann <ann@example\.com>\n {2}Subject: Quote\n {2}ref: mail:work-box\/one%40example\.com\?in=INBOX&uid=7/);
    const found = await m.run('mail.search', BOX, { text: 'Quote' }, ctx());
    assert.match(found.text, /ref: mail:work-box\/one%40example\.com\?in=INBOX&uid=7/);
    const read = await m.run('mail.read', BOX, { uid: '7' }, ctx());
    assert.match(read.text, /^ref: mail:work-box\/one%40example\.com\?in=INBOX&uid=7\nFrom: Ann/);
});

test('mail.open: where it was seen first (checked), then searched by Message-ID when moved; gone is said', async () => {
    const folders = [
        { name: 'INBOX', msgs: [{ uid: 7, raw: msg('other@example.com', 'Not this one') }] },
        { name: 'Archives', msgs: [{ uid: 3, raw: msg('one@example.com', 'Quote') }] },
    ];
    /* Seen in Archives as #3: opened there, nothing listed or searched. */
    let s = imapBox(folders);
    let r = await mail({ connect: s.connect }).run('mail.open', BOX, { ref: mailRef('work-box', '<one@example.com>', { folder: 'Archives', uid: 3 }) }, ctx());
    assert.match(r.text, /^Message-ID: <one@example\.com>\r\n/);
    assert.match(r.text, /Found in Archives; ref: mail:work-box\/one%40example\.com\?in=Archives&uid=3/);
    assert.ok(!s.commands.some((c) => c.startsWith('LIST')), 'the hint was enough');
    assert.ok(!s.commands.some((c) => /STORE|APPEND|MOVE|EXPUNGE|SELECT/.test(c)), 'read only');
    /* Seen in INBOX as #7, moved since: #7 there is another mail now -- never shown; found in Archives. */
    s = imapBox(folders);
    r = await mail({ connect: s.connect }).run('mail.open', BOX, { ref: mailRef('work-box', '<one@example.com>', { folder: 'INBOX', uid: 7 }) }, ctx());
    assert.match(r.text, /Subject: Quote/); assert.doesNotMatch(r.text, /Not this one/);
    assert.match(r.text, /Found in Archives/);
    /* No hint at all: searched. */
    s = imapBox(folders);
    r = await mail({ connect: s.connect }).run('mail.open', BOX, { ref: 'mail:work-box/one%40example.com' }, ctx());
    assert.match(r.text, /Subject: Quote/);
    /* Deleted: said gone, with a code a page can tell. */
    s = imapBox([{ name: 'INBOX', msgs: [] }]);
    await assert.rejects(() => mail({ connect: s.connect }).run('mail.open', BOX, { ref: 'mail:work-box/one%40example.com' }, ctx()), (e) => e.code === 'gone' && /no longer in the mailbox/.test(e.message));
});

test('mail.open looks in the folder that holds every mail first (Gmail\'s All Mail), and skips a folder that cannot be opened', async () => {
    const s = imapBox([
        { name: 'INBOX', msgs: [] },
        { name: '[Gmail]', flags: '\\HasChildren \\Noselect', msgs: [] },
        { name: 'Projects', msgs: [] },
        { name: '[Gmail]/All Mail', flags: '\\HasNoChildren \\All', msgs: [{ uid: 900, raw: msg('one@example.com', 'Quote') }] },
    ]);
    const r = await mail({ connect: s.connect }).run('mail.open', BOX, { ref: 'mail:work-box/one%40example.com' }, ctx());
    assert.match(r.text, /Found in \[Gmail\]\/All Mail/);
    const opened = s.commands.filter((c) => c.startsWith('EXAMINE'));
    assert.equal(opened[0], 'EXAMINE "[Gmail]/All Mail"', 'All Mail first');
    assert.ok(!opened.includes('EXAMINE "[Gmail]"'), 'a \\Noselect folder is not opened');
    assert.equal(opened.length, 1, 'found there: no other folder opened');
});

test('mail.open for an agent is capped as mail.source is, and says it was cut', async () => {
    const big = msg('big@example.com', 'Big', `${'x'.repeat(4 * 1024 * 1024 + 10)}\r\n`);
    const s = imapBox([{ name: 'INBOX', msgs: [{ uid: 1, raw: big }] }]);
    const r = await mail({ connect: s.connect }).run('mail.open', BOX, { ref: 'mail:work-box/big%40example.com' }, ctx());
    assert.match(r.text, /Large message — first 4096 KB of the source/);
});

test('a person\'s read (keeper.read): the bytes whole (8-bit too), never asked, journaled as the person\'s; an agent reads it at watch', async () => {
    const raw = msg('one@example.com', 'Caf\xe9', 'Le caf\xe9 est pr\xeat.\r\n');
    const s = imapBox([{ name: 'INBOX', msgs: [{ uid: 7, raw }] }]);
    const asked = [];
    const dir = mkdtempSync(join(tmpdir(), 'tether-'));
    const k = keeper(dir, { connectors: { mail: mail({ connect: s.connect }) }, secrets: async () => 'pw-not-real', ask: (r) => { asked.push(r); } });
    k.store.putTarget(BOX);
    const ref = 'mail:work-box/one%40example.com';
    const got = await k.read('mail.open', { ref }, ME);
    assert.equal(got.ok, true, got.text);
    assert.ok(Buffer.isBuffer(got.data.raw));
    assert.equal(got.data.raw.toString('latin1'), raw, 'byte for byte: an 8-bit é stays one byte');
    assert.equal(got.data.folder, 'INBOX'); assert.equal(got.data.ref, `${ref}?in=INBOX&uid=7`); assert.equal(got.data.cut, false);
    assert.equal(asked.length, 0, 'a person is never asked about their own read');
    const line = k.journal({ limit: 5 }).find((l) => l.op === 'read');
    assert.equal(line.by.id, ME.id); assert.equal(line.verb, 'mail.open'); assert.equal(line.ok, true); assert.equal(line.agent, undefined, 'not an agent\'s');
    assert.ok(!readFileSync(join(dir, 'journal.jsonl'), 'utf8').includes('caf'), 'the mail itself is never journaled');
    /* Only reads: an act is never a person's read here. */
    assert.equal((await k.read('mail.delete', { target: 'work-box', uid: '7' }, ME)).ok, false);
    /* Gone: its code. */
    const gone = await k.read('mail.open', { ref: 'mail:work-box/none%40example.com' }, ME);
    assert.equal(gone.ok, false); assert.equal(gone.code, 'gone');
    /* An agent: only on a target it was given; at watch, a read goes without asking. */
    assert.equal((await k.act('mail.open', { ref }, BOT)).ok, false);
    k.store.grant('work-box', BOT.id, 'watch');
    const r = await k.act('mail.open', { ref }, BOT);
    assert.equal(r.ok, true, r.text); assert.match(r.text, /Subject: Caf/); assert.equal(asked.length, 0);
    await k.close();
});

test('Microsoft (Graph): refs on list and read; mail.open by the id hint, else by internetMessageId in any folder; gone said', async () => {
    const ID = 'AAMkAGI2THEMESSAGEIDOFGRAPH';
    const MOVED = 'AAMkAGI2THEMOVEDMESSAGEIDXX';
    const calls = [];
    let where = ID;
    const fetch = async (url) => {
        const path = decodeURIComponent(url.replace('https://graph.microsoft.com/v1.0', ''));
        calls.push(path);
        const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
        if (path.startsWith('/me/mailFolders/inbox/messages')) return json({ value: [{ id: ID, receivedDateTime: '2026-11-04T09:00:00Z', from: { emailAddress: { address: 'ann@example.com' } }, subject: 'Quote', internetMessageId: '<one@example.com>' }] });
        if (path.startsWith('/me/messages?$filter=')) return json({ value: path.includes("'<one@example.com>'") ? [{ id: where, internetMessageId: '<one@example.com>', parentFolderId: 'FOLDER-A' }] : [] });
        if (path.startsWith(`/me/messages/${where}/$value`)) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(msg('one@example.com', 'Quote')).buffer };
        if (path.startsWith(`/me/messages/${where}`)) return json({ id: where, internetMessageId: '<one@example.com>', parentFolderId: 'FOLDER-A', subject: 'Quote', body: { contentType: 'text', content: 'Hello' } });
        if (path.startsWith('/me/messages/')) return json({ error: { message: 'The specified object was not found in the store.' } }, 404);
        if (path.startsWith('/me/mailFolders/FOLDER-A')) return json({ displayName: 'Archive' });
        return json({ error: { message: 'not found' } }, 404);
    };
    const target = { id: 'ms-box', title: 'Microsoft box', config: { provider: 'microsoft', user: 'me@example.org' } };
    const g = graphMail({ fetch, token: async () => 'ACCESS' });
    assert.match((await g.list(target, {}, {})).text, new RegExp(`ref: mail:ms-box/one%40example\\.com\\?uid=${ID}`));
    assert.match((await g.read(target, { uid: ID }, {})).text, /^ref: mail:ms-box\/one%40example\.com/);
    let r = await g.open(target, readMailRef(`mail:ms-box/one%40example.com?uid=${ID}`), {});
    assert.match(r.text, /Subject: Quote/); assert.match(r.text, /Found in Archive/);
    assert.ok(!calls.some((c) => c.includes('$filter=')), 'the hint was enough');
    /* Moved: Graph gave it a new id; the old one is not found -- searched by its Message-ID. */
    where = MOVED;
    r = await g.open(target, readMailRef(`mail:ms-box/one%40example.com?uid=${ID}`), { person: ME });
    assert.equal(r.raw.toString('utf8'), msg('one@example.com', 'Quote')); assert.equal(r.folder, 'Archive');
    assert.equal(r.ref, `mail:ms-box/one%40example.com?uid=${MOVED}`);
    await assert.rejects(() => g.open(target, readMailRef('mail:ms-box/gone%40example.com'), {}), (e) => e.code === 'gone');
});
