/* THE WEBDAV CONNECTOR: an online folder on a server the person already runs —
 * Nextcloud, ownCloud, or any WebDAV endpoint. The keeper reaches it as an
 * ordinary WebDAV client over HTTPS; nothing is installed on the server, and the
 * agent never connects. It serves the `files.*` verbs (kind `files`): list,
 * read, search, write, move, delete.
 *
 *   target.config.url     the WebDAV collection this target is anchored at, e.g.
 *                         https://cloud.example.com/remote.php/dav/files/alice
 *   target.config.user    the user name for Basic auth (not a secret)
 *   target.config.root    optional: a sub-folder files.* may not leave ("/" by default)
 *   target.secrets.password   the NAME of the password in the host's secret store
 *                         (a Nextcloud app password / app token, or a Basic-auth password)
 *
 * THE PASSWORD NEVER TOUCHES THIS CODE'S OUTPUT. It is fetched per call from the
 * host through `ctx.secret("password")`, put only into the Authorization header,
 * and never returned to the agent, journalled or logged; the keeper also masks
 * any secret it handed out, as a second lock.
 *
 * STATELESS: this connector holds no connection and no credential between calls,
 * so close()/shutdown() have nothing to take down. A host that does not want it
 * passes `connectors: { webdav: null }`.
 *
 * `fetch` is injected for tests (`webdav({ fetch })`); it defaults to Node's own.
 */
import { posix } from 'node:path';
import { no, Refused } from '../../server/verbs.mjs';
import { normalPath } from '../../server/rights.mjs';

export const READ_MAX = 512 * 1024;
export const WRITE_MAX = 4 * 1024 * 1024; // simple PUT only; see docs
const LIST_MAX = 500;
const HITS_MAX = 100;
const WALK_MAX = 5000;

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';

const isBinary = (buf) => buf.includes(0);
const decodeEntities = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&');
/* One tag's text (namespace prefix ignored). */
const tagText = (xml, name) => { const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml); return m ? decodeEntities(m[1].trim()) : null; };
/* Each <response> of a multistatus body: its href, whether it is a collection, its size. */
function responses(xml) {
    const out = [];
    const re = /<(?:\w+:)?response[\s>]([\s\S]*?)<\/(?:\w+:)?response>/gi;
    let m;
    while ((m = re.exec(xml))) {
        const body = m[1];
        const href = tagText(body, 'href');
        if (href === null) continue;
        const isDir = /<(?:\w+:)?collection\s*\/?\s*>/i.test(body);
        const len = tagText(body, 'getcontentlength');
        out.push({ href, isDir, size: len && /^\d+$/.test(len) ? Number(len) : null });
    }
    return out;
}

