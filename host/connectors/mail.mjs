/* THE MAIL CONNECTOR: a mailbox (Gmail or Microsoft) reached by the keeper over
 * IMAP, authenticated by a token, never a password. The long-lived refresh token is
 * named in the target and kept by the host's secret store; a short access token is
 * spent from it per session and never leaves this process. The agent asks through
 * its folder; it never connects and never sees the token.
 *
 *   target.config.provider   'google' or 'microsoft' (the IMAP host is the provider's)
 *   target.config.user       the email address
 *   target.config.mailbox    optional: the folder to read ("INBOX" by default)
 *   target.config.clientId   optional: an own OAuth app instead of Thunderbird's
 *   target.secrets.refresh   the NAME of the refresh token in the host's secret store
 *   target.secrets.secret    optional: the NAME of an own client secret
 *   -- OR, a classic IMAP box (no provider): the same verbs, LOGIN instead of a token --
 *   target.config.host       the IMAP server, e.g. imap.example.com (config.port: 993)
 *   target.secrets.password  the NAME of the password in the host's secret store
 *   target.config.smtpHost   its SMTP server (config.smtpPort: 587 with STARTTLS by default; 465 is TLS at once)
 *
 * Reads (level watch): mail.list, mail.read, mail.search. Acts (above watch):
 * mail.move, mail.flag, mail.delete, and mail.send / mail.reply / mail.forward
 * (SMTP; a draft or a message sent later waits in Drafts over IMAP). The body is
 * Markdown, sent as text + HTML (host/compose.mjs).
 *   target.config.signature  optional: Markdown added under what is sent
 *   target.config.lang       optional: 'fr' (default) or 'en', for the quote lines `fetch` and `connect` are injected
 * for tests. Inspired by the open-source Google/Microsoft MCP servers (all MIT), the
 * verbs reimplemented here so the token stays host-side and the levels gate them.
 */
import { connect as tlsConnect } from 'node:tls';
import { no, Refused, asDate } from '../../server/verbs.mjs';
import { refreshAccess, thunderbird, xoauth2, PROVIDERS } from '../oauth.mjs';
import { Exchange, quoted, imapDate } from '../imap.mjs';
import { send as smtpSend, buildMessage, address } from '../smtp.mjs';
import { compose, quoteReply, quoteForward, replySubject, forwardSubject, keptFiles, listOf, sendAt, wallClock } from '../compose.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { graphMail, REPORT_SUBJECT } from './graphmail.mjs';

const IMAP_HOST = { google: 'imap.gmail.com', microsoft: 'outlook.office365.com' };
const SMTP_HOST = { google: 'smtp.gmail.com', microsoft: 'smtp.office365.com' };
const PORT = 993;
const LIST_MAX = 30;            /* messages a list returns at most */
const READ_MAX = 512 * 1024;    /* bytes of one message read at once */
const SOURCE_MAX = 4 * 1024 * 1024; /* bytes of a raw source or attachment download */
const FORWARD_MAX = 24 * 1024 * 1024; /* bytes of an original forwarded with its files */
const SESSION_MAX = 32 * 1024 * 1024; /* bytes a whole IMAP session may receive */
const SINCE_DAYS = 30;          /* a bare list looks back this far */

/* A header's unfolded value from a BODY.PEEK[HEADER.FIELDS (...)] block. */
function headerOf(block, name) {
    const re = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'im');
    const m = re.exec(block);
    return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

/* ---------- a message, made readable ----------
   The agent reads text, not raw MIME. renderMessage walks the parts, decodes the
   best text (plain preferred, else HTML stripped to text) and lists attachments
   by name, type and size -- never their bytes. Any surprise falls back to raw. */
