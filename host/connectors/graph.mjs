/* THE GRAPH CONNECTOR: an online folder on SharePoint or OneDrive, reached
 * through Microsoft Graph. The keeper is an ordinary Graph client over HTTPS;
 * nothing is installed, and the agent never connects. It serves the `files.*`
 * verbs (kind `files`): list, read, search, write, move, delete, against a
 * drive's `/drives/{id}/root:/path` endpoints.
 *
 *   target.config.drive   the drive id (a OneDrive or a SharePoint document
 *                         library drive id). `driveId` is accepted as an alias.
 *   target.config.root    optional: a sub-folder files.* may not leave ("/" by default)
 *   target.config.api     optional: the Graph base (https://graph.microsoft.com/v1.0 by default)
 *   target.config.tenant, target.config.clientId
 *                         optional: for the client-credentials flow (below)
 *   target.secrets.token  the NAME of a bearer token in the host's secret store
 *   target.secrets.secret the NAME of a client secret, for client credentials
 *
 * HOW THE TOKEN FLOWS. V1 takes a bearer token the host keeps fresh: the keeper
 * fetches it per call through `ctx.secret("token")` and puts it only into the
 * Authorization header. The host is responsible for refreshing it (Graph tokens
 * last about an hour); Tether never sees the refresh. As an alternative, if the
 * target names a client `secret` and sets `tenant`/`clientId`, the connector
 * runs the OAuth 2.0 client-credentials flow itself and caches the token until
 * it is about to expire. Either way the secret never reaches the agent, the
 * journal or any log; the keeper masks any secret it handed out as a second lock.
 *
 * WHAT V1 DOES NOT DO. Uploads are simple PUTs, up to WRITE_MAX; large-file
 * upload sessions are left for later. Resolving a site name to a drive id is the
 * host's job — the target is given a drive id. close()/shutdown() only drop the
 * cached token.
 *
 * `fetch` is injected for tests (`graph({ fetch })`); it defaults to Node's own.
 */
import { posix } from 'node:path';
import { no, Refused } from '../../server/verbs.mjs';
import { normalPath } from '../../server/rights.mjs';

export const READ_MAX = 512 * 1024;
export const WRITE_MAX = 4 * 1024 * 1024; // simple upload only; see docs
const LIST_MAX = 500;
const HITS_MAX = 100;
const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const isBinary = (buf) => buf.includes(0);