export function webdav({ fetch: fetchImpl = globalThis.fetch } = {}) {
    /* ---- paths, kept inside config.root ---- */
    const baseOf = (target) => { const u = target.config?.url; if (!u) no(`${target.title} has no url set`); return String(u).replace(/\/+$/, ''); };
    /* The root as an absolute path in the base's namespace: "/", or "/a/b". */
    const rootOf = (target) => {
        const r = target.config?.root;
        if (!r) return '/';
        const p = normalPath(r.startsWith('/') || r.startsWith('~') ? r : `/${r}`);
        if (p === null || p === '~') return '/';
        return p.startsWith('~/') ? `/${p.slice(2)}` : p;
    };
    /* A path of the agent's, as an absolute path under the base, inside the root. */
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
    /* An absolute path as a URL under the base (each segment encoded). */
    const urlOf = (base, abs) => base + abs.split('/').map(encodeURIComponent).join('/');
    /* A response's href back to a path in the base's namespace. */
    const basePathOf = (base) => { try { return decodeURIComponent(new URL(base).pathname).replace(/\/+$/, ''); } catch { return ''; } };
    const hrefToAbs = (base, href) => {
        let p;
        try { p = new URL(href, base).pathname; } catch { return null; }
        p = p.split('/').map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } }).join('/');
        const bp = basePathOf(base);
        if (bp && (p === bp || p.startsWith(`${bp}/`))) p = p.slice(bp.length);
        p = p.replace(/\/+$/, '');
        return p === '' ? '/' : p;
    };

    async function headers(target, ctx, extra = {}) {
        const user = target.config?.user ?? '';
        const password = await ctx.secret('password');
        return { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, ...extra };
    }
    async function send(target, ctx, method, abs, { extra = {}, body } = {}) {
        const base = baseOf(target);
        let res;
        try { res = await fetchImpl(urlOf(base, abs), { method, headers: await headers(target, ctx, extra), ...(body !== undefined ? { body } : {}) }); } catch (e) {
            if (e instanceof Refused) throw e;
            no(`cannot reach ${target.title}: ${e?.message ?? e}`);
        }
        if (res.status === 401 || res.status === 403) no(`${target.title}: not authorized — check its password`);
        return res;
    }
    /* PROPFIND depth N; { ok, status, items } with items in the base's namespace. */
    async function propfind(target, ctx, abs, depth) {
        const res = await send(target, ctx, 'PROPFIND', abs, { extra: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY });
        if (res.status === 404) return { ok: false, status: 404, items: [] };
        if (res.status !== 207 && res.status !== 200) no(`${target.title}: ${res.status} ${res.statusText || ''}`.trim());
        const base = baseOf(target);
        const items = responses(await res.text()).map((r) => ({ ...r, abs: hrefToAbs(base, r.href) })).filter((r) => r.abs !== null);
        return { ok: true, status: res.status, items };
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
    /* The collections leading to a path, made if missing (MKCOL), the ones at or
       above the root left alone (they exist). Each failure is ignored: a
       collection already there answers 405, and the PUT/MOVE that follows says
       the real outcome. */
    async function mkcolp(target, ctx, abs) {
        const root = rootOf(target);
        const rootDepth = root === '/' ? 0 : root.split('/').filter(Boolean).length;
        const parts = abs.split('/').filter(Boolean);
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
            cur += `/${parts[i]}`;
            if (i < rootDepth) continue;
            try { await send(target, ctx, 'MKCOL', cur); } catch (e) { if (e instanceof Refused && /not authorized/.test(e.message)) throw e; /* else keep going */ }
        }
    }

    const verbs = {
        async 'files.list'(target, a, ctx) {
            const at = place(target, a.path);
            const r = await propfind(target, ctx, at, 1);
            if (!r.ok) no('no such folder');
            const self = r.items.find((x) => x.abs === at);
            if (self && !self.isDir) no('that is a file, not a folder');
            const kids = r.items.filter((x) => x.abs !== at);
            kids.sort((x, y) => (y.isDir - x.isDir) || posix.basename(x.abs).localeCompare(posix.basename(y.abs)));
            const lines = [];
            for (const d of kids.slice(0, LIST_MAX)) { const name = posix.basename(d.abs); lines.push(d.isDir ? `${name}/` : `${name}${d.size !== null ? `  ${d.size}` : ''}`); }
            if (kids.length > LIST_MAX) lines.push(`... and ${kids.length - LIST_MAX} more`);
            const text = `${shown(target, at)}: ${kids.length} entr${kids.length === 1 ? 'y' : 'ies'}${lines.length ? `\n${lines.join('\n')}` : ''}`;
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.read'(target, a, ctx) {
            const at = place(target, a.path);
            const res = await send(target, ctx, 'GET', at);
            if (res.status === 404) no('no such file');
            if (res.status === 405 || res.status === 409) no('that is a folder: list it');
            if (!res.ok) no(`${target.title}: ${res.status} ${res.statusText || ''}`.trim());
            const buf = await readCapped(res, READ_MAX, shown(target, at));
            if (isBinary(buf)) return { text: `a binary file of ${buf.length} bytes: not shown`, size: buf.length };
            return { text: buf.toString('utf8'), size: buf.length };
        },
        async 'files.search'(target, a, ctx) {
            const top = place(target, a.path);
            const q = a.text.toLowerCase();
            const hits = []; let seen = 0;
            const walk = async (dir, depth) => {
                if (depth > 8 || hits.length >= HITS_MAX || seen >= WALK_MAX) return;
                const r = await propfind(target, ctx, dir, 1);
                if (!r.ok) return;
                for (const d of r.items) {
                    if (d.abs === dir) continue;
                    if (hits.length >= HITS_MAX || ++seen > WALK_MAX) return;
                    const name = posix.basename(d.abs);
                    if (name === '.git' || name === 'node_modules') continue;
                    if (name.toLowerCase().includes(q)) hits.push(`${shown(target, d.abs)}${d.isDir ? '/' : ''}`);
                    if (d.isDir) await walk(d.abs, depth + 1);
                }
            };
            await walk(top, 0);
            const text = hits.length ? hits.join('\n') : 'Nothing found.';
            return { text, size: Buffer.byteLength(text) };
        },
        async 'files.write'(target, a, ctx) {
            const at = place(target, a.path);
            const bytes = Buffer.byteLength(a.text);
            if (bytes > WRITE_MAX) no(`${bytes} bytes: too big to write here (${WRITE_MAX} at most)`);
            await mkcolp(target, ctx, at);
            const res = await send(target, ctx, 'PUT', at, { extra: { 'Content-Type': 'application/octet-stream' }, body: a.text });
            if (res.status === 405 || res.status === 409) no('that is a folder, or its parent is missing');
            if (!res.ok) no(`${target.title}: ${res.status} ${res.statusText || ''}`.trim());
            return { text: `Written: ${shown(target, at)} (${bytes} bytes).`, size: bytes };
        },
        async 'files.move'(target, a, ctx) {
            const from = place(target, a.from);
            const to = place(target, a.to);
            await mkcolp(target, ctx, to);
            const res = await send(target, ctx, 'MOVE', from, { extra: { Destination: urlOf(baseOf(target), to), Overwrite: 'F' } });
            if (res.status === 404) no('nothing there to move');
            if (res.status === 412) no('something is there already');
            if (!res.ok) no(`${target.title}: ${res.status} ${res.statusText || ''}`.trim());
            return { text: `Moved: ${shown(target, from)} → ${shown(target, to)}.`, size: 0 };
        },
        async 'files.delete'(target, a, ctx) {
            const at = place(target, a.path);
            if (at === rootOf(target)) no('the folder itself is not deleted');
            const r = await propfind(target, ctx, at, 1);
            if (!r.ok) no('nothing there');
            const self = r.items.find((x) => x.abs === at);
            if (self?.isDir && r.items.some((x) => x.abs !== at)) no('that folder is not empty');
            const res = await send(target, ctx, 'DELETE', at);
            if (res.status === 404) no('nothing there');
            if (!res.ok) no(`${target.title}: ${res.status} ${res.statusText || ''}`.trim());
            return { text: `Deleted: ${shown(target, at)}.`, size: 0 };
        },
    };

    return {
        name: 'webdav',
        verbs: Object.keys(verbs),
        run(verb, target, a, ctx) {
            if (!verbs[verb]) no(`${verb} is not done by this connector`);
            return verbs[verb](target, a, ctx);
        },
        /* Nothing is held between calls. */
        close() {},
        shutdown() {},
    };
}
