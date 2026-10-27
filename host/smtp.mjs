/* THE FEW WORDS OF SMTP, to send one message. A small, dependency-free client:
 * greet, EHLO, STARTTLS (then the socket is secure), authenticate (XOAUTH2 or
 * LOGIN), MAIL FROM / RCPT TO / DATA. The token or password is the host's; the
 * message is built here from plain fields, so nothing an agent wrote becomes a
 * header of its own. `connect` (plain) and `secure` (the TLS upgrade) are injected
 * for tests. On any failure a plain Error is thrown with a short message. */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const REPLY_MAX = 256 * 1024;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/* One address, checked: no line break (it would inject a command or a header), a
   single '@', and something either side. Returned trimmed. */
export function address(a) {
    const s = String(a ?? '').trim();
    if (!s || /[\r\n\0<>]/.test(s) || s.length > 320) throw new Error(`not a usable address: ${s.slice(0, 40)}`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error(`not a usable address: ${s.slice(0, 40)}`);
    return s;
}

/* An RFC-822 message from plain fields; headers come only from here. With an
   `attach` (base64 bytes) + `attachName`, a multipart/mixed message: the text and
   then the file, so a message can carry one joined file. */
export function buildMessage({ from, to, subject, body, attach, attachName, date = new Date() }) {
    const header = (name, value) => `${name}: ${String(value).replace(/[\r\n]+/g, ' ').trim()}`;
    const top = [header('From', from), header('To', to.join(', ')), header('Subject', subject ?? ''), header('Date', date.toUTCString()), 'MIME-Version: 1.0'];
    const text = String(body ?? '').replace(/\r?\n/g, '\r\n');
    if (attach) {
        const name = String(attachName || 'attachment').replace(/[\r\n"\\]/g, '');
        const b = `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        const b64 = String(attach).replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n');
        return [...top,
            `Content-Type: multipart/mixed; boundary="${b}"`, '',
            `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text,
            `--${b}`, `Content-Type: application/octet-stream; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', b64,
            `--${b}--`, ''].join('\r\n');
    }
    const lines = [...top, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text];
    return lines.join('\r\n');
}

class Line {
    #socket; #buffer = Buffer.alloc(0); #wake = null; #failure = null;
    constructor(socket) { this.attach(socket); }
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
    async reply() {
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
            await new Promise((r) => { this.#wake = () => { this.#wake = null; r(); }; });
        }
    }
}

/* Send one message. `auth` is { xoauth2 } for a provider, or { user, password } for
   a classic box. `connect` opens the plain socket, `secure` upgrades it after
   STARTTLS (tls.connect wrapping the same socket). */
export async function send({ host, port = 587, auth, from, to, subject, body, attach, attachName, connect = netConnect, secure = (opts) => tlsConnect(opts) }) {
    const sender = address(from);
    const rcpts = (Array.isArray(to) ? to : [to]).map(address);
    if (!rcpts.length) throw new Error('no recipient');
    const plain = connect({ host, port });
    const io = new Line(plain);
    const step = async (cmd, code) => { if (cmd !== null) io.write(`${cmd}\r\n`); const r = await io.reply(); if (r.code !== code) throw new Error(`${(cmd ?? 'server').split(' ')[0]} refused: ${r.lines.at(-1) || r.code}`); return r; };
    try {
        await step(null, 220);
        await step('EHLO tether', 250);
        await step('STARTTLS', 220);
        io.attach(secure({ socket: plain, servername: host }));
        await step('EHLO tether', 250);
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
        for (const r of rcpts) await step(`RCPT TO:<${r}>`, 250);
        await step('DATA', 354);
        const message = buildMessage({ from: sender, to: rcpts, subject, body, attach, attachName })
            .split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n'); /* dot-stuffing */
        io.write(`${message}\r\n.\r\n`);
        const done = await io.reply();
        if (done.code !== 250) throw new Error(`the message was not accepted: ${done.lines.at(-1) || done.code}`);
        try { io.write('QUIT\r\n'); } catch { /* done */ }
        return rcpts;
    } finally { io.destroy(); }
}