function splitHead(part) { const m = /\r?\n\r?\n/.exec(part); return m ? [part.slice(0, m.index), part.slice(m.index + m[0].length)] : [part, '']; }
function param(headers, name) { const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\r\\n]*))`, 'i').exec(headers); return m ? (m[1] ?? m[2] ?? '').trim() : ''; }
function decodeBody(headers, body) {
    const enc = headerOf(headers, 'Content-Transfer-Encoding').toLowerCase();
    const charset = param(headers, 'charset') || 'utf-8';
    let buf;
    if (enc === 'base64') buf = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    else if (enc === 'quoted-printable') buf = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
    else buf = Buffer.from(body, 'binary');
    try { return new TextDecoder(charset).decode(buf); } catch { return buf.toString('utf8'); }
}
const stripHtml = (html) => html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3[49];/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
/* The essentials of a calendar invitation carried in a mail (a text/calendar part,
   or an .ics attachment): the agent should see WHEN, not just the body's join link. */
function icalWhen(raw) {
    if (!raw) return '';
    const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(raw);
    if (!m) return raw.trim();
    const [, y, mo, d, h, mi] = m;
    return h ? `${y}-${mo}-${d} ${h}:${mi}${/Z\b/.test(raw) ? ' UTC' : ''}` : `${y}-${mo}-${d}`;
}
function readInvite(ics) {
    const block = String(ics).split(/BEGIN:VEVENT/i)[1];
    if (!block) return null;
    const v = block.replace(/\r?\n[ \t]/g, '');  /* unfold folded lines first */
    const g = (k) => { const m = new RegExp(`^${k}[^:\\r\\n]*:(.+)$`, 'im').exec(v); return m ? m[1].trim() : ''; };
    const summary = g('SUMMARY'); const start = g('DTSTART');
    if (!start && !summary) return null;
    return { summary, start: icalWhen(start), end: icalWhen(g('DTEND')), location: g('LOCATION') };
}
function walk(part, out, depth = 0) {
    if (depth > 20) return;
    const [headers, body] = splitHead(part);
    const type = (headerOf(headers, 'Content-Type') || 'text/plain').toLowerCase();
    const filename = param(headers, 'filename') || param(headers, 'name');
    if (type.startsWith('multipart/')) {
        const boundary = param(headers, 'boundary');
        if (!boundary) return;
        for (const p of body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))) if (p.trim()) walk(p, out, depth + 1);
        return;
    }
    if ((type.startsWith('text/calendar') || /\.ics$/i.test(filename || '')) && !out.invite) out.invite = decodeBody(headers, body);
    if (filename || headerOf(headers, 'Content-Disposition').toLowerCase().startsWith('attachment')) {
        out.attachments.push({ name: filename || '(unnamed)', type: type.split(';')[0].trim(), kb: Math.max(1, Math.round(body.replace(/\s/g, '').length * 3 / 4 / 1024)) });
    } else if (type.startsWith('text/plain') && !out.text) out.text = decodeBody(headers, body);
    else if (type.startsWith('text/html') && !out.html) out.html = decodeBody(headers, body);
}
export function renderMessage(raw) {
    try {
        const out = { text: '', html: '', attachments: [] };
        walk(raw, out);
        const head = ['From', 'To', 'Cc', 'Date', 'Subject'].map((h) => { const v = headerOf(raw, h); return v ? `${h}: ${v}` : null; }).filter(Boolean).join('\n');
        let body = out.text || (out.html ? stripHtml(out.html) : '');
        if (!body.trim()) body = splitHead(raw)[1];
        const inv = out.invite ? readInvite(out.invite) : null;
        const invite = inv ? `\n\n--- Invitation ---\n  ${inv.summary || '(no title)'}\n  ${inv.start}${inv.end ? ` — ${inv.end}` : ''}${inv.location ? `\n  @ ${inv.location}` : ''}` : '';
        const attach = out.attachments.length ? `\n\n--- Attachments (${out.attachments.length}) ---\n${out.attachments.map((a) => `  ${a.name} (${a.type}, ~${a.kb} KB)`).join('\n')}` : '';
        return `${head}\n\n${body.trim()}${invite}${attach}`.trim();
    } catch { return raw; }
}

/* An attachment's bytes (not text): base64/quoted-printable/raw -> a Buffer, so
   binary files come back whole, never mangled by a text decode. */
function decodeBytes(headers, body) {
    const enc = headerOf(headers, 'Content-Transfer-Encoding').toLowerCase();
    if (enc === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    if (enc === 'quoted-printable') return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
    return Buffer.from(body, 'binary');
}
/* The attachments of a raw message, with their still-encoded bodies, for download. */
function attachmentsOf(raw) {
    const list = [];
    (function dig(part, depth = 0) {
        if (depth > 20) return;
        const [headers, body] = splitHead(part);
        const type = (headerOf(headers, 'Content-Type') || 'text/plain').toLowerCase();
        if (type.startsWith('multipart/')) {
            const boundary = param(headers, 'boundary'); if (!boundary) return;
            for (const p of body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))) if (p.trim()) dig(p, depth + 1);
            return;
        }
        const filename = param(headers, 'filename') || param(headers, 'name');
        if (filename || headerOf(headers, 'Content-Disposition').toLowerCase().startsWith('attachment')) list.push({ name: filename || `part${list.length + 1}`, type: type.split(';')[0].trim(), headers, body });
    })(raw);
    return list;
}

/* A Message-ID of our own, known before the message leaves: told to the agent, kept to find a return. */
const newId = (user) => `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${String(user).split('@')[1] || 'tether'}>`;

/* ---------- a returned mail (a bounce), read ----------
   A delivery report (RFC 3464: multipart/report; report-type=delivery-status) says, per recipient,
   Final-Recipient, Action (failed, delayed, delivered, relayed), Status (5.x.x final, 4.x.x for now)
   and the far server's words (Diagnostic-Code). An older bounce with no report is known by its
   sender (MAILER-DAEMON, postmaster, MicrosoftExchange...) or its subject. An auto-reply is none. */
export const BOUNCE_SUBJECT = REPORT_SUBJECT;
export const BOUNCE_FROM = /(^|[<\s"])(mailer-daemon|postmaster|microsoftexchange[^@]*)@/i;
export function readBounce(raw) {
    const text = String(raw ?? '');
    const head = splitHead(text)[0];
    const type = headerOf(head, 'Content-Type').toLowerCase();
    const from = decodeWords(headerOf(head, 'From'));
    const subject = decodeWords(headerOf(head, 'Subject'));
    const report = /multipart\/report/.test(type) && /delivery-status/.test(type);
    if (!report && !BOUNCE_FROM.test(` ${from}`) && !BOUNCE_SUBJECT.test(subject)) return null;
    if (!report && /auto-replied/i.test(headerOf(head, 'Auto-Submitted')) && !BOUNCE_FROM.test(` ${from}`)) return null;
    const recipients = [];
    const at = text.search(/Content-Type:\s*message\/(global-)?delivery-status/i);
    if (at >= 0) {
        const part = splitHead(text.slice(at))[1];
        const end = part.search(/\r?\n--[^\r\n]+/);
        const fields = (end >= 0 ? part.slice(0, end) : part).replace(/\r?\n[ \t]+/g, ' ');
        for (const block of fields.split(/\r?\n\s*\r?\n/)) {
            const f = (n) => (new RegExp(`^${n}:\\s*(.*)$`, 'im').exec(block)?.[1] ?? '').trim();
            const who = (f('Final-Recipient') || f('Original-Recipient')).replace(/^[^;]*;\s*/, '').replace(/[<>]/g, '').trim().toLowerCase();
            if (!who) continue;
            recipients.push({ to: who, action: f('Action').toLowerCase(), status: f('Status'), diag: f('Diagnostic-Code').replace(/^[^;]*;\s*/, '').replace(/\s+/g, ' ') });
        }
    }
    return { subject, recipients, delayed: /delay/i.test(subject) && !recipients.length, raw: text };
}
const isFinal = (r) => r.action === 'failed' || /^5\./.test(r.status);
const isDelay = (r) => r.action === 'delayed' || /^4\./.test(r.status);

const numUid = (u) => { const n = Number(u); if (!Number.isInteger(n) || n <= 0) no('that needs the message number (uid)'); return n; };
/* The marks a person may set, named by a plain word -- never a raw IMAP flag from
   the agent. Each maps to an add/remove and a system flag. */
const FLAGS = { read: ['+', '\\Seen'], seen: ['+', '\\Seen'], unread: ['-', '\\Seen'], unseen: ['-', '\\Seen'], flagged: ['+', '\\Flagged'], starred: ['+', '\\Flagged'], unflagged: ['-', '\\Flagged'] };
const flagOf = (f) => { const e = FLAGS[String(f ?? '').toLowerCase().trim()]; if (!e) no('flag is one of: read, unread, flagged, unflagged'); return { op: e[0], flag: e[1] }; };

/* A header's encoded words (=?UTF-8?B?...?= / ?Q?) back to letters. */
export function decodeWords(v) {
    return String(v ?? '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (m, cs, enc, data) => {
        try {
            const buf = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64')
                : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
            return new TextDecoder(cs).decode(buf);
        } catch { return m; }
    });
}
/* The bare addresses of a header (display names dropped), in order, once each. */
export const emailsOf = (v) => [...new Set((String(v ?? '').match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+\.[^\s<>,;:"()]+/g) ?? []).map((x) => x.toLowerCase()))];
/* What a reply or a forward needs of its original: who, when, about what, the
   thread ids, its readable text, and its files (still encoded). */
export function originalOf(raw) {
    const head = splitHead(raw)[0];
    const h = (n) => decodeWords(headerOf(head, n));
    const out = { text: '', html: '', attachments: [] };
    try { walk(raw, out); } catch { /* text stays empty */ }
    return {
        from: h('From'), replyTo: h('Reply-To'), to: h('To'), cc: h('Cc'), date: h('Date'), subject: h('Subject'),
        messageId: headerOf(head, 'Message-ID'), references: headerOf(head, 'References'),
        text: out.text || (out.html ? stripHtml(out.html) : ''),
        files: attachmentsOf(raw),
    };
}
export function mail({ fetch: fetchImpl = globalThis.fetch, connect = tlsConnect, smtpConnect, smtpSecure, smtpWait } = {}) {
    const tokens = new Map(); // target.id -> { value, exp }

    const providerOf = (target) => { const p = String(target.config?.provider ?? ''); if (!IMAP_HOST[p] || !PROVIDERS[p]) no(`${target.title}: set its provider to google or microsoft`); return p; };
    const userOf = (target) => { const u = String(target.config?.user ?? '').trim(); if (!u) no(`${target.title}: set its email address`); return u; };
    const boxOf = (target, given) => {
        const name = String(given ?? target.config?.mailbox ?? 'INBOX').trim() || 'INBOX';
        if (/[\r\n\0]/.test(name)) no('a mailbox name cannot contain a line break');
        return name;
    };
    /* A target is OAuth when it names a provider; otherwise a classic IMAP box, with
       its own server and a password. The IMAP verbs are the same for both. */
    const isOAuth = (target) => Boolean(String(target.config?.provider ?? '').trim());
    const hostOf = (target) => {
        if (isOAuth(target)) return IMAP_HOST[providerOf(target)];
        const h = String(target.config?.host ?? '').trim().toLowerCase();
        if (!h || !h.includes('.') || /[\s/]/.test(h)) no(`${target.title}: set its mail server (host), or a google/microsoft provider`);
        return h;
    };
    const portOf = (target) => { const p = Number(target.config?.port); return Number.isInteger(p) && p > 0 && p < 65536 ? p : PORT; };

    async function access(target, ctx) {
        const provider = providerOf(target);
        const cached = tokens.get(target.id);
        if (cached && cached.exp > Date.now() + 60_000) return cached.value;
        const refresh = await ctx.secret('refresh');
        if (!refresh) no(`${target.title}: its refresh token is empty -- reconnect the account`);
        const clientId = target.config?.clientId || thunderbird(provider).clientId;
        const clientSecret = target.secrets?.secret ? await ctx.secret('secret') : thunderbird(provider).clientSecret;
        let t;
        try { t = await refreshAccess(provider, { clientId, clientSecret, refreshToken: refresh, fetch: fetchImpl }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: the mail account must be reconnected (its authorisation was refused)`); }
        tokens.set(target.id, { value: t.accessToken, exp: t.expiresAt });
        return t.accessToken;
    }

    /* Microsoft is reached over Graph (its borrowed client is a Graph client with
       no IMAP scope); Google and classic boxes over IMAP. Same six verbs either way. */
    const isGraph = (target) => isOAuth(target) && providerOf(target) === 'microsoft';
    const gmail = graphMail({ fetch: fetchImpl, token: access });

    /* Open an authenticated IMAP session; the caller closes it in a finally. OAuth
       (a provider) signs in with XOAUTH2 from the minted token; a classic box signs
       in with LOGIN and its password. Either secret is the host's, never the agent's. */
    async function open(target, ctx) {
        const user = userOf(target);
        const host = hostOf(target);
        let socket;
        try { socket = connect({ host, port: portOf(target), servername: host }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: cannot reach the mail server`); }
        const imap = new Exchange(socket, SESSION_MAX);
        try {
            await imap.greeting();
            if (isOAuth(target)) {
                await imap.authenticateXoauth2(xoauth2(user, await access(target, ctx)), `${target.title}: the mailbox refused the token -- reconnect the account`);
            } else {
                const password = await ctx.secret('password');
                if (!password) no(`${target.title}: its password is empty`);
                await imap.command(`LOGIN ${quoted(user)} ${quoted(password)}`, `${target.title}: the mailbox refused the user or the password`);
            }
        } catch (e) { try { socket.destroy(); } catch { /* closing */ } if (e instanceof Refused) throw e; no(`${target.title}: ${e?.message ?? 'the mailbox could not be opened'}`); }
        return { imap, socket, user };
    }
    /* ---------- a warm, reused connection ----------
       Signing in to a mailbox over IMAP is many slow round-trips (TCP, TLS, the
       token exchange), and doing it for every verb made a single read take ~20s
       against a far server. So the authenticated connection is KEPT OPEN and
       reused, one verb at a time (serialized per target -- never two verbs on the
       same socket at once), and closed only after it has sat idle. A connection
       that died between verbs is dropped and reopened once. */
    const sessions = new Map();   // target.id -> { imap, socket, timer }
    const queues = new Map();     // target.id -> the tail of its turn-taking
    const IDLE_MS = 90_000;
    function drop(id) { const s = sessions.get(id); if (!s) return; sessions.delete(id); clearTimeout(s.timer); try { s.socket.destroy(); } catch { /* closed */ } }
    function warm(id, s) { clearTimeout(s.timer); s.timer = setTimeout(() => drop(id), IDLE_MS); s.timer.unref?.(); }
    async function runOnce(target, ctx, fn) {
        const id = target.id;
        let s = sessions.get(id);
        if (s) clearTimeout(s.timer); else { const o = await open(target, ctx); s = { imap: o.imap, socket: o.socket }; sessions.set(id, s); }
        try { const r = await fn(s.imap); warm(id, s); return r; }
        catch (e) { if (e instanceof Refused) { warm(id, s); } else { drop(id); } throw e; }
    }
    /* `write`: an act that changes the mailbox (APPEND, MOVE, EXPUNGE) is never sent twice -- a warm
       connection is first checked with NOOP (reopened if dead), then the act goes once: a failure in
       the middle is said, never retried blindly (a draft or a Sent copy would be doubled). */
    async function withImap(target, ctx, fn, { write = false } = {}) {
        const id = target.id;
        const prev = queues.get(id) ?? Promise.resolve();
        let release; const mine = new Promise((r) => { release = r; });
        queues.set(id, prev.then(() => mine, () => mine));
        await prev.catch(() => { /* a prior verb's failure is its own */ });
        try {
            if (write) {
                const s = sessions.get(id);
                if (s) { try { await s.imap.command('NOOP', 'the mailbox did not answer'); } catch { drop(id); } }
                /* A line lost in the middle of a write: it may have happened, said as on the other providers (loop 13). */
                try { return await runOnce(target, ctx, fn); }
                catch (e) { if (e instanceof Refused || !/did not answer in time|closed the connection|cannot be reached|sent more than/.test(e?.message ?? '')) throw e; no(`${target.title}: ${e.message} -- it may have been done: check before asking again`); }
            }
            try { return await runOnce(target, ctx, fn); }
            catch (e) { if (e instanceof Refused) throw e; return await runOnce(target, ctx, fn); /* dead connection: reopen once */ }
        } finally { release(); }
    }

    const searchUids = (lines) => (lines.find((l) => /^\* SEARCH/i.test(l)) ?? '').split(' ').slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);

    /* The briefs of many messages in ONE fetch, not one round-trip each: fetching
       them one by one made a list of 30 take minutes. The blocks come back in the
       server's order, so they are mapped by uid and returned in the caller's. */
    async function brief(imap, uids) {
        if (!uids.length) return [];
        const lines = await imap.command(`UID FETCH ${uids.join(',')} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`, 'the messages could not be read');
        const byUid = new Map();
        for (const l of lines) {
            if (!/^\* \d+ FETCH/i.test(l)) continue;
            const uid = Number(/UID (\d+)/i.exec(l)?.[1]);
            if (!Number.isInteger(uid)) continue;
            const cut = l.indexOf('\n');
            const block = cut >= 0 ? l.slice(cut + 1) : '';
            const when = /INTERNALDATE "([^"]+)"/i.exec(l)?.[1] ?? headerOf(block, 'Date');
            byUid.set(uid, `#${uid}  ${when}\n  From: ${headerOf(block, 'From')}\n  Subject: ${headerOf(block, 'Subject')}`);
        }
        return uids.map((u) => byUid.get(u)).filter(Boolean);
    }

    const langOf = (target) => String(target.config?.lang ?? 'fr');
    /* The words of a message: Markdown to text + HTML (or text as written), the
       mailbox's signature, then the quoted original of a reply or a forward. */
    const words = (target, a, quote) => compose({ body: a.body, format: a.format, signature: a.signature === false || a.signature === 'false' ? '' : target.config?.signature, quote });
    const added = (a) => (Array.isArray(a.attachments) ? a.attachments : (a.attach ? [{ name: a.attachName, bytes: a.attach }] : []));

    /* The original of a reply or a forward, whole: its size is asked first, so one
       too large is refused rather than cut. */
    async function original(target, ctx, a, max) {
        const uid = numUid(a.uid);
        return withImap(target, ctx, async (imap) => {
            await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
            const sized = await imap.command(`UID FETCH ${uid} (RFC822.SIZE)`, 'that message could not be read');
            const size = Number(/RFC822\.SIZE (\d+)/i.exec(sized.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '')?.[1]);
            if (!Number.isFinite(size)) no('no such message');
            if (size > max) no(max === FORWARD_MAX ? `the original is too large (${Math.round(size / 1024 / 1024)} MB) to forward with its files -- forward it with keep "none", or fewer files` : 'the original is too large to quote');
            const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[])`, 'that message could not be read');
            const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
            const cut = fetched.indexOf('\n'); if (cut < 0) no('no such message');
            return originalOf(fetched.slice(cut + 1).replace(/\)\s*$/, ''));
        });
    }
    /* The folder drafts live in: the one the server marks \\Drafts, else one named
       like it, else "Drafts". */
    async function draftsOf(imap) {
        const lines = await imap.command('LIST "" "*"', 'the folders could not be listed');
        const boxes = lines.filter((l) => /^\* LIST/i.test(l)).map((l) => ({ flags: /^\* LIST \(([^)]*)\)/i.exec(l)?.[1] ?? '', name: (/"((?:[^"\\]|\\.)*)"\s*$/.exec(l)?.[1] ?? /\s(\S+)$/.exec(l)?.[1] ?? '').replace(/\\(.)/g, '$1') }));
        return (boxes.find((b) => /\\Drafts/i.test(b.flags)) ?? boxes.find((b) => /(^|\/)(drafts|brouillons)$/i.test(b.name)))?.name ?? 'Drafts';
    }
    /* THE SENT FOLDER, WHATEVER THE LANGUAGE OR THE CONFIG (05-11): first the folder the server itself marks
       \Sent (IMAP SPECIAL-USE, RFC 6154: Dovecot, Gmail, Outlook, Fastmail... say it whatever its name or its
       language); else, for an older server, a folder named so in one of the common languages, at the top or
       under INBOX; else none is there: "Sent" is made (CREATE ... (USE (\Sent)) when the server takes it). */
    const SENT_NAMES = /(^|[/.])(sent|sent items|sent mail|sent messages|envoy[ée]s|[ée]l[ée]ments envoy[ée]s|messages envoy[ée]s|gesendet|gesendete (objekte|elemente)|enviados|elementos enviados|correo enviado|inviati|posta inviata|verzonden|verzonden items|enviadas|itens enviados|wys[łl]ane|odeslan[ée]|skickat|sendt|l[äa]hetetyt|отправленные|已发送|送信済み)$/i;
    async function sentOf(imap) {
        const lines = await imap.command('LIST "" "*"', 'the folders could not be listed');
        const boxes = lines.filter((l) => /^\* LIST/i.test(l)).map((l) => ({ flags: /^\* LIST \(([^)]*)\)/i.exec(l)?.[1] ?? '', name: (/"((?:[^"\\]|\\.)*)"\s*$/.exec(l)?.[1] ?? /\s(\S+)$/.exec(l)?.[1] ?? '') }));
        const found = boxes.find((b) => /\\Sent\b/i.test(b.flags)) ?? boxes.find((b) => SENT_NAMES.test(b.name));
        if (found) return found.name;
        /* None: made, as most mail programs do. A server that does not know USE gets a plain CREATE. */
        try { await imap.command('CREATE "Sent" (USE (\\Sent))', 'the Sent folder could not be made'); } catch { await imap.command('CREATE "Sent"', 'the Sent folder could not be made'); }
        return 'Sent';
    }
    /* THE TRASH FOLDER (mail.delete, 05-11): like Sent, first the folder the server marks \Trash (SPECIAL-USE,
       RFC 6154: Gmail's "[Gmail]/Trash" or its translation, Dovecot, Outlook, Fastmail...); else a folder named
       so in a common language, at the top or under INBOX; else "Trash" is made. Names are matched decoded
       (IMAP's modified UTF-7: "&AMk-l&AOk-ments supprim&AOk-s" is "Éléments supprimés"). */
    const TRASH_NAMES = /^(inbox[/.])?(trash|deleted|deleted items|deleted messages|bin|corbeille|[ée]l[ée]ments supprim[ée]s|messages supprim[ée]s|papierkorb|gel[öo]scht|gel[öo]schte (objekte|elemente)|papelera|elementos eliminados|cestino|posta eliminata|elementi eliminati|prullenbak|verwijderde items|lixeira|lixo|itens exclu[íi]dos|kosz|ko[šs]|papperskorgen|borttagna objekt|papirkurv|slettet|roskakori|poistetut|корзина|удаленные|удалённые|已删除|垃圾箱|ゴミ箱|削除済みアイテム)$/i;
    const mutf7 = (name) => name.replace(/&([^-]*)-/g, (_, b) => {
        if (!b) return '&';
        const bytes = Buffer.from(b.replace(/,/g, '/'), 'base64'); let out = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
        return out;
    });
    async function trashOf(imap) {
        const lines = await imap.command('LIST "" "*"', 'the folders could not be listed');
        const boxes = lines.filter((l) => /^\* LIST/i.test(l)).map((l) => ({ flags: /^\* LIST \(([^)]*)\)/i.exec(l)?.[1] ?? '', name: (/"((?:[^"\\]|\\.)*)"\s*$/.exec(l)?.[1] ?? /\s(\S+)$/.exec(l)?.[1] ?? '').replace(/\\(.)/g, '$1') }));
        const found = boxes.find((b) => /\\Trash\b/i.test(b.flags)) ?? boxes.find((b) => TRASH_NAMES.test(mutf7(b.name)));
        if (found) return { name: found.name, shown: mutf7(found.name) };
        try { await imap.command('CREATE "Trash" (USE (\\Trash))', 'the Trash folder could not be made'); } catch { await imap.command('CREATE "Trash"', 'the Trash folder could not be made'); }
        return { name: 'Trash', shown: 'Trash', made: true };
    }
    /* The uid is there, in the folder opened: IMAP ignores an unknown uid without an error, so a move, a
       mark or a delete would say "done" for nothing (loop 5). */
    async function mustHave(imap, uid, box) {
        if (!searchUids(await imap.command(`UID SEARCH UID ${uid}`, 'that folder could not be searched')).includes(uid)) no(`no message #${uid} in ${box} -- list it again (its uid is the one of the folder it was listed in)`);
    }
    /* Is a message (by its Message-ID) in a folder? Read only. */
    async function hasMessage(imap, box, messageId) {
        await imap.command(`EXAMINE ${quoted(box)}`, 'that folder could not be opened');
        return searchUids(await imap.command(`UID SEARCH HEADER Message-ID ${quoted(messageId)}`, 'that folder could not be searched')).length > 0;
    }
    /* Send the built message, or keep it as a draft. */
    async function deliver(target, ctx, a, m) {
        const user = userOf(target);
        const names = m.attachments.map((f) => f?.name || 'attachment');
        const files = names.length ? ` with ${names.join(', ')}` : '';
        const at = sendAt(a.at);
        const draft = a.draft === true || a.draft === 'true';
        if (at && draft) no('a scheduled mail waits in Drafts already: give at or draft, not both');
        if (at || draft) for (const x of [...m.to, ...m.cc, ...m.bcc]) try { address(x); } catch (e) { no(e.message); }
        if (at) {
            /* No mail server keeps a message for later over IMAP/SMTP: it waits in
               Drafts (where a person sees it, and deletes it to cancel), and the
               keeper sends it at its time. */
            if (!host) no('sending later needs the keeper running');
            const messageId = newId(user);
            const raw = buildMessage({ ...m, from: user, messageId, keepBcc: true });   /* who it goes to, Bcc too, seen in Drafts (loop 13) */
            const box = await withImap(target, ctx, async (imap) => {
                const drafts = await draftsOf(imap);
                await imap.append(drafts, '\\Draft \\Seen', raw, 'the message could not be kept for later');
                return drafts;
            }, { write: true });
            later.push({ id: messageId, target: target.id, agent: ctx.agent, when: at.getTime(), box, to: m.to, cc: m.cc, bcc: m.bcc, subject: String(m.subject ?? ''), tries: 0 });
            keep();
            return { text: `Scheduled for ${wallClock(at)}, to ${m.to.join(', ')}${files} — it waits in ${box} until then (delete it there to cancel). The keeper must be running at that time; if not, it leaves as soon as it is back (and you are told).${LATER_TEXT}`, size: 0 };
        }
        if (draft) {
            const raw = buildMessage({ ...m, from: user, keepBcc: true });
            const box = await withImap(target, ctx, async (imap) => {
                const drafts = await draftsOf(imap);
                await imap.append(drafts, '\\Draft \\Seen', raw, 'the draft could not be saved');
                return drafts;
            }, { write: true });
            return { text: `Draft saved in ${box}, to ${m.to.join(', ')}${files} — not sent.`, size: 0 };
        }
        let server; let port = 587; let auth;
        if (isOAuth(target)) {
            server = SMTP_HOST[providerOf(target)];
            auth = { xoauth2: xoauth2(user, await access(target, ctx)) };
        } else {
            server = String(target.config?.smtpHost ?? '').trim().toLowerCase();
            if (!server || !server.includes('.')) no(`${target.title}: set its SMTP server (smtpHost) to send`);
            const password = await ctx.secret('password');
            if (!password) no(`${target.title}: its password is empty`);
            auth = { user, password };
        }
        if (Number(target.config?.smtpPort) > 0) port = Number(target.config.smtpPort);
        /* Built once: the same message (its Message-ID too) goes out and is kept in Sent. */
        /* A message already made (a scheduled one, fetched back from Drafts: m.raw) goes as it is. */
        const messageId = m.raw ? headerOf(splitHead(String(m.raw))[0], 'Message-ID') : newId(user);
        /* A Bcc line a draft may keep never leaves with the message. */
        const raw = m.raw ? String(m.raw).replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n/gim, '') : buildMessage({ ...m, from: user, messageId });
        try {
            await smtpSend({ host: server, port, auth, from: user, to: m.to, cc: m.cc, bcc: m.bcc, raw,
                ...(smtpConnect ? { connect: smtpConnect } : {}), ...(smtpSecure ? { secure: smtpSecure } : {}), ...(smtpWait ?? {}) });
        } catch (e) {
            if (e instanceof Refused) throw e;
            /* Said as the server said it; a final refusal (5xx) is marked, so a scheduled send stops trying. */
            throw Object.assign(new Refused(`${target.title}: ${e?.message ?? 'the message could not be sent'}`), { permanent: e?.permanent === true, unsure: e?.unsure === true });
        }
        const copies = m.cc.length ? ` (cc ${m.cc.join(', ')})` : '';
        /* A COPY IN SENT (05-11): Google and Microsoft keep one themselves; a classic box (IMAP/SMTP) does not --
           without it the mail leaves no trace in the person's mailbox. Read, in the folder the server marks Sent.
           A copy that fails does not undo the send: it is said. `saveSent: false` in the box's config turns it off. */
        let kept = '';
        if (!isOAuth(target) && target.config?.saveSent !== false) {
            /* A server that files what it relays itself (some do) already has it: no second copy (#19). */
            try {
                kept = ` A copy is in ${await withImap(target, ctx, async (imap) => {
                    const box = await sentOf(imap);
                    if (messageId && await hasMessage(imap, box, messageId)) return box;
                    await imap.append(box, '\\Seen', raw, 'the copy could not be kept in Sent');
                    return box;
                }, { write: true })}.`;
            } catch (e) { kept = ` (Sent, but its copy could not be kept in Sent: ${e?.message ?? 'IMAP refused it'}.)`; }
        }
        const watched = watch(target, ctx.agent, { id: messageId, to: [...m.to, ...m.cc, ...m.bcc], subject: m.subject ?? decodeWords(headerOf(splitHead(raw)[0], 'Subject')) });
        return { text: `Sent to ${m.to.join(', ')}${copies}${files} (accepted by the server; Message-ID ${messageId}).${kept}${watched}`, size: 0 };
    }

    /* ---------- messages to send later (IMAP/SMTP) ----------
       Kept in a file of the keeper's store: which draft (by its Message-ID),
       for whom, when. Each minute the keeper wakes the connector; a message
       due is fetched from Drafts, sent as it is, then taken out of Drafts. A
       draft no longer there was cancelled by a person: nothing is sent. An
       agent a person stopped has nothing sent until it is resumed.
       NEVER TWICE, NEVER LOST IN SILENCE (05-11): the try is marked before the send and `sentAt`
       right after, so a keeper that stopped in between looks in Sent before sending again; a final
       refusal (5xx), or 30 tries, ends it with a notice to the agent and the person (the draft stays
       in Drafts); a message that leaves more than 10 minutes late says so too. */
    let host = null; let later = []; let sent = [];
    const laterFile = () => join(host.dir, 'mail-later.json');
    const sentFile = () => join(host.dir, 'mail-sent.json');
    const save = (file, list) => { const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 }); renameSync(tmp, file); };
    function keep() { if (host) save(laterFile(), later); }
    function keepSent() { if (host) save(sentFile(), sent); }
    const LATE_MS = 10 * 60_000;
    const tell = (rec, kind, text, ref) => { try { host.notice?.({ agent: rec.agent, target: { id: rec.target, title: host.target(rec.target)?.title }, kind, text, ref }); } catch { /* journaled by the tick anyway */ } };
    async function sendDue(rec) {
        const target = host.target(rec.target);
        if (!target) return 'its mailbox is gone';
        const ctx = host.ctx(target, rec.agent);
        if (!rec.sentAt) {
            const found = await withImap(target, ctx, async (imap) => {
                await imap.command(`SELECT ${quoted(rec.box)}`, 'the drafts folder could not be opened');
                const uid = searchUids(await imap.command(`UID SEARCH HEADER Message-ID ${quoted(rec.id)}`, 'the drafts could not be searched'))[0];
                if (!uid) return null;
                const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[])`, 'the scheduled message could not be read');
                const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
                const cut = fetched.indexOf('\n');
                return cut < 0 ? null : { uid, raw: fetched.slice(cut + 1).replace(/\)\s*$/, '') };
            });
            if (!found) return 'cancelled';
            /* A try begun before (a keeper stopped mid-send, a server silent after the message): in Sent already? */
            /* Not found there proves nothing sent only where a sent mail always lands in Sent (Gmail files it itself);
               a classic box gets its copy from Tether after the send, so a cut in between is "maybe sent", never sent
               again. A Sent that cannot be searched: tried again next minute, nothing sent (loop 10). */
            const already = rec.trying ? await withImap(target, ctx, async (imap) => hasMessage(imap, await sentOf(imap), rec.id)) : false;
            if (!already && rec.trying && !isOAuth(target)) throw Object.assign(new Error('a try was cut after it began, and the message is not in Sent'), { unsure: true });
            if (!already) {
                rec.trying = host.now(); keep();
                const raw = found.raw.replace(/^Date: .*$/m, `Date: ${new Date(host.now()).toUTCString()}`);
                /* A try that failed for sure (server away, refused) left nothing: the mark is taken off (loop 11). */
                try { await deliver(target, ctx, {}, { to: rec.to, cc: rec.cc, bcc: rec.bcc, raw, attachments: [] }); }
                catch (e) { if (e?.unsure !== true) { delete rec.trying; keep(); } throw e; }
            }
            rec.sentAt = host.now(); keep();
        }
        await withImap(target, ctx, async (imap) => {
            await imap.command(`SELECT ${quoted(rec.box)}`, 'the drafts folder could not be opened');
            const uid = searchUids(await imap.command(`UID SEARCH HEADER Message-ID ${quoted(rec.id)}`, 'the drafts could not be searched'))[0];
            if (!uid) return;
            await imap.command(`UID STORE ${uid} +FLAGS (\\Deleted)`, 'the sent draft could not be removed');
            await imap.command(`UID EXPUNGE ${uid}`, 'the sent draft could not be removed');
        }, { write: true }).catch(() => { /* sent; a leftover draft is only clutter */ });
        return 'sent';
    }

    /* ---------- a mail that comes back (bounces) ----------
       "Sent" only means the server accepted it. Each mail sent is watched for 48 h (every 2 minutes
       the first hour, then every 15): the INBOX is searched for delivery reports since it left, a
       report is tied to the mail by its Message-ID (or, for one sent by Microsoft through a reply,
       by its subject and recipient), and each recipient that failed, or is delayed, is told to the
       agent and the person (a notice). A delay keeps the watch on, every 6 hours, up to 5 days. */
    const WATCH_MS = 48 * 3600_000;
    const DELAYED_MS = 5 * 86_400_000 + 3600_000;
    const WATCH_TEXT = ' Tether watches for a return for 48 h: a mail that comes back is told to you (and to the person).';
    const LATER_TEXT = ' Once it leaves, Tether watches for a return for 48 h: a mail that comes back, or one that cannot leave, is told to you.';
    function watch(target, agent, { id, to, subject, from } = {}) {
        if (!host || !agent) return '';
        const at = Math.max(host.now(), Number(from) || 0);
        sent.push({ id: id || null, target: target.id, agent, to: [...new Set((to ?? []).map((x) => String(x).toLowerCase()))], subject: String(subject ?? ''), sentAt: at, until: at + WATCH_MS, next: at + 2 * 60_000, told: [] });
        sent = sent.slice(-500); keepSent();
        return WATCH_TEXT;
    }
    const looked = new Map();   // target.id -> Map(message key -> bounce or null): a report read once
    async function imapBounces(target, ctx, since) {
        const seen = looked.get(target.id) ?? new Map(); looked.set(target.id, seen);
        return withImap(target, ctx, async (imap) => {
            await imap.command('EXAMINE "INBOX"', 'the inbox could not be opened');
            const uids = searchUids(await imap.command(`UID SEARCH SINCE ${imapDate(since)} OR OR OR FROM "mailer-daemon" FROM "postmaster" FROM "microsoftexchange" HEADER Content-Type "delivery-status"`, 'the inbox could not be searched')).slice(-30);
            const out = [];
            for (const uid of uids) {
                if (!seen.has(uid)) {
                    const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${READ_MAX}>)`, 'a report could not be read');
                    const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
                    const cut = fetched.indexOf('\n');
                    seen.set(uid, cut < 0 ? null : readBounce(fetched.slice(cut + 1).replace(/\)\s*$/, '')));
                }
                if (seen.get(uid)) out.push(seen.get(uid));
            }
            return out;
        });
    }
    async function graphBounces(target, ctx, since) {
        const seen = looked.get(target.id) ?? new Map(); looked.set(target.id, seen);
        const out = [];
        for (const { id, raw } of await gmail.reports(target, ctx, since, (key) => seen.has(key))) seen.set(id, raw === null ? null : readBounce(raw));
        for (const b of seen.values()) if (b) out.push(b);
        return out;
    }
    function match(rec, b) {
        if (rec.id && b.raw.includes(rec.id)) return true;
        const subj = rec.subject.trim();
        /* The returned headers carry an accented subject encoded (=?UTF-8?...?=): read decoded. */
        b.plain ??= decodeWords(b.raw).replace(/\r?\n[ \t]+/g, ' ');
        return subj.length >= 3 && (b.subject.includes(subj) || b.plain.includes(`Subject: ${subj}`)) && b.recipients.some((r) => rec.to.includes(r.to));
    }
    async function scanBounces() {
        const now = host.now();
        const before = sent.length;
        sent = sent.filter((r) => r.until > now && host.target(r.target));
        const due = sent.filter((r) => r.next <= now);
        let changed = before !== sent.length;
        for (const id of new Set(due.map((r) => r.target))) {
            const target = host.target(id);
            const recs = due.filter((r) => r.target === id);
            const since = new Date(Math.min(...recs.map((r) => r.sentAt)) - 86_400_000);
            let found;
            try { found = isGraph(target) ? await graphBounces(target, host.ctx(target, recs[0].agent), since) : await imapBounces(target, host.ctx(target, recs[0].agent), since); }
            catch { for (const r of recs) r.next = now + 15 * 60_000; changed = true; continue; }
            for (const rec of recs) {
                for (const b of found.filter((x) => match(rec, x))) {
                    const subject = rec.subject || b.subject;
                    const list = b.recipients.length ? b.recipients.filter((r) => isFinal(r) || isDelay(r)) : rec.to.map((to) => ({ to, action: b.delayed ? 'delayed' : 'failed', status: '', diag: '' }));
                    for (const r of list) {
                        const final = isFinal(r) || !isDelay(r);
                        const key = `${final ? 'failed' : 'delayed'}:${r.to}`;
                        if (rec.told.includes(key)) continue;
                        rec.told.push(key);
                        const why = [r.status, r.diag].filter(Boolean).join(' ') || 'the server sent it back';
                        if (final) tell(rec, 'mail.bounced', `The mail "${subject}" to ${r.to} was NOT delivered: ${why}.`, rec.id);
                        else {
                            rec.until = Math.max(rec.until, rec.sentAt + DELAYED_MS); rec.delayed = true;
                            tell(rec, 'mail.delayed', `The mail "${subject}" to ${r.to} is delayed (${why}): its server keeps trying; Tether keeps watching until it is delivered or returned.`, rec.id);
                        }
                    }
                }
                rec.next = now + (rec.delayed ? 6 * 3600_000 : now - rec.sentAt < 3600_000 ? 2 * 60_000 : 15 * 60_000);
            }
            changed = true;
        }
        if (changed) keepSent();
    }

    /* A mail Microsoft sent: watched like the others (its ref, its recipients, its time). */
    /* Exchange holds a scheduled one in its Outbox: a return is watched, but one that never leaves is Exchange's to report. */
    const graphSent = (target, ctx, r) => { const { watch: w, ...rest } = r; if (w && watch(target, ctx.agent, w)) rest.text += w.from ? ' Once it leaves, Tether watches for a return for 48 h: a mail that comes back is told to you.' : WATCH_TEXT; return rest; };

    let ticking = false;
    async function tick() {
        if (!host || ticking) return;
        ticking = true;
        try {
            for (const rec of later.filter((r) => r.when <= host.now())) {
                if (host.stopped(rec.agent)) { if (!rec.held) { rec.held = true; keep(); } continue; }
                const target = host.target(rec.target);
                let outcome; let error; let final = false; let unsure = false;
                /* A server silent after taking the message may have sent it: never sent again blindly, said. */
                try { outcome = await sendDue(rec); } catch (e) { error = e?.message ?? String(e); unsure = e?.unsure === true; final = e?.permanent === true || unsure; }
                if (error && !final && ++rec.tries < 30) { keep(); continue; }   /* a server away: tried again next minute */
                later = later.filter((r) => r !== rec); keep();
                const late = outcome === 'sent' && host.now() - rec.when > LATE_MS;
                host.note({ agent: { id: rec.agent, name: rec.agent }, target: { id: rec.target, title: target?.title }, verb: 'mail.send', detail: `later, to ${rec.to.join(', ')}: ${rec.subject}`,
                    decision: 'yes', because: 'later', ok: outcome === 'sent', ...(outcome === 'sent' ? {} : { error: error ?? (outcome === 'cancelled' ? 'cancelled: the draft was deleted' : outcome) }) });
                if (unsure) tell(rec, 'mail.later-unsure', `The mail "${rec.subject}" to ${rec.to.join(', ')} MAY have been sent (${error}). It is not sent again; check Sent (its draft is still in ${rec.box}).`, rec.id);
                else if (error) tell(rec, 'mail.later-failed', `The mail "${rec.subject}" to ${rec.to.join(', ')}, to leave at ${wallClock(new Date(rec.when))}, could NOT be sent: ${error}. It is still in ${rec.box}.`, rec.id);
                else if (late) tell(rec, 'mail.later-late', `The mail "${rec.subject}" to ${rec.to.join(', ')}, due at ${wallClock(new Date(rec.when))}, left late, at ${wallClock(new Date(host.now()))} (${rec.held ? 'the agent was stopped by a person until then' : rec.tries ? 'the mail server could not be reached until then' : 'the keeper was not running at its time'}).`, rec.id);
            }
            await scanBounces().catch(() => { /* looked again next minute */ });
        } finally { ticking = false; }
    }

    const verbs = {
        /* The recent messages of a mailbox: who, subject, when -- newest first. */
        async 'mail.list'(target, a, ctx) {
            if (isGraph(target)) return gmail.list(target, a, ctx);
            const since = asDate(a.since, 'since');
            const before = asDate(a.before, 'before');
            return withImap(target, ctx, async (imap) => {
                await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                /* A date window if asked, else the last 30 days. SINCE is inclusive,
                   BEFORE is exclusive -- IMAP matches on the message's own date. */
                const span = [];
                if (since) span.push(`SINCE ${imapDate(since)}`);
                if (before) span.push(`BEFORE ${imapDate(before)}`);
                if (!span.length) span.push(`SINCE ${imapDate(new Date(Date.now() - SINCE_DAYS * 86_400_000))}`);
                const found = await imap.command(`UID SEARCH ${span.join(' ')}`, 'the mailbox could not be searched');
                const all = searchUids(found);
                const uids = all.slice(-LIST_MAX).reverse();
                const items = await brief(imap, uids);
                const empty = since || before ? 'No message in that range.' : 'No message in the last 30 days.';
                /* Never cap in silence: if the window held more, say so and how to move it. */
                const more = all.length > LIST_MAX ? `\n\n(Showing the ${LIST_MAX} most recent of ${all.length} in this window — use since/before to move it.)` : '';
                const text = items.length ? items.join('\n') + more : empty;
                return { text, size: Buffer.byteLength(text) };
            });
        },
        /* One message in full (headers and body), by its uid. */
        async 'mail.read'(target, a, ctx) {
            if (isGraph(target)) return gmail.read(target, a, ctx);
            const uid = Number(a.uid);
            if (!Number.isInteger(uid) || uid <= 0) no('read needs the message number (uid)');
            return withImap(target, ctx, async (imap) => {
                await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${READ_MAX}>)`, 'that message could not be read');
                const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
                const cut = fetched.indexOf('\n');
                if (cut < 0) no('no such message');
                const raw = fetched.slice(cut + 1).replace(/\)\s*$/, '');
                const text = renderMessage(raw);
                /* The fetch is bounded; if it filled, say the message was longer. */
                const cut2 = Buffer.byteLength(raw) >= READ_MAX ? `\n\n(Large message — showing the first ${Math.round(READ_MAX / 1024)} KB.)` : '';
                return { text: text + cut2, size: Buffer.byteLength(text + cut2) };
            });
        },
        /* The raw source of a message: every header, both bodies (text and HTML),
           attachments inline -- everything, for when the readable view is not enough. */
        async 'mail.source'(target, a, ctx) {
            if (isGraph(target)) return gmail.source(target, a, ctx);
            const uid = numUid(a.uid);
            return withImap(target, ctx, async (imap) => {
                await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${SOURCE_MAX}>)`, 'that message could not be read');
                const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
                const cut = fetched.indexOf('\n'); if (cut < 0) no('no such message');
                const raw = fetched.slice(cut + 1).replace(/\)\s*$/, '');
                const more = Buffer.byteLength(raw) >= SOURCE_MAX ? `\n\n(Large message — first ${Math.round(SOURCE_MAX / 1024)} KB of the source.)` : '';
                return { text: raw + more, size: Buffer.byteLength(raw) };
            });
        },
        /* One attachment's bytes (base64), by its file name (or its 1-based number). */
        async 'mail.attachment'(target, a, ctx) {
            if (isGraph(target)) return gmail.attachment(target, a, ctx);
            const uid = numUid(a.uid);
            const which = String(a.which ?? '').trim();
            return withImap(target, ctx, async (imap) => {
                await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${SOURCE_MAX}>)`, 'that message could not be read');
                const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
                const cut = fetched.indexOf('\n'); if (cut < 0) no('no such message');
                const raw = fetched.slice(cut + 1).replace(/\)\s*$/, '');
                const atts = attachmentsOf(raw);
                if (!atts.length) no('this message has no attachment');
                const n = /^\d+$/.test(which) ? Number(which) - 1 : atts.findIndex((x) => x.name.toLowerCase().includes(which.toLowerCase()));
                const att = atts[n];
                if (!att) no(`no attachment "${which}" — this message has: ${atts.map((x) => x.name).join(', ')}`);
                const bytes = decodeBytes(att.headers, att.body);
                const partial = Buffer.byteLength(raw) >= SOURCE_MAX ? ' — the message was large, these bytes may be partial' : '';
                const text = `${att.name} (${att.type}, ${Math.round(bytes.length / 1024)} KB)${partial}\n\n${bytes.toString('base64')}`;
                return { text, size: Buffer.byteLength(text) };
            });
        },
        /* The messages whose text matches, briefly. */
        async 'mail.search'(target, a, ctx) {
            if (isGraph(target)) return gmail.search(target, a, ctx);
            return withImap(target, ctx, async (imap) => {
                await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const found = await imap.command(`UID SEARCH TEXT ${quoted(a.text)}`, 'the mailbox could not be searched');
                const uids = searchUids(found).slice(-LIST_MAX).reverse();
                const items = await brief(imap, uids);
                const text = items.length ? items.join('\n') : 'Nothing found.';
                return { text, size: Buffer.byteLength(text) };
            });
        },
        /* Move a message to another folder. An act: the mailbox is opened read-write. */
        async 'mail.move'(target, a, ctx) {
            if (isGraph(target)) return gmail.move(target, a, ctx);
            const uid = numUid(a.uid);
            return withImap(target, ctx, async (imap) => {
                /* The uid is the one of the folder it was listed in (from): another folder's same number is another message. */
                await imap.command(`SELECT ${quoted(boxOf(target, a.from))}`, 'that mailbox could not be opened');
                await mustHave(imap, uid, boxOf(target, a.from));
                /* A server without MOVE (RFC 6851; older Dovecot, Exchange 2010...): COPY, then that one uid expunged, as delete does. */
                const caps = (await imap.command('CAPABILITY', 'the server capabilities could not be read')).find((l) => /^\* CAPABILITY/i.test(l)) ?? '';
                let said;
                if (/\sMOVE(\s|$)/i.test(caps)) said = await imap.command(`UID MOVE ${uid} ${quoted(String(a.mailbox))}`, 'that message could not be moved (the destination folder may not exist)');
                else {
                    said = await imap.command(`UID COPY ${uid} ${quoted(String(a.mailbox))}`, 'that message could not be moved (the destination folder may not exist)');
                    await imap.command(`UID STORE ${uid} +FLAGS (\\Deleted)`, 'that message was copied but could not be removed from its folder');
                    await imap.command(`UID EXPUNGE ${uid}`, 'that message was copied but could not be removed from its folder');
                }
                /* Its number in the new folder (COPYUID, RFC 4315) is told: the old one names another message there (loop 8). */
                const there = /\[COPYUID \d+ \S+ (\d+)\]/i.exec(said.join('\n'))?.[1];
                return { text: `Moved #${uid} to ${a.mailbox}; ${there ? `there it is #${there} (mailbox ${a.mailbox})` : `there it has another number: list ${a.mailbox} to act on it`}.`, size: 0 };
            }, { write: true });
        },
        /* Mark a message read/unread or flagged/unflagged. */
        async 'mail.flag'(target, a, ctx) {
            if (isGraph(target)) return gmail.flag(target, a, ctx);
            const uid = numUid(a.uid);
            const { op, flag } = flagOf(a.flag);
            return withImap(target, ctx, async (imap) => {
                await imap.command(`SELECT ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                await mustHave(imap, uid, boxOf(target, a.mailbox));
                await imap.command(`UID STORE ${uid} ${op}FLAGS (${flag})`, 'that message could not be marked');
                return { text: `Marked #${uid} ${String(a.flag).toLowerCase().trim()}.`, size: 0 };
            });
        },
        /* Delete a message. An act. Over IMAP it goes to the Trash folder (the one the server marks \Trash):
           UID MOVE when the server has MOVE, else UID COPY there, then \Deleted and UID EXPUNGE of that one uid.
           A message already in Trash is deleted for good, and the result says so. Gmail: moved to its Trash
           (an expunge from INBOX would only archive it). Over Graph, DELETE moves it to Deleted Items. */
        async 'mail.delete'(target, a, ctx) {
            if (isGraph(target)) return gmail.remove(target, a, ctx);
            const uid = numUid(a.uid);
            return withImap(target, ctx, async (imap) => {
                const box = boxOf(target, a.mailbox);
                const trash = await trashOf(imap);
                await imap.command(`SELECT ${quoted(box)}`, 'that mailbox could not be opened');
                await mustHave(imap, uid, box);
                if (trash.name.toLowerCase() === box.toLowerCase()) {
                    await imap.command(`UID STORE ${uid} +FLAGS (\\Deleted)`, 'that message could not be deleted');
                    await imap.command(`UID EXPUNGE ${uid}`, `that message was marked deleted, but could not be removed now: the next clean-up of ${trash.shown} by any mail program removes it for good`);
                    return { text: `Deleted #${uid} for good: it was already in ${trash.shown}, so it cannot be restored.`, size: 0 };
                }
                const caps = (await imap.command('CAPABILITY', 'the server capabilities could not be read')).find((l) => /^\* CAPABILITY/i.test(l)) ?? '';
                if (/\sMOVE(\s|$)/i.test(caps)) {
                    await imap.command(`UID MOVE ${uid} ${quoted(trash.name)}`, 'that message could not be moved to the Trash');
                } else {
                    await imap.command(`UID COPY ${uid} ${quoted(trash.name)}`, 'that message could not be copied to the Trash');
                    await imap.command(`UID STORE ${uid} +FLAGS (\\Deleted)`, 'that message was copied to the Trash but could not be removed from its folder');
                    await imap.command(`UID EXPUNGE ${uid}`, 'that message was copied to the Trash but could not be removed from its folder');
                }
                return { text: `Deleted #${uid}: moved to ${trash.shown}${trash.made ? ' (made, there was none)' : ''}, where it can be restored.`, size: 0 };
            }, { write: true });
        },
        /* Send a message. A provider signs in to SMTP with XOAUTH2; a classic box with
           LOGIN on its SMTP server. The message is built from the fields -- nothing an
           agent wrote becomes a header or a command. With draft, it is kept in the
           Drafts folder instead, for a person to look at and send. */
        async 'mail.send'(target, a, ctx) {
            if (isGraph(target)) return graphSent(target, ctx, await gmail.send(target, a, ctx));
            const to = listOf(a.to);
            if (!to.length) no('send needs a recipient (to)');
            return deliver(target, ctx, a, { to, cc: listOf(a.cc), bcc: listOf(a.bcc), subject: a.subject, ...words(target, a), attachments: added(a) });
        },
        /* Reply to a message, in its thread: to its sender (Reply-To first), or with
           all, also to everyone it went to but this mailbox. The original is quoted
           under the answer. Files of the original are not sent back; new ones may be. */
        async 'mail.reply'(target, a, ctx) {
            if (isGraph(target)) return graphSent(target, ctx, await gmail.reply(target, a, ctx));
            const user = userOf(target).toLowerCase();
            const o = await original(target, ctx, a, READ_MAX);
            const self = (x) => x === user;
            let to = emailsOf(o.replyTo || o.from);
            if (to.every(self)) to = emailsOf(o.to);   /* a reply to one's own sent message */
            let cc = [];
            if (a.all === true || a.all === 'true') {
                cc = [...emailsOf(o.to), ...emailsOf(o.cc)].filter((x) => !self(x) && !to.includes(x));
            }
            to = to.filter((x) => !self(x));
            cc = [...new Set([...cc, ...listOf(a.cc).map((x) => x.toLowerCase())])].filter((x) => !to.includes(x));
            if (!to.length) no('the original has no sender to reply to');
            const thread = { inReplyTo: o.messageId, references: [o.references, o.messageId].filter(Boolean).join(' ') };
            return deliver(target, ctx, a, { to, cc, bcc: listOf(a.bcc), subject: replySubject(o.subject), ...words(target, a, quoteReply(o, langOf(target))), attachments: added(a), ...thread });
        },
        /* Forward a message: the note, then the original's headers and text, and its
           files -- all of them by default, none with keep "none", or some by name.
           Too large to carry whole: refused, never forwarded with files missing. */
        async 'mail.forward'(target, a, ctx) {
            if (isGraph(target)) return graphSent(target, ctx, await gmail.forward(target, a, ctx));
            const to = listOf(a.to);
            if (!to.length) no('forward needs a recipient (to)');
            const none = /^(none|false|no)$/i.test(String(a.keep ?? '').trim());
            const o = await original(target, ctx, a, none ? READ_MAX : FORWARD_MAX);
            const files = keptFiles(o.files, a.keep).map((f) => ({ name: f.name, type: f.type, bytes: decodeBytes(f.headers, f.body).toString('base64') }));
            return deliver(target, ctx, a, { to, cc: listOf(a.cc), bcc: listOf(a.bcc), subject: forwardSubject(o.subject), ...words(target, a, quoteForward(o, langOf(target))), attachments: [...files, ...added(a)] });
        },
    };

    /* What a waiting act is about, for the card a person approves from: the message
       answered, forwarded, moved or deleted -- who sent it, its subject, when. A read. */
    async function describe(verb, target, a, ctx) {
        if (!a.uid || !['mail.reply', 'mail.forward', 'mail.move', 'mail.flag', 'mail.delete'].includes(verb)) return null;
        if (isGraph(target)) return gmail.about(target, a, ctx);
        const uid = numUid(a.uid);
        return withImap(target, ctx, async (imap) => {
            await imap.command(`EXAMINE ${quoted(boxOf(target, verb === 'mail.move' ? a.from : a.mailbox))}`, 'that mailbox could not be opened');
            const lines = await imap.command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`, 'that message could not be read');
            const l = lines.find((x) => /^\* \d+ FETCH/i.test(x)) ?? '';
            const block = l.slice(l.indexOf('\n') + 1);
            return { from: decodeWords(headerOf(block, 'From')), subject: decodeWords(headerOf(block, 'Subject')), date: headerOf(block, 'Date') };
        });
    }

    return {
        name: 'mail',
        verbs: Object.keys(verbs),
        describe,
        /* The keeper's hand, for messages sent later: its store folder, a target by
           id, a ctx for its secrets, the journal, the clock, who is stopped. */
        wake(h) {
            host = { now: () => Date.now(), stopped: () => false, note: () => {}, ...h };
            try { later = JSON.parse(readFileSync(laterFile(), 'utf8')); if (!Array.isArray(later)) later = []; } catch { later = []; }
            try { sent = JSON.parse(readFileSync(sentFile(), 'utf8')); if (!Array.isArray(sent)) sent = []; } catch { sent = []; }
        },
        watched: () => sent.map((r) => ({ ...r })),
        tick,
        later: () => later.map((r) => ({ ...r })),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        close() { tokens.clear(); for (const id of [...sessions.keys()]) drop(id); },
        shutdown() { tokens.clear(); for (const id of [...sessions.keys()]) drop(id); },
    };
}
