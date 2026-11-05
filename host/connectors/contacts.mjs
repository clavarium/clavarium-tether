/* THE CONTACTS CONNECTOR: a person's address book reached by the keeper with a
 * secret the host holds and the agent never sees. Microsoft over Graph; Google over
 * CardDAV (the scope the Thunderbird client carries); a classic address book (OVH,
 * Infomaniak, Nextcloud, SOGo...) over the same CardDAV with a password. Every verb
 * -- list, search, read, create, change, delete, photo -- works on all three.
 * Inspired by the MIT Google/Microsoft MCP servers, reimplemented host-side.
 *
 *   target.config.provider   'google' or 'microsoft'
 *   target.config.user       the email address (Google CardDAV needs it in the URL)
 *   target.secrets.refresh   the NAME of the refresh token in the host's secret store
 *   -- OR, a classic address book (no provider) --
 *   target.config.carddav    the address book's address, or just its server's (it is found)
 *   target.config.addressbook optional: which one, by name, when there are several
 *   target.config.user       the account
 *   target.secrets.password  the NAME of the password in the host's secret store
 */
import { no, Refused } from '../../server/verbs.mjs';
import { refreshAccess, thunderbird, PROVIDERS } from '../oauth.mjs';
import { discover, cardOf, newCard, editCard, newUid, typeOf } from '../dav.mjs';

const LIST_MAX = 50;
const SCAN_MAX = 1000;          /* contacts looked at when searching by name (then it says so) */
const TIMEOUT_MS = 60_000;
/* A photo's type by its first bytes (a file name may lie or be absent). */
const photoType = (b64, name) => { const head = Buffer.from(String(b64).slice(0, 16), 'base64'); return head[0] === 0x89 && head[1] === 0x50 ? 'PNG' : head[0] === 0xff && head[1] === 0xd8 ? 'JPEG' : /\.png$/i.test(String(name ?? '')) ? 'PNG' : 'JPEG'; };

/* A vCard's useful fields. Lines fold with a leading space; unfold first. */
function fromVcard(text) {
    const v = String(text).replace(/\r?\n[ \t]/g, '');
    const one = (re) => { const m = re.exec(v); return m ? m[1].trim() : ''; };
    const many = (re) => [...v.matchAll(re)].map((m) => m[1].trim()).filter(Boolean);
    return { name: one(/^FN[^:\r\n]*:(.+)$/im), emails: many(/^EMAIL[^:\r\n]*:(.+)$/gim), tels: many(/^TEL[^:\r\n]*:(.+)$/gim) };
}
const brief = (id, c) => `${id}\n  ${c.name || '(no name)'}${c.emails.length ? `  <${c.emails.join(', ')}>` : ''}${c.tels.length ? `  tel ${c.tels.join(' ')}` : ''}`;
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/* Microsoft returns JSON: normalise one contact to the same shape. */
const fromMs = (c) => ({ name: c.displayName || [c.givenName, c.surname].filter(Boolean).join(' '), emails: (c.emailAddresses ?? []).map((e) => e.address).filter(Boolean), tels: [c.mobilePhone, ...(c.businessPhones ?? []), ...(c.homePhones ?? [])].filter(Boolean) });
/* A Microsoft contact body from the simple fields an agent gives (only those set). */
const msBody = (a) => {
    const b = {};
    if (a.name !== undefined) { const p = String(a.name).trim().split(/\s+/); b.displayName = String(a.name); b.givenName = p[0] || ''; b.surname = p.slice(1).join(' '); }
    if (a.email !== undefined) b.emailAddresses = String(a.email).trim() ? [{ address: String(a.email).trim(), name: String(a.name || a.email) }] : [];
    if (a.phone !== undefined) b.mobilePhone = String(a.phone);
    return b;
};

