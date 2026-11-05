/* THE FEW WORDS OF SMTP, to send one message. A small, dependency-free client:
 * greet, EHLO, STARTTLS (then the socket is secure), authenticate (XOAUTH2 or
 * LOGIN), MAIL FROM / RCPT TO / DATA. The token or password is the host's; the
 * message is built here from plain fields, so nothing an agent wrote becomes a
 * header of its own. `connect` (plain) and `secure` (the TLS upgrade) are injected
 * for tests. On any failure a plain Error is thrown with a short message. */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const REPLY_MAX = 256 * 1024;
/* How long to wait for the server's next words: a server that connects but never answers
   (a dropped route, port 465 spoken to as plain text) fails cleanly, never hangs the keeper.
   After DATA, a server may scan a large message: it gets longer. */
const IDLE_MS = 30_000;
const DATA_MS = 120_000;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/* One address, checked: no line break (it would inject a command or a header), a
   single '@', and something either side. Returned trimmed. */
export function address(a) {
    const s = String(a ?? '').trim();
    if (!s || /[\r\n\0<>]/.test(s) || s.length > 320) throw new Error(`not a usable address: ${s.slice(0, 40)}`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error(`not a usable address: ${s.slice(0, 40)}`);
    return s;
}

/* Several files joined to a message, as {name, bytes(base64), type?}. Takes an
   `attachments` array, or a single `attach` + `attachName` (back-compat). */
export function joinedFiles({ attach, attachName, attachments } = {}) {
    const list = Array.isArray(attachments) ? attachments : (attach ? [{ name: attachName, bytes: attach }] : []);
    return list.map((f) => ({ name: String(f?.name || 'attachment').replace(/[\r\n"\\]/g, ''), bytes: String(f?.bytes ?? ''), type: f?.type })).filter((f) => f.bytes);
}

/* A file's type from its name, so a reader opens it as what it is; unknown is bytes. */
const TYPES = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
    ics: 'text/calendar', vcf: 'text/vcard', zip: 'application/zip', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', eml: 'message/rfc822' };
export function typeOf(name, given) {
    const g = String(given ?? '').trim().toLowerCase();
    if (/^[a-z]+\/[a-z0-9.+-]+$/.test(g)) return g;
    return TYPES[/\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase()] ?? 'application/octet-stream';
}

/* A header value with letters beyond ASCII, as RFC 2047 encoded words (UTF-8,
   base64), cut on whole characters so no word runs past the line limit. */
export function encodeWords(value) {
    const s = String(value ?? '');
    if (!/[^\x20-\x7e]/.test(s)) return s;
    const words = []; let chunk = '';
    for (const ch of s) {
        if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
        chunk += ch;
    }
    if (chunk) words.push(chunk);
    return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}
/* Text as quoted-printable: lines stay short whatever was written, accents survive. */
export function quotedPrintable(text) {
    return String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => {
        let out = ''; let len = 0;
        const bytes = Buffer.from(line, 'utf8');
        bytes.forEach((b, i) => {
            const last = i === bytes.length - 1;
            const piece = (b === 61 || b > 126 || (b < 32 && b !== 9) || (last && (b === 32 || b === 9))) ? `=${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b);
            if (len + piece.length > 75) { out += '=\r\n'; len = 0; }
            out += piece; len += piece.length;
        });
        return out;
    }).join('\r\n');
}
const boundary = () => `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const textPart = (type, text) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(text)].join('\r\n');
const filePart = (f) => {
    const ascii = !/[^\x20-\x7e]/.test(f.name);
    const name = ascii ? `"${f.name}"` : `"${encodeWords(f.name)}"`;
    const disp = ascii ? `filename="${f.name}"` : `filename="${encodeWords(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
    const b64 = f.bytes.replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n');
    return [`Content-Type: ${typeOf(f.name, f.type)}; name=${name}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; ${disp}`, '', b64].join('\r\n');
};
const multipart = (kind, parts) => { const b = boundary(); return `Content-Type: multipart/${kind}; boundary="${b}"\r\n\r\n${parts.map((p) => `--${b}\r\n${p}`).join('\r\n')}\r\n--${b}--\r\n`; };

/* An RFC-822 message from plain fields; headers come only from here. The text
   (`body`, or `text`) and an optional `html` make a multipart/alternative; with
   one or more joined files (`attachments`, or `attach`+`attachName`), a
   multipart/mixed message: the words, then each file with its own type. A reply
   carries `inReplyTo` and `references` so it lands in its thread. */
export function buildMessage({ from, to, cc = [], bcc = [], keepBcc = false, subject, body, text: given, html, attach, attachName, attachments, inReplyTo, references, messageId, date = new Date() }) {
    const header = (name, value) => `${name}: ${String(value).replace(/[\r\n]+/g, ' ').trim()}`;
    const top = [header('From', from), header('To', to.join(', '))];
    if (cc.length) top.push(header('Cc', cc.join(', ')));
    /* A draft keeps its hidden recipients (as mail programs do), so sending it later loses none; a sent message never carries them. */
    if (keepBcc && bcc.length) top.push(header('Bcc', bcc.join(', ')));
    top.push(header('Subject', encodeWords(String(subject ?? '').replace(/[\r\n]+/g, ' ').trim())), header('Date', date.toUTCString()));
    const id = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
    top.push(header('Message-ID', id(messageId) || `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${String(from).split('@')[1] || 'tether'}>`));
    if (id(inReplyTo)) top.push(header('In-Reply-To', id(inReplyTo)));
    if (id(references)) top.push(header('References', id(references)));
    top.push('MIME-Version: 1.0');
    const text = String(given ?? body ?? '');
    const words = html ? multipart('alternative', [textPart('text/plain', text), textPart('text/html', html)]) : textPart('text/plain', text);
    const files = joinedFiles({ attach, attachName, attachments });
    const content = files.length ? multipart('mixed', [words, ...files.map(filePart)]) : words;
    return `${top.join('\r\n')}\r\n${content}`;
}

class Line {
    #socket; #buffer = Buffer.alloc(0); #wake = null; #failure = null; #idleMs;
    constructor(socket, idleMs = IDLE_MS) { this.#idleMs = idleMs; this.attach(socket); }
    attach(socket) {
        this.#socket = socket; this.#buffer = Buffer.alloc(0);
        socket.on('data', (b) => { this.#buffer = Buffer.concat([this.#buffer, b]); if (this.#buffer.length > REPLY_MAX) this.#fail(new Error('the mail server sent too much')); this.#wake?.(); });
        socket.on('error', () => this.#fail(new Error('the mail server cannot be reached')));
        socket.on('close', () => this.#fail(new Error('the mail server closed the connection')));
    }
    #fail(e) { this.#failure ??= e; this.#wake?.(); }
    write(text) { this.#socket.write(text); }
    destroy() { try { this.#socket.destroy(); } catch { /* closing */ } }
    /* An SMTP reply: lines until one reads "NNN " (a space after the code, not "-"). */
    async reply(wait) {
        for (;;) {
            const text = this.#buffer.toString('utf8');
            const lines = text.split('\r\n');
            const idx = lines.findIndex((l) => /^\d{3} /.test(l));
            if (idx >= 0) {
                const used = Buffer.byteLength(lines.slice(0, idx + 1).join('\r\n') + '\r\n');
                this.#buffer = this.#buffer.subarray(used);
                return { code: Number(lines[idx].slice(0, 3)), lines: lines.slice(0, idx + 1) };
            }
            if (this.#failure) throw this.#failure;
            await new Promise((r) => {
                const timer = setTimeout(() => { this.#wake = null; this.#fail(new Error('the mail server did not answer in time')); r(); }, wait ?? this.#idleMs);
                timer.unref?.();
                this.#wake = () => { this.#wake = null; clearTimeout(timer); r(); };
            });
        }
    }
}
/* An SMTP refusal: 5xx is final (sending again changes nothing), 4xx is for now. */
const refusal = (text, code) => Object.assign(new Error(text), { code, permanent: code >= 500 && code < 600 });

/* Send one message. `auth` is { xoauth2 } for a provider, or { user, password } for
   a classic box. `connect` opens the plain socket, `secure` upgrades it after
   STARTTLS (tls.connect wrapping the same socket). */
export async function send({ host, port = 587, auth, from, to, cc = [], bcc = [], connect = netConnect, secure = (opts) => tlsConnect(opts), idleMs = IDLE_MS, dataMs = DATA_MS, ...fields }) {
    const sender = address(from);
    const list = (x) => (Array.isArray(x) ? x : [x]).filter(Boolean).map(address);
    const heads = list(to); const copies = list(cc); const hidden = list(bcc);
    /* Every address gets the message: To and Cc are in its headers, Bcc only here. */
    const rcpts = [...new Set([...heads, ...copies, ...hidden])];
    if (!heads.length) throw new Error('no recipient');
    /* Port 465 is TLS from the first byte (implicit TLS, RFC 8314: most classic hosts offer it);
       any other port starts plain and asks STARTTLS. Never a password over plain text. */
    const implicit = Number(port) === 465;
    const plain = implicit ? secure({ host, port, servername: host }) : connect({ host, port });
    const io = new Line(plain, idleMs);
    const step = async (cmd, codes) => {
        if (cmd !== null) io.write(`${cmd}\r\n`);
        const r = await io.reply();
        if (![codes].flat().includes(r.code)) throw refusal(`${(cmd ?? 'server').split(' ')[0]} refused: ${r.lines.at(-1) || r.code}`, r.code);
        return r;
    };
    try {
        await step(null, 220);
        await step('EHLO tether', 250);
        if (!implicit) {
            await step('STARTTLS', 220);
            io.attach(secure({ socket: plain, servername: host }));
            await step('EHLO tether', 250);
        }
        if (auth?.xoauth2) {
            io.write(`AUTH XOAUTH2 ${auth.xoauth2}\r\n`);
            let r = await io.reply();
            if (r.code === 334) { io.write('\r\n'); r = await io.reply(); } /* error challenge: finish it */
            if (r.code !== 235) throw new Error('the mailbox refused the token -- reconnect the account');
        } else {
            await step('AUTH LOGIN', 334);
            await step(b64(auth?.user ?? ''), 334);
            await step(b64(auth?.password ?? ''), 235);
        }
        await step(`MAIL FROM:<${sender}>`, 250);
        /* 251 "will forward" accepts too (RFC 5321). A refused address is named: nothing was sent. */
        for (const r of rcpts) {
            try { await step(`RCPT TO:<${r}>`, [250, 251]); }
            catch (e) { throw Object.assign(new Error(`${r} was refused (${String(e.message).replace(/^RCPT refused: /, '')}) -- nothing was sent`), { code: e.code, permanent: e.permanent }); }
        }
        await step('DATA', 354);
        /* A message already built (a scheduled one, kept until its time) goes as is. */
        const message = (fields.raw ? String(fields.raw).replace(/\r?\n/g, '\r\n') : buildMessage({ ...fields, from: sender, to: heads, cc: copies }))
            .split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n'); /* dot-stuffing */
        io.write(`${message}\r\n.\r\n`);
        let done;
        try { done = await io.reply(dataMs); }
        catch (e) { throw Object.assign(new Error(`the mail server took the message but did not confirm it (${e.message}): it may have been sent -- check before sending again`), { unsure: true }); }
        if (done.code !== 250) throw refusal(`the message was not accepted: ${done.lines.at(-1) || done.code}`, done.code);
        try { io.write('QUIT\r\n'); } catch { /* done */ }
        return rcpts;
    } finally { io.destroy(); }
}
