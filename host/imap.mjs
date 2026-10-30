/* THE FEW WORDS OF IMAP THE MAIL CONNECTOR SPEAKS. A small, dependency-free client
 * over a TLS socket: greet, authenticate (XOAUTH2 or LOGIN), then tagged commands.
 * The connector decides which commands to send -- reads (EXAMINE, UID SEARCH,
 * BODY.PEEK) at level watch, and the acts (UID MOVE, UID STORE) only above it.
 *
 * On any failure a plain Error is thrown with a short message; the connector turns
 * it into a Refused. Nothing here holds a secret: the caller passes the token. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* A string as IMAP wants it quoted: backslash and double quote escaped, a line
   break refused (it would end the command and start another). */
export function quoted(text) {
    if (/[\r\n\0]/.test(text)) throw new Error('a value cannot contain a line break');
    return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
export const imapDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

export class Exchange {
    #socket; #buffer = Buffer.alloc(0); #received = 0; #wake = null; #failure = null; #n = 0; #max; #idleMs;
    /* `bytesMax`: what the whole conversation may receive, and no more. `idleMs`: how
       long to wait for the next bytes before giving up -- so a server that connects
       but never answers (a dropped route, a stuck TLS) fails cleanly instead of
       hanging the keeper forever. */
    constructor(socket, bytesMax, idleMs = 20_000) {
        this.#max = bytesMax;
        this.#idleMs = idleMs;
        this.#socket = socket;
        socket.on('data', (bytes) => {
            this.#received += bytes.length;
            if (this.#received > this.#max) return this.#fail(new Error('the mailbox sent more than expected'));
            this.#buffer = Buffer.concat([this.#buffer, bytes]);
            this.#wake?.();
            return undefined;
        });
        socket.on('error', () => this.#fail(new Error('the mailbox cannot be reached')));
        socket.on('close', () => this.#fail(new Error('the mailbox closed the connection')));
    }
    #fail(error) { this.#failure ??= error; this.#wake?.(); }
    /* Lines up to the one `done` accepts; a literal {n} is taken whole. */
    async #until(done) {
        for (;;) {
            let i = 0; let current = ''; const lines = [];
            while (i < this.#buffer.length) {
                const end = this.#buffer.indexOf('\r\n', i);
                if (end < 0) break;
                const piece = this.#buffer.subarray(i, end).toString('utf8');
                i = end + 2;
                const literal = /\{(\d+)\}$/.exec(piece);
                if (literal) {
                    const n = Number(literal[1]);
                    if (this.#buffer.length < i + n) { i = -1; break; }
                    current += `${piece}\n${this.#buffer.subarray(i, i + n).toString('utf8')}`;
                    i += n;
                    continue;
                }
                current += piece;
                lines.push(current);
                if (done(current)) { this.#buffer = this.#buffer.subarray(i); return lines; }
                current = '';
            }
            if (this.#failure) throw this.#failure;
            await new Promise((resolve) => {
                const timer = setTimeout(() => { this.#wake = null; this.#fail(new Error('the mailbox did not answer in time')); resolve(); }, this.#idleMs);
                timer.unref?.();
                this.#wake = () => { this.#wake = null; clearTimeout(timer); resolve(); };
            });
        }
    }
    async greeting() {
        const [line] = await this.#until((l) => l.startsWith('* '));
        if (!/^\* (OK|PREAUTH)/i.test(line ?? '')) throw new Error('not an IMAP server (no greeting)');
    }
    async command(text, failure) {
        const tag = `c${++this.#n}`;
        this.#socket.write(`${tag} ${text}\r\n`);
        const lines = await this.#until((l) => l.startsWith(`${tag} `));
        if (!new RegExp(`^${tag} OK`, 'i').test(lines.at(-1) ?? '')) throw new Error(failure);
        return lines;
    }
    /* APPEND a whole message to a folder (a draft): the command announces the
       literal's size, the server answers "+" when ready, then the bytes go. */
    async append(box, flags, message, failure) {
        const tag = `c${++this.#n}`;
        const bytes = Buffer.from(message, 'utf8');
        this.#socket.write(`${tag} APPEND ${quoted(box)} (${flags}) {${bytes.length}}\r\n`);
        let lines = await this.#until((l) => l.startsWith(`${tag} `) || l.startsWith('+'));
        if ((lines.at(-1) ?? '').startsWith('+')) {
            this.#socket.write(Buffer.concat([bytes, Buffer.from('\r\n')]));
            lines = await this.#until((l) => l.startsWith(`${tag} `));
        }
        if (!new RegExp(`^${tag} OK`, 'i').test(lines.at(-1) ?? '')) throw new Error(failure);
        return lines;
    }
    /* AUTHENTICATE XOAUTH2 with the base64 SASL response inline (initial response,
       which Gmail and Outlook accept). On failure the server first sends a `+ <error>`
       challenge and waits for an empty line before the tagged NO, so we finish that
       exchange rather than hang, then surface the refusal. */
    async authenticateXoauth2(initial, failure) {
        const tag = `c${++this.#n}`;
        this.#socket.write(`${tag} AUTHENTICATE XOAUTH2 ${initial}\r\n`);
        let lines = await this.#until((l) => l.startsWith(`${tag} `) || l.startsWith('+ '));
        if ((lines.at(-1) ?? '').startsWith('+ ')) {
            this.#socket.write('\r\n');
            lines = await this.#until((l) => l.startsWith(`${tag} `));
        }
        if (!new RegExp(`^${tag} OK`, 'i').test(lines.at(-1) ?? '')) throw new Error(failure);
        return lines;
    }
}
