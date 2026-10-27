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
 *
 * Reads (level watch): mail.list, mail.read, mail.search. Acts (above watch):
 * mail.move, mail.flag; mail.send (SMTP) follows. `fetch` and `connect` are injected
 * for tests. Inspired by the open-source Google/Microsoft MCP servers (all MIT), the
 * verbs reimplemented here so the token stays host-side and the levels gate them.
 */
import { connect as tlsConnect } from 'node:tls';
import { no, Refused } from '../../server/verbs.mjs';
import { refreshAccess, thunderbird, xoauth2, PROVIDERS } from '../oauth.mjs';
import { Exchange, quoted, imapDate } from '../imap.mjs';
import { send as smtpSend } from '../smtp.mjs';
import { graphMail } from './graphmail.mjs';

const IMAP_HOST = { google: 'imap.gmail.com', microsoft: 'outlook.office365.com' };
const SMTP_HOST = { google: 'smtp.gmail.com', microsoft: 'smtp.office365.com' };
const PORT = 993;
const LIST_MAX = 30;            /* messages a list returns at most */
const READ_MAX = 512 * 1024;    /* bytes of one message read at once */
const SESSION_MAX = 8 * 1024 * 1024; /* bytes a whole IMAP session may receive */
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
        const attach = out.attachments.length ? `\n\n--- Attachments (${out.attachments.length}) ---\n${out.attachments.map((a) => `  ${a.name} (${a.type}, ~${a.kb} KB)`).join('\n')}` : '';
        return `${head}\n\n${body.trim()}${attach}`.trim();
    } catch { return raw; }
}

const numUid = (u) => { const n = Number(u); if (!Number.isInteger(n) || n <= 0) no('that needs the message number (uid)'); return n; };
/* The marks a person may set, named by a plain word -- never a raw IMAP flag from
   the agent. Each maps to an add/remove and a system flag. */
const FLAGS = { read: ['+', '\\Seen'], seen: ['+', '\\Seen'], unread: ['-', '\\Seen'], unseen: ['-', '\\Seen'], flagged: ['+', '\\Flagged'], starred: ['+', '\\Flagged'], unflagged: ['-', '\\Flagged'] };
const flagOf = (f) => { const e = FLAGS[String(f ?? '').toLowerCase().trim()]; if (!e) no('flag is one of: read, unread, flagged, unflagged'); return { op: e[0], flag: e[1] }; };

export function mail({ fetch: fetchImpl = globalThis.fetch, connect = tlsConnect, smtpConnect, smtpSecure } = {}) {
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
    async function withImap(target, ctx, fn) {
        const id = target.id;
        const prev = queues.get(id) ?? Promise.resolve();
        let release; const mine = new Promise((r) => { release = r; });
        queues.set(id, prev.then(() => mine, () => mine));
        await prev.catch(() => { /* a prior verb's failure is its own */ });
        try {
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

    const verbs = {
        /* The recent messages of a mailbox: who, subject, when -- newest first. */
        async 'mail.list'(target, a, ctx) {
            if (isGraph(target)) return gmail.list(target, a, ctx);
            return withImap(target, ctx, async (imap) => {
                await imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
                const found = await imap.command(`UID SEARCH SINCE ${imapDate(since)}`, 'the mailbox could not be searched');
                const uids = searchUids(found).slice(-LIST_MAX).reverse();
                const items = await brief(imap, uids);
                const text = items.length ? items.join('\n') : 'No message in the last 30 days.';
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
                await imap.command(`SELECT ${quoted(boxOf(target))}`, 'that mailbox could not be opened');
                await imap.command(`UID MOVE ${uid} ${quoted(String(a.mailbox))}`, 'that message could not be moved (the destination folder may not exist)');
                return { text: `Moved #${uid} to ${a.mailbox}.`, size: 0 };
            });
        },
        /* Mark a message read/unread or flagged/unflagged. */
        async 'mail.flag'(target, a, ctx) {
            if (isGraph(target)) return gmail.flag(target, a, ctx);
            const uid = numUid(a.uid);
            const { op, flag } = flagOf(a.flag);
            return withImap(target, ctx, async (imap) => {
                await imap.command(`SELECT ${quoted(boxOf(target))}`, 'that mailbox could not be opened');
                await imap.command(`UID STORE ${uid} ${op}FLAGS (${flag})`, 'that message could not be marked');
                return { text: `Marked #${uid} ${String(a.flag).toLowerCase().trim()}.`, size: 0 };
            });
        },
        /* Send a message. A provider signs in to SMTP with XOAUTH2; a classic box with
           LOGIN on its SMTP server. The message is built from the fields -- nothing an
           agent wrote becomes a header or a command. */
        async 'mail.send'(target, a, ctx) {
            if (isGraph(target)) return gmail.send(target, a, ctx);
            const user = userOf(target);
            const to = String(a.to ?? '').split(',').map((x) => x.trim()).filter(Boolean);
            if (!to.length) no('send needs a recipient (to)');
            let host; let port = 587; let auth;
            if (isOAuth(target)) {
                host = SMTP_HOST[providerOf(target)];
                auth = { xoauth2: xoauth2(user, await access(target, ctx)) };
            } else {
                host = String(target.config?.smtpHost ?? '').trim().toLowerCase();
                if (!host || !host.includes('.')) no(`${target.title}: set its SMTP server (smtpHost) to send`);
                const password = await ctx.secret('password');
                if (!password) no(`${target.title}: its password is empty`);
                auth = { user, password };
            }
            if (Number(target.config?.smtpPort) > 0) port = Number(target.config.smtpPort);
            let sent;
            try {
                sent = await smtpSend({ host, port, auth, from: user, to, subject: a.subject, body: a.body, attach: a.attach, attachName: a.attachName,
                    ...(smtpConnect ? { connect: smtpConnect } : {}), ...(smtpSecure ? { secure: smtpSecure } : {}) });
            } catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: ${e?.message ?? 'the message could not be sent'}`); }
            return { text: `Sent to ${sent.join(', ')}${a.attach ? ` with ${a.attachName || 'an attachment'}` : ''}.`, size: 0 };
        },
    };

    return {
        name: 'mail',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        close() { tokens.clear(); for (const id of [...sessions.keys()]) drop(id); },
        shutdown() { tokens.clear(); for (const id of [...sessions.keys()]) drop(id); },
    };
}
