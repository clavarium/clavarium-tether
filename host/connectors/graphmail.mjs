/* MICROSOFT MAIL OVER GRAPH, for the mail connector's Microsoft path.
 *
 * The borrowed Microsoft client (Thunderbird's) takes Graph scopes: its token
 * reads mail, calendar and contacts over graph.microsoft.com. So a Microsoft
 * mailbox is
 * reached here over Graph REST, not IMAP -- the same six verbs the IMAP path
 * gives (list, read, search, move, flag, send), reimplemented host-side so the
 * token never leaves this process and the Tether levels gate the acts.
 *
 * `token(target, ctx)` mints a Graph access token from the target's refresh
 * token (the mail connector passes its own `access`). `fetch` is injected for
 * tests. Message ids are Graph's own opaque ids (long strings), used as the
 * "uid" for read/move/flag.
 */
import { no, asDate } from '../../server/verbs.mjs';
import { compose, keptFiles, listOf, sendAt, wallClock } from '../compose.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TZ = 'Europe/Paris';   /* answer in the person's timezone, not UTC */
const LIST_MAX = 30;
const TIMEOUT_MS = 60_000;
/* The subject of a returned mail, in the common languages (a report is also known by its sender). */
export const REPORT_SUBJECT = /undeliver|undelivered|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery (failed|subsystem)|non remis|(é|e)chec de (la )?(remise|distribution)|unzustellbar|no se pudo entregar|delivery delayed|remise diff(é|e)r(é|e)e/i;
const READ_MAX = 512 * 1024;
const SOURCE_MAX = 4 * 1024 * 1024;
/* Friendly folder words mapped to Graph's well-known names; anything else is
   passed through (a folder's own id or display name). */
const FOLDER = { inbox: 'inbox', sent: 'sentitems', 'sent items': 'sentitems', drafts: 'drafts', draft: 'drafts', trash: 'deleteditems', deleted: 'deleteditems', 'deleted items': 'deleteditems', junk: 'junkemail', spam: 'junkemail', archive: 'archive' };
const folderOf = (name) => { const n = String(name ?? '').trim(); if (!n) return 'inbox'; return FOLDER[n.toLowerCase()] ?? n; };

