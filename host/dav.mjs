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
/* THE TYPE OF AN EMAIL OR A PHONE an agent may name (05-11): work, home, mobile (a phone's "cell"). */
export function typeOf(type, name) {
    const t = String(type ?? '').trim().toLowerCase();
    if (!t) return '';
    if (t === 'work' || t === 'home') return t;
    if (name === 'TEL' && (t === 'mobile' || t === 'cell')) return 'cell';
    no(name === 'TEL' ? 'a phone type is work, home or mobile' : 'an email type is work or home');
    return '';
}
/* What a vCard line's parameters say of its type, lowercased: TYPE=work,pref / TYPE=WORK;TYPE=PREF /
   PREF=1 (vCard 4) / a bare ;WORK (vCard 2.1). */
const typesIn = (params) => String(params).split(';').filter(Boolean).flatMap((seg) => {
    const eq = seg.indexOf('=');
    if (eq < 0) return [seg.toLowerCase()];
    const k = seg.slice(0, eq).toUpperCase(); const v = seg.slice(eq + 1).replace(/"/g, '');
    if (k === 'TYPE') return v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (k === 'PREF') return ['pref'];
    return [];
});
/* The same parameters without "preferred". */
const withoutPref = (params) => String(params).split(';').filter(Boolean).map((seg) => {
    const eq = seg.indexOf('=');
    if (eq < 0) return /^pref$/i.test(seg) ? '' : seg;
    const k = seg.slice(0, eq).toUpperCase();
    if (k === 'PREF') return '';
    if (k !== 'TYPE') return seg;
    const kept = seg.slice(eq + 1).split(',').filter((x) => !/^"?pref"?$/i.test(x.trim()));
    return kept.length ? `${seg.slice(0, eq)}=${kept.join(',')}` : '';
}).filter(Boolean).map((x) => `;${x}`).join('');
const sameValue = (name, x, y) => (name === 'TEL'
    ? String(x).replace(/^tel:/i, '').replace(/[^\d+]/g, '') === String(y).replace(/^tel:/i, '').replace(/[^\d+]/g, '')
    : String(x).trim().toLowerCase() === String(y).trim().toLowerCase());
/* ONE EMAIL OR PHONE CHANGED, THE OTHERS KEPT (05-11: an update replaced them all). With no type, the value
   becomes the first, preferred one (moved up when the card had it already); with a type, it replaces the
   one of that type (its other parameters and its group kept), or is added with that type; an empty value
   with a type removes that one. Every other line of the card is left as it was. `said` gets what was done. */
function editOne(text, name, value, type, said) {
    const all = linesOf(text);
    const s = all.findIndex((l) => l.toUpperCase() === 'BEGIN:VCARD');
    const e = all.findIndex((l, i) => i > s && l.toUpperCase() === 'END:VCARD');
    if (s < 0 || e < 0) no('not a VCARD');
    const v4 = all.slice(s, e).some((l) => /^VERSION:4/i.test(l));
    const label = name === 'TEL' ? 'phone' : 'email';
    const re = new RegExp(`^((?:[A-Za-z0-9-]+\\.)?${name})((?:;[^:]*)?):(.*)$`, 'i');
    const mine = []; let depth = 0;
    for (let i = s + 1; i < e; i++) {
        const l = all[i];
        if (/^BEGIN:/i.test(l)) { depth++; continue; }
        if (/^END:/i.test(l)) { depth--; continue; }
        const m = depth === 0 ? re.exec(l) : null;
        if (m) mine.push({ i, head: m[1], params: m[2], value: m[3], types: typesIn(m[2]) });
    }
    const want = typeOf(type, name);
    const val = String(value ?? '').trim();
    const shown = (t) => (t === 'cell' ? 'mobile' : t);
    const lines = all.slice();
    let insert = null; let at = e;
    if (want) {
        const ofType = mine.filter((p) => p.types.includes(want) || (want === 'cell' && p.types.includes('mobile')));
        if (!val) {
            if (!ofType.length) no(`this contact has no ${shown(want)} ${label} to remove`);
            for (const p of ofType) lines[p.i] = null;
            said.push(`removed the ${shown(want)} ${label} (${ofType.map((p) => p.value).join(', ')})`);
        } else if (ofType.length) {
            const hit = ofType[0];
            const v = name === 'TEL' && /^tel:/i.test(hit.value) && !/^tel:/i.test(val) ? `tel:${val}` : val;
            lines[hit.i] = `${hit.head}${hit.params}:${v}`;
            said.push(`replaced the ${shown(want)} ${label} ${hit.value} with ${val}`);
        } else {
            insert = `${name};TYPE=${v4 ? want : want.toUpperCase()}${name === 'EMAIL' && !v4 ? ',INTERNET' : ''}:${val}`;
            at = mine.length ? mine.at(-1).i + 1 : e;
            said.push(`added ${val} as the ${shown(want)} ${label}`);
        }
    } else {
        if (!val) no(`to remove a ${label}, give its type (work, home${name === 'TEL' ? ', mobile' : ''})`);
        const dupe = mine.find((p) => sameValue(name, p.value, val));
        for (const p of mine) if (p !== dupe) lines[p.i] = `${p.head}${withoutPref(p.params)}:${p.value}`;
        if (dupe) {
            lines[dupe.i] = null;
            insert = `${dupe.head}${withoutPref(dupe.params)}${v4 ? ';PREF=1' : ';TYPE=PREF'}:${dupe.value}`;
        } else insert = name === 'TEL' ? (v4 ? `TEL;PREF=1;TYPE=cell:${val}` : `TEL;TYPE=CELL;TYPE=PREF:${val}`) : (v4 ? `EMAIL;PREF=1:${val}` : `EMAIL;TYPE=INTERNET;TYPE=PREF:${val}`);
        at = mine.length ? mine[0].i : e;
        said.push(`${val} is now the first ${label}${mine.length - (dupe ? 1 : 0) > 0 ? `, the other${mine.length - (dupe ? 1 : 0) > 1 ? 's' : ''} kept` : ''}`);
    }
    const out = [];
    lines.forEach((l, i) => { if (i === at && insert) out.push(insert); if (l !== null) out.push(l); });
    return `${out.map(fold).join('\r\n')}\r\n`;
}
/* A contact's text with only the given fields changed: a name replaced; an email or a phone added or
   replaced one by one (editOne), never all of them; the rest of the card kept. */
export function editCard(text, { name, email, phone, type, photo, photoType }, said = []) {
    let t = text;
    if (name !== undefined) { t = setProps(t, 'FN', [`FN:${escapeText(name)}`], 'VCARD'); t = setProps(t, 'N', [nOf(name)], 'VCARD'); said.push(String(name).trim() ? `name ${name}` : 'name removed'); }
    if (email !== undefined) t = editOne(t, 'EMAIL', email, type, said);
    if (phone !== undefined) t = editOne(t, 'TEL', phone, type, said);
    /* vCard 4 carries a photo as a data: URI; 3.0 as base64 with ENCODING=b (loop 5). */
    const v4 = /^VERSION:4/im.test(t);
    const kind = (photoType || 'JPEG').toUpperCase();
    if (photo !== undefined) t = setProps(t, 'PHOTO', [v4 ? `PHOTO:data:image/${kind.toLowerCase()};base64,${String(photo).replace(/\s+/g, '')}` : `PHOTO;ENCODING=b;TYPE=${kind}:${String(photo).replace(/\s+/g, '')}`], 'VCARD');
    return t;
}
export const newUid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-tether`;
