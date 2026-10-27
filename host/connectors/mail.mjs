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
 *
 * Reads (level watch): mail.list, mail.read, mail.search. Acts (above watch):
 * mail.send, mail.move, mail.flag -- added next. `fetch` and `connect` are injected
 * for tests. Inspired by the open-source Google/Microsoft MCP servers (all MIT), the
 * verbs reimplemented here so the token stays host-side and the levels gate them.
 */
import { connect as tlsConnect } from 'node:tls';
import { no, Refused } from '../../server/verbs.mjs';
import { refreshAccess, thunderbird, xoauth2, PROVIDERS } from '../oauth.mjs';
import { Exchange, quoted, imapDate } from '../imap.mjs';

const IMAP_HOST = { google: 'imap.gmail.com', microsoft: 'outlook.office365.com' };
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

export function mail({ fetch: fetchImpl = globalThis.fetch, connect = tlsConnect } = {}) {
    const tokens = new Map(); // target.id -> { value, exp }

    const providerOf = (target) => { const p = String(target.config?.provider ?? ''); if (!IMAP_HOST[p] || !PROVIDERS[p]) no(`${target.title}: set its provider to google or microsoft`); return p; };
    const userOf = (target) => { const u = String(target.config?.user ?? '').trim(); if (!u) no(`${target.title}: set its email address`); return u; };
    const boxOf = (target, given) => {
        const name = String(given ?? target.config?.mailbox ?? 'INBOX').trim() || 'INBOX';
        if (/[\r\n\0]/.test(name)) no('a mailbox name cannot contain a line break');
        return name;
    };

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

    /* Open an authenticated IMAP session; the caller closes it in a finally. */
    async function open(target, ctx) {
        const provider = providerOf(target);
        const user = userOf(target);
        const token = await access(target, ctx);
        let socket;
        try { socket = connect({ host: IMAP_HOST[provider], port: PORT, servername: IMAP_HOST[provider] }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: cannot reach the mail server`); }
        const imap = new Exchange(socket, SESSION_MAX);
        try {
            await imap.greeting();
            await imap.authenticateXoauth2(xoauth2(user, token), `${target.title}: the mailbox refused the token -- reconnect the account`);
        } catch (e) { try { socket.destroy(); } catch { /* closing */ } if (e instanceof Refused) throw e; no(`${target.title}: ${e?.message ?? 'the mailbox could not be opened'}`); }
        return { imap, socket, user };
    }
    const close = async (s) => { try { await s.imap.command('LOGOUT', 'x'); } catch { /* done */ } try { s.socket.destroy(); } catch { /* closed */ } };

    const searchUids = (lines) => (lines.find((l) => /^\* SEARCH/i.test(l)) ?? '').split(' ').slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);

    async function brief(imap, uids) {
        const out = [];
        for (const uid of uids) {
            const lines = await imap.command(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`, 'a message could not be read');
            const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
            const cut = fetched.indexOf('\n');
            const block = cut >= 0 ? fetched.slice(cut + 1) : '';
            const when = /INTERNALDATE "([^"]+)"/i.exec(fetched)?.[1] ?? headerOf(block, 'Date');
            out.push(`#${uid}  ${when}\n  From: ${headerOf(block, 'From')}\n  Subject: ${headerOf(block, 'Subject')}`);
        }
        return out;
    }

    const verbs = {
        /* The recent messages of a mailbox: who, subject, when -- newest first. */
        async 'mail.list'(target, a, ctx) {
            const s = await open(target, ctx);
            try {
                await s.imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
                const found = await s.imap.command(`UID SEARCH SINCE ${imapDate(since)}`, 'the mailbox could not be searched');
                const uids = searchUids(found).slice(-LIST_MAX).reverse();
                const items = await brief(s.imap, uids);
                const text = items.length ? items.join('\n') : 'No message in the last 30 days.';
                return { text, size: Buffer.byteLength(text) };
            } finally { await close(s); }
        },
        /* One message in full (headers and body), by its uid. */
        async 'mail.read'(target, a, ctx) {
            const uid = Number(a.uid);
            if (!Number.isInteger(uid) || uid <= 0) no('read needs the message number (uid)');
            const s = await open(target, ctx);
            try {
                await s.imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const lines = await s.imap.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${READ_MAX}>)`, 'that message could not be read');
                const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
                const cut = fetched.indexOf('\n');
                if (cut < 0) no('no such message');
                const raw = fetched.slice(cut + 1).replace(/\)\s*$/, '');
                return { text: raw, size: Buffer.byteLength(raw) };
            } finally { await close(s); }
        },
        /* The messages whose text matches, briefly. */
        async 'mail.search'(target, a, ctx) {
            const s = await open(target, ctx);
            try {
                await s.imap.command(`EXAMINE ${quoted(boxOf(target, a.mailbox))}`, 'that mailbox could not be opened');
                const found = await s.imap.command(`UID SEARCH TEXT ${quoted(a.text)}`, 'the mailbox could not be searched');
                const uids = searchUids(found).slice(-LIST_MAX).reverse();
                const items = await brief(s.imap, uids);
                const text = items.length ? items.join('\n') : 'Nothing found.';
                return { text, size: Buffer.byteLength(text) };
            } finally { await close(s); }
        },
    };

    return {
        name: 'mail',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        close() { tokens.clear(); },
        shutdown() { tokens.clear(); },
    };
}