export function graph({ fetch: fetchImpl = globalThis.fetch } = {}) {
    const tokens = new Map(); // target.id -> { value, exp } (client-credentials only)

    const driveOf = (target) => { const d = target.config?.drive ?? target.config?.driveId; if (!d) no(`${target.title} has no drive set`); return String(d); };
    const apiOf = (target) => String(target.config?.api || GRAPH).replace(/\/+$/, '');
    const driveBase = (target) => `${apiOf(target)}/drives/${encodeURIComponent(driveOf(target))}`;

    /* ---- paths, kept inside config.root (drive-relative, "/" is the drive root) ---- */
    const rootOf = (target) => {
        const r = target.config?.root;
        if (!r) return '/';
        const p = normalPath(r.startsWith('/') || r.startsWith('~') ? r : `/${r}`);
        if (p === null || p === '~') return '/';
        return p.startsWith('~/') ? `/${p.slice(2)}` : p;
    };
    const place = (target, given) => {
        const root = rootOf(target);
        const p = normalPath(given);
        if (p === null) no('that path climbs above the folder');
        const abs = posix.normalize(p === '~' ? root : p.startsWith('~/') ? (root === '/' ? `/${p.slice(2)}` : `${root}/${p.slice(2)}`) : p);
        const inside = abs === root || (root === '/' ? abs.startsWith('/') : abs.startsWith(`${root}/`));
        if (!inside) no('that path is outside the folder');
        return abs;
    };
    const shown = (target, abs) => {
        const root = rootOf(target);
        if (abs === root) return '~';
        if (root === '/') return `~${abs}`;
        return abs.startsWith(`${root}/`) ? `~/${abs.slice(root.length + 1)}` : abs;
    };
    /* An absolute drive path as a Graph item reference. "/" is the drive root. */
    const encPath = (abs) => abs.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const itemUrl = (target, abs, tail = '') => { const rel = encPath(abs); const base = driveBase(target); return (rel ? `${base}/root:/${rel}:` : `${base}/root`) + tail; };

    async function bearer(target, ctx) {
        if (target.secrets?.token) { const t = await ctx.secret('token'); if (!t) no(`${target.title}: its token is empty`); return t; }
        const c = target.config ?? {};
        if (!(target.secrets?.secret && c.tenant && c.clientId)) no(`${target.title}: no token set (name a token secret, or set tenant/clientId and a client secret)`);
        const cached = tokens.get(target.id);
        if (cached && cached.exp > Date.now() + 60_000) return cached.value;
        const secret = await ctx.secret('secret');
        const body = new URLSearchParams({ client_id: c.clientId, client_secret: secret, scope: c.scope || 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
        let res;
        try { res = await fetchImpl(`${c.login || LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }); } catch (e) {
            if (e instanceof Refused) throw e; no(`cannot reach the token service for ${target.title}: ${e?.message ?? e}`);
        }
        if (!res.ok) no(`${target.title}: cannot get a token (${res.status})`);
        const j = await res.json().catch(() => ({}));
        if (!j.access_token) no(`${target.title}: the token service gave no token`);
        tokens.set(target.id, { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
        return j.access_token;
    }

    async function call(target, ctx, method, url, { extra = {}, body, json } = {}) {
        const token = await bearer(target, ctx);
        const headers = { Authorization: `Bearer ${token}`, ...extra };
        if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
        let res;
        try { res = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}) }); } catch (e) {
            if (e instanceof Refused) throw e; no(`cannot reach ${target.title}: ${e?.message ?? e}`);
        }
        if (res.status === 401 || res.status === 403) no(`${target.title}: not authorized — check its token`);
        return res;
    }
    const bodyError = async (res) => { try { const j = await res.json(); return j?.error?.message || ''; } catch { return ''; } };

    async function children(target, ctx, abs) {
        const out = [];
        let url = itemUrl(target, abs, '/children?$select=name,size,folder,file&$top=200');
        for (let page = 0; page < 50 && url; page++) {
            const res = await call(target, ctx, 'GET', url);
            if (res.status === 404) return null;
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            const j = await res.json();
            for (const it of j.value || []) { out.push(it); if (out.length >= LIST_MAX + 1) return out; }
            url = j['@odata.nextLink'] || null;
        }
        return out;
    }

    /* The folders leading to a path, created if missing (POST .../children), the
       ones at or above the root left alone (they exist). A folder already there
       answers 409 conflict and is passed over. */
    async function ensureParents(target, ctx, abs) {
        const root = rootOf(target);
        const rootDepth = root === '/' ? 0 : root.split('/').filter(Boolean).length;
        const parts = abs.split('/').filter(Boolean);
        for (let i = rootDepth; i < parts.length - 1; i++) {
            const parentAbs = `/${parts.slice(0, i).join('/')}`;
            const res = await call(target, ctx, 'POST', itemUrl(target, parentAbs, '/children'), { json: { name: parts[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } });
            if (res.status === 409) continue;
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
        }
    }

    async function readCapped(res, max, title) {
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len) && len > max) no(`${len} bytes: too big to read here (${max} at most)`);
        const reader = res.body?.getReader?.();
        if (!reader) { const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > max) no(`too big to read here (${max} at most)`); return buf; }
        const chunks = []; let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > max) { try { await reader.cancel(); } catch { /* done with it */ } no(`${title} is too big to read here (${max} bytes at most)`); }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
    }

    const verbs = {
        async 'files.list'(target, a, ctx) {
            const at = place(target, a.path);
            const kids = await children(target, ctx, at);
            if (kids === null) no('no such folder');
            kids.sort((x, y) => ((y.folder ? 1 : 0) - (x.folder ? 1 : 0)) || String(x.name).localeCompare(String(y.name)));
            const lines = [];
            for (const d of kids.slice(0, LIST_MAX)) lines.push(d.folder ? `${d.name}/` : `${d.name}${typeof d.size === 'number' ? `  ${d.size}` : ''}`);
            if (kids.length > LIST_MAX) lines.push(`... and ${kids.length - LIST_MAX} more`);
            const text = `${shown(target, at)}: ${kids.length} entr${kids.length === 1 ? 'y' : 'ies'}${lines.length ? `\n${lines.join('\n')}` : ''}`;
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.read'(target, a, ctx) {
            const at = place(target, a.path);
            if (at === rootOf(target)) no('that is a folder: list it');
            const meta = await call(target, ctx, 'GET', itemUrl(target, at, '?$select=size,folder,file'));
            if (meta.status === 404) no('no such file');
            if (!meta.ok) no(`${target.title}: ${meta.status} ${await bodyError(meta)}`.trim());
            const m = await meta.json();
            if (m.folder) no('that is a folder: list it');
            if (typeof m.size === 'number' && m.size > READ_MAX) no(`${m.size} bytes: too big to read here (${READ_MAX} at most)`);
            const res = await call(target, ctx, 'GET', itemUrl(target, at, '/content'));
            if (res.status === 404) no('no such file');
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            const buf = await readCapped(res, READ_MAX, shown(target, at));
            if (isBinary(buf)) return { text: `a binary file of ${buf.length} bytes: not shown`, size: buf.length };
            return { text: buf.toString('utf8'), size: buf.length };
        },
        async 'files.search'(target, a, ctx) {
            const top = place(target, a.path);
            const q = String(a.text).replace(/'/g, "''");
            const hits = [];
            let url = itemUrl(target, top, `/search(q='${encodeURIComponent(q)}')?$select=name,folder,parentReference&$top=200`);
            const after = /root:(.*)$/;
            for (let page = 0; page < 50 && url && hits.length < HITS_MAX; page++) {
                const res = await call(target, ctx, 'GET', url);
                if (res.status === 404) break;
                if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
                const j = await res.json();
                for (const it of j.value || []) {
                    if (hits.length >= HITS_MAX) break;
                    let parent = '';
                    const pp = it.parentReference?.path;
                    if (pp) { const m = after.exec(pp); parent = m ? decodeURIComponent(m[1]) : ''; }
                    const abs = posix.normalize(`/${parent}/${it.name}`.replace(/\/+/g, '/'));
                    const root = rootOf(target);
                    if (!(abs === root || root === '/' || abs.startsWith(`${root}/`))) continue;
                    hits.push(`${shown(target, abs)}${it.folder ? '/' : ''}`);
                }
                url = j['@odata.nextLink'] || null;
            }
            const text = hits.length ? hits.join('\n') : 'Nothing found.';
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.write'(target, a, ctx) {
            const at = place(target, a.path);
            if (at === rootOf(target)) no('that is a folder');
            const bytes = Buffer.byteLength(a.text);
            if (bytes > WRITE_MAX) no(`${bytes} bytes: too big to write here (${WRITE_MAX} at most; large-file upload is not in this version)`);
            await ensureParents(target, ctx, at);
            const res = await call(target, ctx, 'PUT', itemUrl(target, at, '/content'), { extra: { 'Content-Type': 'application/octet-stream' }, body: a.text });
            if (res.status === 409) no('that is a folder, or its parent is missing');
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            return { text: `Written: ${shown(target, at)} (${bytes} bytes).`, size: bytes };
        },
        async 'files.move'(target, a, ctx) {
            const from = place(target, a.from);
            const to = place(target, a.to);
            if (from === rootOf(target)) no('the folder itself is not moved');
            const taken = await call(target, ctx, 'GET', itemUrl(target, to, '?$select=id'));
            if (taken.ok) no('something is there already');
            const parent = posix.dirname(to);
            const name = posix.basename(to);
            const parentRef = parent === '/' || parent === '.' ? { path: `/drives/${driveOf(target)}/root:` } : { path: `/drives/${driveOf(target)}/root:/${encPath(parent)}` };
            const res = await call(target, ctx, 'PATCH', itemUrl(target, from), { json: { parentReference: parentRef, name } });
            if (res.status === 404) no('nothing there to move');
            if (res.status === 409) no('something is there already');
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            return { text: `Moved: ${shown(target, from)} → ${shown(target, to)}.`, size: 0 };
        },
        async 'files.delete'(target, a, ctx) {
            const at = place(target, a.path);
            if (at === rootOf(target)) no('the folder itself is not deleted');
            const meta = await call(target, ctx, 'GET', itemUrl(target, at, '?$select=folder'));
            if (meta.status === 404) no('nothing there');
            if (!meta.ok) no(`${target.title}: ${meta.status} ${await bodyError(meta)}`.trim());
            const m = await meta.json();
            if (m.folder && Number(m.folder.childCount) > 0) no('that folder is not empty');
            const res = await call(target, ctx, 'DELETE', itemUrl(target, at));
            if (res.status === 404) no('nothing there');
            if (!res.ok) no(`${target.title}: ${res.status} ${await bodyError(res)}`.trim());
            return { text: `Deleted: ${shown(target, at)}.`, size: 0 };
        },
    };

    return {
        name: 'graph',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        /* Only a cached token is held; drop it. */
        close() { tokens.clear(); },
        shutdown() { tokens.clear(); },
    };
}
