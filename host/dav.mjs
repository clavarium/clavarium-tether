/* THE FEW WORDS OF CalDAV / CardDAV, and of the iCalendar and vCard texts they
 * carry. A calendar or an address book is a WebDAV folder of small text files
 * (one event, one contact): read with REPORT or GET, written with PUT, removed
 * with DELETE. Google speaks it (with a token), and so do the classic hosts --
 * OVH, Infomaniak, Nextcloud, SOGo, Fastmail -- with a user and a password. Here:
 * the requests' XML, the answers' parsing, finding the folder from a server's
 * address, and editing one property of an event or a contact without touching
 * the others. No dependency; nothing here holds a secret (`request` does). */
import { no } from '../server/verbs.mjs';

export const TZ = 'Europe/Paris';
export const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
export const encodeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (name) => `<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`;
/* The <response> blocks of a multistatus answer, each with its href and its raw props. */
export function responses(xml) {
    return String(xml).split(/<(?:[A-Za-z0-9_-]+:)?response[\s>]/i).slice(1).map((block) => ({
        href: decodeXml(new RegExp(tag('href'), 'i').exec(block)?.[1]?.trim() ?? ''),
        block,
        value: (name) => { const m = new RegExp(tag(name), 'i').exec(block); return m ? decodeXml(m[1]) : null; },
        has: (name) => new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[\\s/>]`, 'i').test(block),
    }));
}
const hrefIn = (text) => (text ? decodeXml(new RegExp(tag('href'), 'i').exec(text)?.[1]?.trim() ?? '') : '');

/* The calendar (or address book) folder from what a person typed: a folder URL
   given whole is kept; a server's address is asked, the standard way (RFC 6764 /
   4791 / 6352): the well-known entry, the signed-in user's principal, its home,
   then the first calendar (or address book) in it -- or the one named. */
export async function discover(request, start, kind, named) {
    const isCal = kind === 'calendar';
    kind = isCal ? 'calendar' : 'address book';
    const ns = isCal ? 'urn:ietf:params:xml:ns:caldav' : 'urn:ietf:params:xml:ns:carddav';
    const home = isCal ? 'calendar-home-set' : 'addressbook-home-set';
    const find = async (url, depth, props) => {
        const res = await request('PROPFIND', url, { headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
            body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="${ns}"><D:prop>${props}</D:prop></D:propfind>` });
        if (res.status === 404) return null;
        if (!res.ok && res.status !== 207) no(`the ${kind} server answered ${res.status} at ${url}`);
        return { url: res.url || url, list: responses(await res.text()) };
    };
    const base = new URL(start);
    const isFolder = (r) => new RegExp(`<(?:[A-Za-z0-9_-]+:)?resourcetype[^>]*>[\\s\\S]*?<(?:[A-Za-z0-9_-]+:)?${isCal ? 'calendar' : 'addressbook'}[\\s/>]`, 'i').test(r.block);
    /* Already a calendar (address book) folder? */
    const here = await find(base.href, 0, `<D:resourcetype/><D:current-user-principal/><C:${home}/>`);
    if (here?.list[0] && isFolder(here.list[0])) return base.href;
    let homeUrl = hrefIn(here?.list[0]?.value(home));
    if (!homeUrl) {
        let principal = hrefIn(here?.list[0]?.value('current-user-principal'));
        if (!principal) {
            const known = await find(new URL(`/.well-known/${isCal ? 'caldav' : 'carddav'}`, base).href, 0, '<D:current-user-principal/>');
            principal = hrefIn(known?.list[0]?.value('current-user-principal'));
        }
        if (!principal) no(`no ${kind} found at ${base.host} -- give the full address of the ${kind} folder`);
        const p = await find(new URL(principal, base).href, 0, `<C:${home}/>`);
        homeUrl = hrefIn(p?.list[0]?.value(home));
        if (!homeUrl) no(`no ${kind} home at ${base.host} -- give the full address of the ${kind} folder`);
    }
    const listed = await find(new URL(homeUrl, base).href, 1, '<D:resourcetype/><D:displayname/>');
    const folders = (listed?.list ?? []).filter(isFolder);
    if (!folders.length) no(`no ${kind} in that account at ${base.host}`);
    const pick = named ? folders.find((f) => String(f.value('displayname') ?? '').trim().toLowerCase() === String(named).trim().toLowerCase() || f.href.replace(/\/$/, '').split('/').pop() === named) : folders[0];
    if (!pick) no(`no ${kind} named "${named}" -- there are: ${folders.map((f) => (f.value('displayname') || f.href).trim()).join(', ')}`);
    return new URL(pick.href, base).href;
}