const addrsOf = (list) => (list ?? []).map((r) => r?.emailAddress?.address).filter(Boolean).join(', ');
const stripHtml = (html) => String(html ?? '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function graphMail({ fetch: fetchImpl = globalThis.fetch, token }) {
    async function call(target, ctx, method, path, body) {
        const access = await token(target, ctx);
        let r;
        /* Never waits for ever: a Graph that does not answer is said; an act may have happened then. */
        try {
            r = await fetchImpl(`${GRAPH}${path}`, {
                method,
                headers: { authorization: `Bearer ${access}`, prefer: `outlook.timezone="${TZ}"`, ...(body ? { 'content-type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (e) {
            no(`${target.title}: Microsoft did not answer${e?.name === 'TimeoutError' ? ' in time' : ''}${method === 'GET' ? '' : ' -- it may have been done: check before asking again'}`);
        }
        if (r.status === 401 || r.status === 403) no(`${target.title}: not authorized -- reconnect the account (the Microsoft mail scope may be missing)`);
        if (!r.ok) { let m = ''; try { m = (await r.json())?.error?.message ?? ''; } catch { /* no json */ } no(`${target.title}: ${m || `the mail request failed (${r.status})`}`); }
        /* Some acts answer with no body (sendMail is 202, a delete is 204): parse the
           body only if there is one, so a successful send is not a JSON-parse error. */
        const text = await r.text();
        return text ? JSON.parse(text) : null;
    }

    /* A folder named by a person ("Factures", "Clients/2026"): a well-known name passes, a long id
       passes, any other name is looked up by its display name, level by level. */
    async function folderId(target, ctx, name) {
        const f = folderOf(name);
        if (Object.values(FOLDER).includes(f) || f === 'outbox' || /^[A-Za-z0-9_=+/-]{60,}$/.test(f)) return f;
        let parent = null; let id = null;
        for (const part of f.split('/').map((x) => x.trim()).filter(Boolean)) {
            const base = parent ? `/me/mailFolders/${encodeURIComponent(parent)}/childFolders` : '/me/mailFolders';
            const data = await call(target, ctx, 'GET', `${base}?$top=200&$select=id,displayName`);
            const hit = (data?.value ?? []).find((x) => String(x.displayName ?? '').toLowerCase() === part.toLowerCase());
            if (!hit) no(`${target.title}: no folder "${f}"${parent ? '' : ` (folders: ${(data?.value ?? []).map((x) => x.displayName).join(', ')})`}`);
            parent = hit.id; id = hit.id;
        }
        return id ?? 'inbox';
    }

    const brief = (m) => `#${m.id}\n  ${m.receivedDateTime ?? ''}\n  From: ${addrsOf([m.from])}\n  Subject: ${m.subject ?? ''}`;

    return {
        async list(target, a, ctx) {
            const folder = folderOf(a.mailbox);
            /* An optional date window, filtered on the same property it is ordered
               by (Graph allows that): ge is inclusive, lt is exclusive. */
            const since = asDate(a.since, 'since');
            const before = asDate(a.before, 'before');
            const span = [];
            if (since) span.push(`receivedDateTime ge ${since.toISOString()}`);
            if (before) span.push(`receivedDateTime lt ${before.toISOString()}`);
            const filter = span.length ? `&$filter=${encodeURIComponent(span.join(' and '))}` : '';
            const data = await call(target, ctx, 'GET', `/me/mailFolders/${encodeURIComponent(await folderId(target, ctx, folder))}/messages?$top=${LIST_MAX}&$select=id,receivedDateTime,from,subject&$orderby=receivedDateTime%20desc${filter}`);
            const items = (data?.value ?? []).map(brief);
            /* Never cap in silence: Graph hands back a nextLink when more remain. */
            const more = data?.['@odata.nextLink'] ? `\n\n(Showing the first ${LIST_MAX} most recent — use since/before to move the window.)` : '';
            const text = items.length ? items.join('\n') + more : (since || before ? 'No message in that range.' : 'No message.');
            return { text, size: Buffer.byteLength(text) };
        },
        async read(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('read needs the message id (from the list)');
            const m = await call(target, ctx, 'GET', `/me/messages/${encodeURIComponent(id)}?$select=id,receivedDateTime,from,toRecipients,ccRecipients,subject,body,hasAttachments`);
            const bodyText = m?.body?.contentType === 'html' ? stripHtml(m.body.content) : (m?.body?.content ?? '');
            let att = '';
            if (m?.hasAttachments) {
                const at = await call(target, ctx, 'GET', `/me/messages/${encodeURIComponent(id)}/attachments?$select=name,contentType,size`);
                att = (at?.value ?? []).map((x) => `  - ${x.name} (${x.contentType}, ${Math.round((x.size || 0) / 1024)} KB)`).join('\n');
            }
            /* A meeting invitation's body is only the join link; the WHEN lives on the
               associated event. Best-effort: cast to eventMessage and read its event.
               A plain message is not castable (the call fails) -- then there is no invite. */
            let invite = '';
            try {
                const ev = await call(target, ctx, 'GET', `/me/messages/${encodeURIComponent(id)}/microsoft.graph.eventMessage/event?$select=subject,start,end,location`);
                if (ev?.start?.dateTime) {
                    const when = (t) => (t?.dateTime ? `${t.dateTime.slice(0, 16).replace('T', ' ')}${t.timeZone && t.timeZone !== 'UTC' ? ` ${t.timeZone}` : ''}` : '');
                    const loc = ev.location?.displayName;
                    invite = `\n\n--- Invitation ---\n  ${ev.subject || '(no title)'}\n  ${when(ev.start)}${ev.end?.dateTime ? ` — ${when(ev.end)}` : ''}${loc ? `\n  @ ${loc}` : ''}`;
                }
            } catch { /* not a meeting invitation */ }
            const head = [`From: ${addrsOf([m.from])}`, `To: ${addrsOf(m.toRecipients)}`, m?.ccRecipients?.length ? `Cc: ${addrsOf(m.ccRecipients)}` : '', `Date: ${m.receivedDateTime ?? ''}`, `Subject: ${m.subject ?? ''}`].filter(Boolean).join('\n');
            const full = `${head}\n\n${bodyText}${invite}${att ? `\n\nAttachments:\n${att}` : ''}`;
            const text = full.length > READ_MAX ? `${full.slice(0, READ_MAX)}\n\n(Large message — showing the first ${Math.round(READ_MAX / 1024)} KB.)` : full;
            return { text, size: Buffer.byteLength(text) };
        },
        async search(target, a, ctx) {
            const q = String(a.text ?? '').trim();
            if (!q) no('search needs some text');
            const data = await call(target, ctx, 'GET', `/me/messages?$search=${encodeURIComponent(`"${q}"`)}&$top=${LIST_MAX}&$select=id,receivedDateTime,from,subject`);
            const items = (data?.value ?? []).map(brief);
            const text = items.length ? items.join('\n') : 'Nothing found.';
            return { text, size: Buffer.byteLength(text) };
        },
        /* The raw MIME source ($value is not JSON, so it is fetched directly). */
        async source(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('source needs the message id');
            const access = await token(target, ctx);
            let r;
            try { r = await fetchImpl(`${GRAPH}/me/messages/${encodeURIComponent(id)}/$value`, { headers: { authorization: `Bearer ${access}` } }); }
            catch { return no(`${target.title}: could not reach the mailbox`); }
            if (r.status === 401 || r.status === 403) no(`${target.title}: not authorized -- reconnect the account (the Microsoft mail scope may be missing)`);
            if (r.status === 404) no('no such message');
            if (!r.ok) no(`${target.title}: the source could not be read (${r.status})`);
            const raw = (await r.text()).slice(0, SOURCE_MAX);
            const more = raw.length >= SOURCE_MAX ? `\n\n(Large message — first ${Math.round(SOURCE_MAX / 1024)} KB of the source.)` : '';
            return { text: raw + more, size: Buffer.byteLength(raw) };
        },
        /* One attachment's bytes (base64), by its name or its 1-based number. Graph
           hands a file attachment's contentBytes already base64-encoded. */
        async attachment(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            const which = String(a.which ?? '').trim();
            if (!id) no('attachment needs the message id');
            /* List without contentBytes: that property lives on a file attachment, not
               on the base attachment type, so $select-ing it on the mixed collection is
               what Graph rejected ("no property contentBytes on type ...attachment"). */
            const data = await call(target, ctx, 'GET', `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size`);
            const atts = (data?.value ?? []);
            if (!atts.length) no('this message has no attachment');
            const n = /^\d+$/.test(which) ? Number(which) - 1 : atts.findIndex((x) => (x.name || '').toLowerCase().includes(which.toLowerCase()));
            const att = atts[n];
            if (!att) no(`no attachment "${which}" — this message has: ${atts.map((x) => x.name).join(', ')}`);
            /* Fetch the chosen attachment in full for its bytes (a file attachment then
               carries contentBytes, already base64). */
            const full = await call(target, ctx, 'GET', `/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(att.id)}`);
            const bytes = full?.contentBytes;
            if (bytes === undefined || bytes === null) no(`"${att.name}" is not a downloadable file attachment (it may be a linked file or an attached item -- open the message source for it)`);
            const text = `${att.name} (${att.contentType || 'application/octet-stream'}, ${Math.round((att.size || 0) / 1024)} KB)\n\n${bytes}`;
            return { text, size: Buffer.byteLength(text) };
        },
        /* Graph DELETE moves the message to Deleted Items (a soft delete); one already there goes
           for good (to the recoverable items only an administrator reaches). Said either way, as IMAP. */
        async remove(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('delete needs the message id');
            let inTrash = false;
            try {
                const [m, bin] = await Promise.all([call(target, ctx, 'GET', `/me/messages/${encodeURIComponent(id)}?$select=parentFolderId`), call(target, ctx, 'GET', '/me/mailFolders/deleteditems?$select=id')]);
                inTrash = Boolean(m?.parentFolderId && bin?.id && m.parentFolderId === bin.id);
            } catch (e) { if (/no such|not found/i.test(e?.message ?? '')) throw e; inTrash = null; /* unknown: said so (loop 8) */ }
            await call(target, ctx, 'DELETE', `/me/messages/${encodeURIComponent(id)}`);
            if (inTrash === null) return { text: `Deleted ${id}: moved to Deleted Items, where it can be restored -- unless it was in Deleted Items already (that could not be checked), then it is gone for good.`, size: 0 };
            return { text: inTrash ? `Deleted ${id} for good: it was already in Deleted Items, so it cannot be restored.` : `Deleted ${id}: moved to Deleted Items, where it can be restored.`, size: 0 };
        },
        async move(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('move needs the message id');
            if (!String(a.mailbox ?? '').trim()) no('move needs a destination folder');
            const moved = await call(target, ctx, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: await folderId(target, ctx, a.mailbox) });
            /* Microsoft gives the moved message a new id: told, the old one names nothing now (loop 8). */
            return { text: `Moved ${id} to ${a.mailbox}${moved?.id && moved.id !== id ? `; its id is now ${moved.id}` : ''}.`, size: 0 };
        },
        async flag(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('flag needs the message id');
            const f = ({ seen: 'read', unseen: 'unread', starred: 'flagged' })[String(a.flag ?? '').toLowerCase().trim()] ?? String(a.flag ?? '').toLowerCase().trim();
            const body = f === 'read' ? { isRead: true } : f === 'unread' ? { isRead: false }
                : f === 'flagged' ? { flag: { flagStatus: 'flagged' } } : f === 'unflagged' ? { flag: { flagStatus: 'notFlagged' } }
                    : no('flag is read, unread, flagged or unflagged');
            await call(target, ctx, 'PATCH', `/me/messages/${encodeURIComponent(id)}`, body);
            return { text: `Marked ${id} ${f}.`, size: 0 };
        },
        /* Delivery reports in the inbox since a time, as raw MIME (read by the same reader as IMAP's):
           the ones from a postmaster or with a returned-mail subject. `known(id)`: already read. */
        async reports(target, ctx, since, known = () => false) {
            const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
            const data = await call(target, ctx, 'GET', `/me/mailFolders/inbox/messages?$top=50&$select=id,subject,from&$orderby=receivedDateTime%20desc&$filter=${filter}`);
            const out = [];
            for (const m of data?.value ?? []) {
                if (known(m.id)) continue;
                const who = String(m?.from?.emailAddress?.address ?? '');
                if (!/^(mailer-daemon|postmaster|microsoftexchange)/i.test(who) && !REPORT_SUBJECT.test(String(m.subject ?? ''))) { out.push({ id: m.id, raw: null }); continue; }
                const access = await token(target, ctx);
                const r = await fetchImpl(`${GRAPH}/me/messages/${encodeURIComponent(m.id)}/$value`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
                out.push({ id: m.id, raw: r.ok ? (await r.text()).slice(0, READ_MAX) : null });
            }
            return out;
        },
        /* What a message is, for an approval card: who, subject, when, its files' names. */
        async about(target, a, ctx) {
            const id = encodeURIComponent(String(a.uid ?? '').trim());
            const m = await call(target, ctx, 'GET', `/me/messages/${id}?$select=from,subject,receivedDateTime,hasAttachments`);
            let files;
            if (m?.hasAttachments) files = ((await call(target, ctx, 'GET', `/me/messages/${id}/attachments?$select=name,size`))?.value ?? []).map((x) => ({ name: x.name, kb: Math.max(1, Math.round((x.size || 0) / 1024)) }));
            const who = m?.from?.emailAddress;
            return { from: who ? (who.name && who.name !== who.address ? `${who.name} <${who.address}>` : who.address) : '', subject: m?.subject ?? '', date: m?.receivedDateTime ?? '', ...(files ? { files } : {}) };
        },
        /* Send a message (or, with draft, keep it in Drafts). The body is the
           composed HTML (Markdown) or the text as written. */
        async send(target, a, ctx) {
            const to = listOf(a.to);
            if (!to.length) no('send needs a recipient (to)');
            const files = filesOf(a);
            const at = later(a);
            const message = { subject: String(a.subject ?? ''), body: bodyOf(target, a), ...people(to, listOf(a.cc), listOf(a.bcc)),
                ...(files.length ? { attachments: files.map(fileOf) } : {}), ...deferred(at) };
            if (drafted(a)) {
                await call(target, ctx, 'POST', '/me/messages', message);
                return { text: `Draft saved in Drafts, to ${to.join(', ')}${withNames(files)} — not sent.`, size: 0 };
            }
            /* A mark of our own in the message's headers: a report that comes back carries it (a return is found by it). */
            const ref = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@tether>`;
            await call(target, ctx, 'POST', '/me/sendMail', { message: { ...message, internetMessageHeaders: [{ name: 'X-Tether-Ref', value: ref }] }, saveToSentItems: true });
            const watch = { id: ref, to: [...to, ...listOf(a.cc), ...listOf(a.bcc)], subject: message.subject, from: at?.getTime() };
            if (at) return { text: scheduled(at, to, withNames(files)), size: 0, watch };
            return { text: `Sent to ${to.join(', ')}${copies(listOf(a.cc))}${withNames(files)} (accepted by Microsoft).`, size: 0, watch };
        },
        /* Reply in the thread: Graph drafts the reply (its recipients, its quoted
           original), the answer is put above the quote, new files joined, then it
           is sent -- or left in Drafts. */
        async reply(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('reply needs the message id');
            const all = a.all === true || a.all === 'true';
            later(a);
            const d = await call(target, ctx, 'POST', `/me/messages/${encodeURIComponent(id)}/${all ? 'createReplyAll' : 'createReply'}`, {});
            const cc = [...(d?.ccRecipients ?? []).map((r) => r?.emailAddress?.address).filter(Boolean), ...listOf(a.cc)];
            return finish(target, ctx, a, d, { to: (d?.toRecipients ?? []).map((r) => r?.emailAddress?.address).filter(Boolean), cc, keepAll: true });
        },
        /* Forward: Graph drafts it with the original's files; those not kept are
           taken off, the note goes above, then it is sent -- or left in Drafts. */
        async forward(target, a, ctx) {
            const id = String(a.uid ?? '').trim();
            if (!id) no('forward needs the message id');
            const to = listOf(a.to);
            if (!to.length) no('forward needs a recipient (to)');
            later(a);
            const d = await call(target, ctx, 'POST', `/me/messages/${encodeURIComponent(id)}/createForward`, { toRecipients: to.map((address) => ({ emailAddress: { address } })) });
            return finish(target, ctx, a, d, { to, cc: listOf(a.cc), keep: a.keep });
        },
    };

    /* A drafted reply or forward, finished: files kept or taken off, the words
       above the quote, Cc/Bcc, new files, then sent unless a draft is asked. */
    async function finish(target, ctx, a, d, { to, cc, keep, keepAll }) {
        if (!d?.id) no(`${target.title}: the mailbox did not prepare the message`);
        const did = encodeURIComponent(d.id);
        let kept = [];
        /* Every step before the send: a failure removes the half-made draft, or says it is left (#18, loop 5). */
        const undo = async (e, what) => {
            const gone = await call(target, ctx, 'DELETE', `/me/messages/${did}`).then(() => true, () => false);
            no(`${e?.message ?? what} -- nothing was sent${gone ? '' : '; a half-made draft is left in Drafts'}`);
        };
        if (!keepAll) {
            let have;
            try { have = (await call(target, ctx, 'GET', `/me/messages/${did}/attachments?$select=id,name`))?.value ?? []; } catch (e) { await undo(e, 'the files could not be read'); }
            let keepList;
            try { keepList = keptFiles(have.map((x) => ({ ...x, name: x.name || '' })), keep); }
            catch (e) { await call(target, ctx, 'DELETE', `/me/messages/${did}`).catch(() => {}); throw e; }
            const ids = new Set(keepList.map((x) => x.id));
            try { for (const x of have) if (!ids.has(x.id)) await call(target, ctx, 'DELETE', `/me/messages/${did}/attachments/${encodeURIComponent(x.id)}`); } catch (e) { await undo(e, 'a file could not be taken off'); }
            kept = keepList.map((x) => x.name);
        }
        const mine = bodyOf(target, a);
        const theirs = d.body?.content ?? '';
        const html = mine.contentType === 'html' ? mine.content.replace(/^[\s\S]*?<body[^>]*>|<\/body>[\s\S]*$/gi, '') : esc(mine.content).replace(/\n/g, '<br>');
        const content = /<body[^>]*>/i.test(theirs) ? theirs.replace(/<body[^>]*>/i, (m) => `${m}${html}<br>`) : `${html}<br>${theirs}`;
        const at = later(a);
        const files = filesOf(a);
        /* A step that fails before the send leaves no half-made draft behind (#18): it is removed, or said. */
        try {
            await call(target, ctx, 'PATCH', `/me/messages/${did}`, { body: { contentType: 'html', content }, ...people(to, [...new Set(cc)], listOf(a.bcc)), ...deferred(at) });
            for (const f of files) await call(target, ctx, 'POST', `/me/messages/${did}/attachments`, fileOf(f));
        } catch (e) { await undo(e, 'the message could not be prepared'); }
        const names = [...kept, ...files.map((f) => f.name)];
        const joined = names.length ? ` with ${names.join(', ')}` : '';
        if (drafted(a)) return { text: `Draft saved in Drafts, to ${to.join(', ')}${joined} — not sent.`, size: 0 };
        /* The send refused: the prepared message stays in Drafts, and that is said (a send that timed out may have left: not removed). */
        try { await call(target, ctx, 'POST', `/me/messages/${did}/send`); }
        catch (e) { const unsure = /may have been done/.test(e?.message ?? ''); no(`${e?.message ?? 'the message was not sent'}${unsure ? '' : '; the prepared message is in Drafts'}`); }
        const watch = { id: d.internetMessageId || null, to: [...to, ...cc, ...listOf(a.bcc)], subject: d.subject ?? '', from: at?.getTime() };
        if (at) return { text: scheduled(at, to, joined), size: 0, watch };
        return { text: `Sent to ${to.join(', ')}${copies(cc)}${joined} (accepted by Microsoft).`, size: 0, watch };
    }
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const drafted = (a) => a.draft === true || a.draft === 'true';
/* Sent later: Exchange itself holds the message in the Outbox until its time
   (the deferred-send property), so nothing here needs to be running then. */
const later = (a) => { const at = sendAt(a.at); if (at && drafted(a)) no('give at or draft, not both'); return at; };
const deferred = (at) => (at ? { singleValueExtendedProperties: [{ id: 'SystemTime 0x3FEF', value: at.toISOString() }] } : {});
const scheduled = (at, to, files) => `Scheduled for ${wallClock(at)}, to ${to.join(', ')}${files} — it waits in the Outbox until then (delete it there to cancel).`;
const copies = (cc) => (cc.length ? ` (cc ${cc.join(', ')})` : '');
const withNames = (files) => (files.length ? ` with ${files.map((f) => f.name).join(', ')}` : '');
const recipients = (list) => list.map((address) => ({ emailAddress: { address } }));
const people = (to, cc, bcc) => ({ toRecipients: recipients(to), ...(cc.length ? { ccRecipients: recipients(cc) } : {}), ...(bcc.length ? { bccRecipients: recipients(bcc) } : {}) });
/* Files joined: bytes already base64 (what Graph wants) and a name. An
   `attachments` array, or one `attach`+`attachName` (back-compat). */
const filesOf = (a) => (Array.isArray(a.attachments) ? a.attachments : (a.attach ? [{ name: a.attachName, bytes: a.attach }] : []))
    .map((f) => ({ name: String(f?.name || 'attachment'), bytes: String(f?.bytes ?? '') })).filter((f) => f.bytes);
const fileOf = (f) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentBytes: f.bytes });
/* The body Graph is given: the composed HTML from Markdown, or the text as written. */
function bodyOf(target, a) {
    const c = compose({ body: a.body, format: a.format, signature: a.signature === false || a.signature === 'false' ? '' : target.config?.signature });
    return c.html ? { contentType: 'html', content: c.html } : { contentType: 'text', content: c.text };
}