export function contacts({ fetch: fetchImpl = globalThis.fetch } = {}) {
    const tokens = new Map();
    /* 'google' or 'microsoft' by its provider; with none, a classic CardDAV address book. */
    const providerOf = (target) => {
        const p = String(target.config?.provider ?? '').trim();
        if (!p && String(target.config?.carddav ?? '').trim()) return 'carddav';
        if (!PROVIDERS[p] || !(p === 'google' || p === 'microsoft')) no(`${target.title}: set its provider to google or microsoft, or its address book's address (carddav)`);
        return p;
    };
    const userOf = (target) => { const u = String(target.config?.user ?? '').trim(); if (!u) no(`${target.title}: set its email address`); return u; };

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
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: the contacts must be reconnected (its authorisation was refused)`); }
        tokens.set(target.id, { value: t.accessToken, exp: t.expiresAt });
        return t.accessToken;
    }
    async function req(target, ctx, method, url, { headers = {}, body } = {}) {
        let auth;
        if (providerOf(target) === 'carddav') {
            const password = await ctx.secret('password');
            if (!password) no(`${target.title}: its password is empty`);
            auth = `Basic ${Buffer.from(`${userOf(target)}:${password}`, 'utf8').toString('base64')}`;
        } else auth = `Bearer ${await access(target, ctx)}`;
        let res;
        try { res = await fetchImpl(url, { method, headers: { Authorization: auth, ...headers }, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
        catch (e) { if (e instanceof Refused) throw e; no(`${target.title}: ${e?.name === 'TimeoutError' ? 'the address book did not answer in time' : 'cannot reach the address book'}${['GET', 'PROPFIND', 'REPORT'].includes(method) ? '' : ' -- it may have been done: check before asking again'}`); }
        if (res.status === 401 || res.status === 403) no(providerOf(target) === 'carddav' ? `${target.title}: the address book refused the user or the password` : `${target.title}: not authorized -- reconnect the account (the contacts scope may be missing)`);
        return res;
    }
    const folders = new Map();   /* target.id -> its address book folder, once found */
    async function folderOf(target, ctx) {
        if (providerOf(target) === 'google') return CARDDAV(userOf(target));
        if (folders.has(target.id)) return folders.get(target.id);
        let start;
        try { start = new URL(/^https?:\/\//i.test(target.config.carddav) ? target.config.carddav : `https://${target.config.carddav}`).href; }
        catch { no(`${target.title}: its address book address is not an address`); }
        if (!start.startsWith('https://')) no(`${target.title}: the address book address must be https`);
        const found = await discover((m, u, o) => req(target, ctx, m, u, o), start, 'address book', target.config?.addressbook);
        folders.set(target.id, found);
        return found;
    }
    const urlOf = async (target, ctx, id) => { const s = String(id ?? '').trim(); if (!s) no('that needs the contact id'); return /^https?:\/\//.test(s) ? s : new URL(s, await folderOf(target, ctx)).href; };
    async function cardGet(target, ctx, id) {
        const url = await urlOf(target, ctx, id);
        const res = await req(target, ctx, 'GET', url, { headers: { Accept: 'text/vcard' } });
        if (res.status === 404) no('no such contact');
        if (!res.ok) no(`${target.title}: that contact could not be read (${res.status})`);
        return { url, etag: res.headers?.get?.('etag') ?? null, text: await res.text() };
    }
    async function cardPut(target, ctx, url, text, { etag, create } = {}) {
        const res = await req(target, ctx, 'PUT', url, { headers: { 'Content-Type': 'text/vcard; charset=utf-8', ...(create ? { 'If-None-Match': '*' } : etag ? { 'If-Match': etag } : {}) }, body: text });
        if (res.status === 412) no(`${target.title}: the contact changed meanwhile -- read it again`);
        if (!res.ok) no(`${target.title}: the address book refused the change (${res.status})`);
    }

    const CARDDAV = (user) => `https://www.googleapis.com/carddav/v1/principals/${encodeURIComponent(user)}/lists/default/`;
    /* Listing all of a Google address book over CardDAV: an addressbook-query
       needs a CARDDAV:filter (RFC 6352), and a match-all filter is awkward, so
       enumerate the entries with a PROPFIND, then fetch their vCards with an
       addressbook-multiget (both standard, and what Google accepts). */
    const PROPFIND = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>';
    const hrefsIn = (xml) => [...xml.matchAll(/<[^>]*?:?href[^>]*>([\s\S]*?)<\/[^>]*?:?href>/gi)].map((m) => decodeXml(m[1].trim()));

    async function davList(target, ctx, { match } = {}) {
        const out = []; const meta = { total: 0, looked: 0 };
        await davScan(target, ctx, { match }, out, meta);
        /* Never capped in silence (05-11): the list says how many there are; a search, how many it looked at. */
        if (!match && meta.total > out.length && out.length >= LIST_MAX) out.push(`\n(Showing ${out.length} of ${meta.total} contacts — use contacts-search to find one.)`);
        if (match && out.length >= LIST_MAX) out.push(`\n(Showing the first ${LIST_MAX} matches — give more of the name to narrow it.)`);
        else if (match && meta.looked < meta.total) out.push(`\n(Looked at the first ${meta.looked} of ${meta.total} contacts.)`);
        return out;
    }
    async function davScan(target, ctx, { match } = {}, out, meta) {
        const base = await folderOf(target, ctx);
        const basePath = (() => { try { return new URL(base).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
        const listed = await req(target, ctx, 'PROPFIND', base, { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND });
        if (!listed.ok) no(`${target.title}: the address book could not be read (${listed.status})`);
        /* The collection lists itself and its contacts; keep the entries, whatever
           they are named (Google uses an id, not a .vcf suffix). A contact is any
           href under the collection that is not the collection itself. */
        const all = hrefsIn(await listed.text()).filter((h) => {
            const clean = h.replace(/[?#].*$/, '');
            if (!clean || clean.endsWith('/')) return false;
            let p; try { p = new URL(h, base).pathname.replace(/\/+$/, ''); } catch { p = clean.replace(/\/+$/, ''); }
            return p !== basePath;
        });
        meta.total = all.length;
        const hrefs = all.slice(0, match ? SCAN_MAX : LIST_MAX);
        meta.looked = hrefs.length;
        if (!hrefs.length) return;
        for (let i = 0; i < hrefs.length && out.length < LIST_MAX; i += 200) await davChunk(target, ctx, base, hrefs.slice(i, i + 200), match, out);
    }
    async function davChunk(target, ctx, base, hrefs, match, out) {
        const body = `<?xml version="1.0" encoding="utf-8"?><C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop>${hrefs.map((h) => `<D:href>${h.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</D:href>`).join('')}</C:addressbook-multiget>`;
        const res = await req(target, ctx, 'REPORT', base, { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body });
        if (!res.ok) no(`${target.title}: the address book could not be read (${res.status})`);
        const xml = await res.text();
        const blocks = xml.split(/<[A-Za-z0-9]*:?response[\s>]/i).slice(1);
        for (const block of blocks) {
            const href = /<[^>]*?:?href[^>]*>([\s\S]*?)<\/[^>]*?:?href>/i.exec(block)?.[1]?.trim();
            const data = /<[^>]*?:?address-data[^>]*>([\s\S]*?)<\/[^>]*?:?address-data>/i.exec(block)?.[1];
            if (!data) continue;
            const card = fromVcard(decodeXml(data));
            const has = card.name || card.emails.length;
            const hit = !match || `${card.name} ${card.emails.join(' ')}`.toLowerCase().includes(match);
            if (has && hit) out.push(brief(href || '(no id)', card));
            if (out.length >= LIST_MAX) break;
        }
    }

    const verbs = {
        /* The address book, briefly: name, emails, phones. */
        async 'contacts.list'(target, a, ctx) {
            const provider = providerOf(target);
            if (provider !== 'microsoft') { const items = await davList(target, ctx); const text = items.length ? items.join('\n') : 'No contact.'; return { text, size: Buffer.byteLength(text) }; }
            const res = await req(target, ctx, 'GET', `https://graph.microsoft.com/v1.0/me/contacts?$top=${LIST_MAX}&$count=true&$select=id,displayName,givenName,surname,emailAddresses,mobilePhone,businessPhones,homePhones`);
            if (!res.ok) no(`${target.title}: the address book could not be read (${res.status})`);
            const j = await res.json();
            const items = (j.value ?? []).map((c) => brief(c.id, fromMs(c)));
            if (j['@odata.nextLink']) items.push(`\n(Showing the first ${items.length}${Number.isFinite(j['@odata.count']) ? ` of ${j['@odata.count']}` : ''} contacts — use contacts-search to find one.)`);
            const text = items.length ? items.join('\n') : 'No contact.';
            return { text, size: Buffer.byteLength(text) };
        },
        /* The contacts whose name or email matches a word, briefly. Both providers
           are filtered host-side over the first SCAN_MAX entries -- a plain, provider-
           agnostic match that does not lean on each service's own search quirks. */
        async 'contacts.search'(target, a, ctx) {
            const provider = providerOf(target);
            const q = String(a.text ?? '').trim().toLowerCase();
            if (!q) no('search needs a name to look for');
            let items;
            if (provider !== 'microsoft') items = await davList(target, ctx, { match: q });
            else {
                let url = `https://graph.microsoft.com/v1.0/me/contacts?$top=200&$select=id,displayName,givenName,surname,emailAddresses,mobilePhone,businessPhones,homePhones`;
                const all = []; let more = false;
                while (url) {
                    const res = await req(target, ctx, 'GET', url);
                    if (!res.ok) no(`${target.title}: the address book could not be searched (${res.status})`);
                    const j = await res.json();
                    all.push(...(j.value ?? []));
                    url = j['@odata.nextLink'] && all.length < SCAN_MAX ? j['@odata.nextLink'] : null;
                    more = Boolean(j['@odata.nextLink']) && !url;
                }
                items = all
                    .map((c) => ({ id: c.id, card: fromMs(c) }))
                    .filter(({ card }) => `${card.name} ${card.emails.join(' ')}`.toLowerCase().includes(q))
                    .map(({ id, card }) => brief(id, card));
                if (items.length > LIST_MAX) { items = items.slice(0, LIST_MAX); items.push(`\n(Showing the first ${LIST_MAX} matches — give more of the name to narrow it.)`); }
                else if (more) items.push(`\n(Looked at the first ${all.length} contacts.)`);
            }
            const text = items.some((x) => !x.startsWith('\n')) ? items.join('\n') : ['No contact matches.', ...items].join('\n');
            return { text, size: Buffer.byteLength(text) };
        },
        /* One contact in full, by its id (the Microsoft id, or the Google CardDAV href). */
        async 'contacts.read'(target, a, ctx) {
            const provider = providerOf(target);
            const id = String(a.id ?? '').trim();
            if (!id) no('read needs the contact id');
            if (provider !== 'microsoft') {
                const { text: raw } = await cardGet(target, ctx, id);
                const c = cardOf(raw);
                const text = [c.name || '(no name)', ...c.emails.map((e) => `  email: ${e}`), ...c.tels.map((t) => `  tel: ${t}`), c.photo ? '  (has a photo)' : '', '', raw.slice(0, 64 * 1024)].filter((x, i, all) => x !== '' || i === all.length - 2).join('\n');
                return { text, size: Buffer.byteLength(text) };
            }
            const res = await req(target, ctx, 'GET', `https://graph.microsoft.com/v1.0/me/contacts/${encodeURIComponent(id)}`);
            if (res.status === 404) no('no such contact');
            if (!res.ok) no(`${target.title}: that contact could not be read (${res.status})`);
            /* Read as the CardDAV path reads (05-11: it was a raw JSON dump). */
            const c = await res.json();
            const addr = (x) => [x?.street, [x?.postalCode, x?.city].filter(Boolean).join(' '), x?.countryOrRegion].filter(Boolean).join(', ');
            const lines = [c.displayName || [c.givenName, c.surname].filter(Boolean).join(' ') || '(no name)',
                ...(c.emailAddresses ?? []).filter((e) => e?.address).map((e) => `  email: ${e.address}`),
                ...(c.mobilePhone ? [`  tel (mobile): ${c.mobilePhone}`] : []), ...(c.businessPhones ?? []).filter(Boolean).map((t) => `  tel (work): ${t}`), ...(c.homePhones ?? []).filter(Boolean).map((t) => `  tel (home): ${t}`),
                ...(c.companyName ? [`  company: ${c.companyName}${c.jobTitle ? `, ${c.jobTitle}` : ''}`] : []),
                ...[['work', c.businessAddress], ['home', c.homeAddress]].filter(([, x]) => addr(x)).map(([k, x]) => `  address (${k}): ${addr(x)}`),
                ...(c.birthday ? [`  birthday: ${String(c.birthday).slice(0, 10)}`] : []),
                ...(c.personalNotes ? ['', String(c.personalNotes)] : []), '', `id: ${c.id ?? id}`];
            const text = lines.join('\n').slice(0, 64 * 1024);
            return { text, size: Buffer.byteLength(text) };
        },
        /* Create a contact (Microsoft). Google means writing a vCard over CardDAV --
           on the parity card. */
        async 'contacts.create'(target, a, ctx) {
            if (!a.name && !a.email) no('a contact needs at least a name or an email');
            if (providerOf(target) !== 'microsoft') {
                const uid = newUid();
                const url = new URL(`${uid}.vcf`, await folderOf(target, ctx)).href;
                await cardPut(target, ctx, url, newCard({ uid, name: a.name, email: a.email, phone: a.phone }), { create: true });
                return { text: `Created ${a.name || a.email}. Its id is ${new URL(url).pathname}.`, size: 0 };
            }
            const res = await req(target, ctx, 'POST', 'https://graph.microsoft.com/v1.0/me/contacts', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msBody(a)) });
            if (!res.ok) no(`${target.title}: the contact was not created (${res.status})`);
            const made = await res.json().catch(() => ({}));
            return { text: `Created ${a.name || a.email}. Its id is ${made.id ?? '(unknown)'}.`, size: 0 };
        },
        /* Change a contact's name, email or phone, only what was asked (05-11: an update replaced every email
           and every phone). CardDAV: editCard (one value added first, or the one of a type replaced; the rest
           of the card kept). Microsoft: the email goes first, the others kept (Microsoft keeps 3 at most, and
           no type for an email); a phone is the mobile one, or with a type the work or home one -- the one it
           replaces is named in the result. */
        async 'contacts.update'(target, a, ctx) {
            const id = String(a.id ?? '').trim(); if (!id) no('update needs the contact id');
            if (a.name === undefined && a.email === undefined && a.phone === undefined) no('update needs at least one of: name, email, phone');
            const said = [];
            if (providerOf(target) !== 'microsoft') {
                const { url, etag, text } = await cardGet(target, ctx, id);
                await cardPut(target, ctx, url, editCard(text, { name: a.name, email: a.email, phone: a.phone, type: a.type }, said), { etag });
                return { text: `Updated the contact: ${said.join('; ')}.`, size: 0 };
            }
            const body = msBody({ name: a.name });
            const url = `https://graph.microsoft.com/v1.0/me/contacts/${encodeURIComponent(id)}`;
            if (a.name !== undefined) said.push(`name ${a.name}`);
            if (a.email !== undefined || a.phone !== undefined) {
                const was = await req(target, ctx, 'GET', `${url}?$select=displayName,emailAddresses,mobilePhone,businessPhones,homePhones`);
                if (was.status === 404) no('no such contact');
                if (!was.ok) no(`${target.title}: that contact could not be read (${was.status})`);
                const c = await was.json().catch(() => ({}));
                if (a.email !== undefined) {
                    const e = String(a.email).trim();
                    if (!e) no('to remove an email on Microsoft, change the contact in Outlook');
                    const others = (c.emailAddresses ?? []).filter((x) => x?.address && x.address.toLowerCase() !== e.toLowerCase());
                    const kept = others.slice(0, 2); const lost = others.slice(2).map((x) => x.address);
                    body.emailAddresses = [{ address: e, name: String(a.name || c.displayName || e) }, ...kept];
                    said.push(`${e} is now the first email${kept.length ? `, ${kept.length > 1 ? 'the others' : 'the other'} kept` : ''}${lost.length ? ` (Microsoft keeps 3: ${lost.join(', ')} removed)` : ''}`);
                }
                if (a.phone !== undefined) {
                    const want = typeOf(a.type, 'TEL') || 'cell';
                    const p = String(a.phone).trim();
                    /* As on CardDAV: removing needs the type of the one to remove (loop 8). */
                    if (!p && !a.type) no('to remove a phone, give its type (mobile, work or home)');
                    const had = want === 'cell' ? c.mobilePhone : (c[want === 'work' ? 'businessPhones' : 'homePhones'] ?? []).filter(Boolean)[0];
                    if (!p && !had) no(`this contact has no ${want === 'cell' ? 'mobile' : want} phone to remove`);
                    if (want === 'cell') {
                        body.mobilePhone = p;
                        said.push(p ? `mobile ${p}${c.mobilePhone && c.mobilePhone !== p ? ` (was ${c.mobilePhone})` : ''}` : `mobile removed${c.mobilePhone ? ` (was ${c.mobilePhone})` : ''}`);
                    } else {
                        const key = want === 'work' ? 'businessPhones' : 'homePhones';
                        const list = (c[key] ?? []).filter(Boolean);
                        body[key] = p ? [p, ...list.slice(1)] : list.slice(1);
                        said.push(p ? `${want} phone ${p}${list[0] && list[0] !== p ? ` (was ${list[0]})` : ''}` : `${want} phone removed${list[0] ? ` (was ${list[0]})` : ''}`);
                    }
                }
            }
            const res = await req(target, ctx, 'PATCH', url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status === 404) no('no such contact');
            if (!res.ok) no(`${target.title}: the contact was not changed (${res.status})`);
            return { text: `Updated the contact: ${said.join('; ')}.`, size: 0 };
        },
        /* Delete a contact (Microsoft). */
        async 'contacts.delete'(target, a, ctx) {
            const id = String(a.id ?? '').trim(); if (!id) no('delete needs the contact id');
            /* Who it was, said in the result (an id alone tells nobody what went). */
            const who = await describe('contacts.delete', target, a, ctx).catch(() => null);
            const named = who?.name || who?.email ? ` ${[who.name, who.email ? `<${who.email}>` : ''].filter(Boolean).join(' ')}` : '';
            if (providerOf(target) !== 'microsoft') {
                const res = await req(target, ctx, 'DELETE', await urlOf(target, ctx, id));
                if (res.status === 404) no('no such contact');
                if (!res.ok) no(`${target.title}: the contact was not deleted (${res.status})`);
                return { text: `Deleted the contact${named}.`, size: 0 };
            }
            const res = await req(target, ctx, 'DELETE', `https://graph.microsoft.com/v1.0/me/contacts/${encodeURIComponent(id)}`);
            if (res.status === 404) no('no such contact');
            if (!res.ok) no(`${target.title}: the contact was not deleted (${res.status})`);
            return { text: `Deleted the contact${named}.`, size: 0 };
        },
        /* Set a contact's photo. An act. Microsoft takes the image bytes (Graph);
           a Google photo means editing the vCard (coming with contacts writing) --
           Microsoft only for now. */
        async 'contacts.attach'(target, a, ctx) {
            const provider = providerOf(target);
            const id = String(a.id ?? '').trim();
            if (!id) no('attach needs the contact id');
            if (!a.attach) no('attach needs the photo (its base64 bytes)');
            if (provider !== 'microsoft') {
                const { url, etag, text } = await cardGet(target, ctx, id);
                const type = photoType(a.attach, a.attachName);
                await cardPut(target, ctx, url, editCard(text, { photo: a.attach, photoType: type }), { etag });
                /* Read back: a server that drops the photo is said, not "set" (loop 5). */
                if (!cardOf((await cardGet(target, ctx, id)).text).photo) no(`${target.title}: the address book did not keep the photo`);
                return { text: `Set the photo on ${id}.`, size: 0 };
            }
            const res = await req(target, ctx, 'PUT', `https://graph.microsoft.com/v1.0/me/contacts/${encodeURIComponent(id)}/photo/$value`, { headers: { 'Content-Type': photoType(a.attach, a.attachName) === 'PNG' ? 'image/png' : 'image/jpeg' }, body: Buffer.from(String(a.attach), 'base64') });
            if (res.status === 404) no('no such contact');
            if (!res.ok) no(`${target.title}: the photo was not set (${res.status})`);
            return { text: `Set the photo on ${id}.`, size: 0 };
        },
    };

    /* What a waiting act is about, for the card a person approves from: the contact changed, deleted or
       given a photo -- its name and its email -- not just an id (05-11). A read. */
    async function describe(verb, target, a, ctx) {
        const id = String(a.id ?? '').trim();
        if (!id || !['contacts.update', 'contacts.delete', 'contacts.attach'].includes(verb)) return null;
        if (providerOf(target) !== 'microsoft') {
            const c = cardOf((await cardGet(target, ctx, id)).text);
            return { name: c.name, email: c.emails[0] ?? '', emails: c.emails, phones: c.tels };
        }
        const res = await req(target, ctx, 'GET', `https://graph.microsoft.com/v1.0/me/contacts/${encodeURIComponent(id)}?$select=displayName,givenName,surname,emailAddresses,mobilePhone,businessPhones,homePhones`);
        if (!res.ok) return null;
        const c = fromMs(await res.json());
        return { name: c.name, email: c.emails[0] ?? '', emails: c.emails, phones: c.tels };
    }

    return {
        name: 'contacts',
        verbs: Object.keys(verbs),
        describe,
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        close() { tokens.clear(); folders.clear(); },
        shutdown() { tokens.clear(); folders.clear(); },
    };
}