/* ---------- iCalendar ---------- */
export const unfold = (text) => String(text ?? '').replace(/\r?\n[ \t]/g, '');
/* A long line folded at 74 octets on whole characters, as RFC 5545 asks. */
const fold = (line) => { const out = []; let cur = ''; for (const ch of line) { if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' '; } cur += ch; } out.push(cur); return out.join('\r\n'); };
export const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
export const unescapeText = (s) => String(s ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/* One component (VEVENT, VCARD...) as its lines, unfolded. */
const linesOf = (text) => unfold(text).split(/\r?\n/).filter((l) => l !== '');
/* A property's lines in the first `comp` block: [{ name, params, value, raw }]. */
export function props(text, name, comp = 'VEVENT') {
    const lines = linesOf(text);
    const s = lines.findIndex((l) => l.toUpperCase() === `BEGIN:${comp}`);
    const e = lines.findIndex((l, i) => i > s && l.toUpperCase() === `END:${comp}`);
    const out = [];
    let depth = 0;
    for (const l of lines.slice(s + 1, e < 0 ? undefined : e)) {
        if (/^BEGIN:/i.test(l)) { depth++; continue; }
        if (/^END:/i.test(l)) { depth--; continue; }
        if (depth) continue;   /* inside a VALARM: not the event's own */
        const m = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(l);
        if (m && m[1].toUpperCase() === name.toUpperCase()) out.push({ name: m[1].toUpperCase(), params: m[2], value: m[3], raw: l });
    }
    return out;
}
export const prop = (text, name, comp) => props(text, name, comp)[0] ?? null;
/* The text with the first `comp` block's `name` lines replaced by `lines` (strings
   "NAME;PARAMS:value", already escaped), or removed when `lines` is empty; the
   rest -- alarms, unknown properties, other events -- left as they were. */
export function setProps(text, name, lines, comp = 'VEVENT') {
    const all = linesOf(text);
    const s = all.findIndex((l) => l.toUpperCase() === `BEGIN:${comp}`);
    let e = all.findIndex((l, i) => i > s && l.toUpperCase() === `END:${comp}`);
    if (s < 0 || e < 0) no(`not a ${comp}`);
    const keep = []; let depth = 0;
    all.forEach((l, i) => {
        if (i <= s || i >= e) { keep.push(l); return; }
        if (/^BEGIN:/i.test(l)) depth++;
        const own = depth === 0 && new RegExp(`^${name}[;:]`, 'i').test(l);
        if (/^END:/i.test(l)) depth--;
        if (!own) keep.push(l);
    });
    e = keep.findIndex((l, i) => i > s && l.toUpperCase() === `END:${comp}`);
    keep.splice(e, 0, ...lines);
    return `${keep.map(fold).join('\r\n')}\r\n`;
}

/* A local wall-clock time (Paris) as UTC; a time with an offset is kept as said. */
export function localToUtc(v) {
    const s = String(v ?? '').trim();
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) { const d = new Date(s); if (Number.isNaN(d.getTime())) no(`not a date-time: ${s}`); return d; }
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (!m) no(`not a date-time: ${s} (e.g. 2026-11-10T16:00)`);
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    const offsetAt = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t; };
    let t = wall - offsetAt(wall); t = wall - offsetAt(t);
    return new Date(t);
}
export const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
/* DTSTART/DTEND lines from what an agent gives: a bare date is all-day. */
export function timeLine(name, v) {
    const s = String(v ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${name};VALUE=DATE:${s.replace(/-/g, '')}`;
    return `${name}:${stamp(localToUtc(s))}`;
}
/* An iCalendar time as the person reads it: local "2026-11-10 16:00", or a date. */
export function readTime(p) {
    if (!p) return '';
    const v = p.value.trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
    if (!m) return v;
    if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
    if (!m[7]) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;   /* its own zone or floating: as written */
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
    const q = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    return `${q.year}-${q.month}-${q.day} ${q.hour}:${q.minute}`;
}
/* An event, read: what a person wants to see of it. */
export function eventOf(text) {
    const g = (n) => { const p = prop(text, n); return p ? unescapeText(p.value) : ''; };
    const cats = props(text, 'CATEGORIES').flatMap((p) => p.value.split(/(?<!\\),/).map(unescapeText)).map((x) => x.trim()).filter(Boolean);
    const who = props(text, 'ATTENDEE').map((p) => ({ email: p.value.replace(/^mailto:/i, ''), status: /PARTSTAT=([^;:]+)/i.exec(p.params)?.[1]?.toLowerCase() ?? '' }));
    const files = props(text, 'ATTACH').map((p) => ({ name: /(?:X-FILENAME|FILENAME)=("?)([^";:]+)\1/i.exec(p.params)?.[2] ?? (/VALUE=BINARY/i.test(p.params) ? 'file' : p.value), inline: /VALUE=BINARY/i.test(p.params) }));
    return { uid: g('UID'), summary: g('SUMMARY'), start: readTime(prop(text, 'DTSTART')), end: readTime(prop(text, 'DTEND')), location: g('LOCATION'), notes: g('DESCRIPTION'),
        organizer: (prop(text, 'ORGANIZER')?.value ?? '').replace(/^mailto:/i, ''), attendees: who, categories: cats, files };
}
/* A new event's text. */
export function newEvent({ uid, title, start, end, where, notes, attendees = [], organizer, categories = [] }) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//clavarium//tether//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`,
        timeLine('DTSTART', start), timeLine('DTEND', end), `SUMMARY:${escapeText(title)}`];
    if (where) lines.push(`LOCATION:${escapeText(where)}`);
    if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
    if (categories.length) lines.push(`CATEGORIES:${categories.map(escapeText).join(',')}`);
    if (attendees.length && organizer) lines.push(`ORGANIZER:mailto:${organizer}`);
    for (const a of attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

/* ---------- vCard ---------- */
export function cardOf(text) {
    const g = (n) => { const p = prop(text, n, 'VCARD'); return p ? unescapeText(p.value) : ''; };
    return { uid: g('UID'), name: g('FN'), emails: props(text, 'EMAIL', 'VCARD').map((p) => p.value.trim()).filter(Boolean), tels: props(text, 'TEL', 'VCARD').map((p) => p.value.trim()).filter(Boolean), photo: Boolean(prop(text, 'PHOTO', 'VCARD')) };
}
const nOf = (name) => { const p = String(name).trim().split(/\s+/); return `N:${escapeText(p.slice(1).join(' '))};${escapeText(p[0] ?? '')};;;`; };
export function newCard({ uid, name, email, phone }) {
    const fn = String(name || email || '').trim();
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${escapeText(fn)}`, nOf(name || '')];
    if (email) lines.push(`EMAIL;TYPE=INTERNET:${email}`);
    if (phone) lines.push(`TEL;TYPE=CELL:${phone}`);
    lines.push('END:VCARD');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}
/* A contact's text with only the given fields changed. */
export function editCard(text, { name, email, phone, photo, photoType }) {
    let t = text;
    if (name !== undefined) { t = setProps(t, 'FN', [`FN:${escapeText(name)}`], 'VCARD'); t = setProps(t, 'N', [nOf(name)], 'VCARD'); }
    if (email !== undefined) t = setProps(t, 'EMAIL', String(email).trim() ? [`EMAIL;TYPE=INTERNET:${String(email).trim()}`] : [], 'VCARD');
    if (phone !== undefined) t = setProps(t, 'TEL', String(phone).trim() ? [`TEL;TYPE=CELL:${String(phone).trim()}`] : [], 'VCARD');
    if (photo !== undefined) t = setProps(t, 'PHOTO', [`PHOTO;ENCODING=b;TYPE=${(photoType || 'JPEG').toUpperCase()}:${String(photo).replace(/\s+/g, '')}`], 'VCARD');
    return t;
}
export const newUid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-tether`;
