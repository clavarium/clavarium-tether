/* THE JOURNAL: one line per call and per change of rights, appended, never
 * rewritten. Who, which target, which verb, what exactly (the detail), the
 * decision and by whom, when, and the result's size and exit code; for an act a
 * person approved, the id of its request (so a page can say how that one ended).
 *
 *   journal.jsonl   in the keeper's store
 *
 * NEVER A SECRET, by two locks:
 *   - only the fields below are written: an output, a file's content, a
 *     config never reach this file, whatever the caller passes;
 *   - every secret the keeper handed to a connector is replaced by "[secret]"
 *     wherever it would appear (a command that echoed a password, say).
 */
import { appendFileSync, mkdirSync, lstatSync, openSync, readSync, closeSync, renameSync, existsSync, constants } from 'node:fs';
import { join } from 'node:path';

export const FIELDS = Object.freeze(['op', 'agent', 'target', 'verb', 'detail', 'why', 'decision', 'because', 'by', 'word', 'ok', 'error', 'size', 'exit', 'ms', 'rule', 'level', 'request', 'kind', 'ref', 'tool', 'class', 'edited', 'risk']);
export const DETAIL_MAX = 2000;
export const HIDDEN = '[secret]';
/* READ FROM ITS END (18-11: the page asked for the newest lines every 2.5 s and the whole journal was read each
   time; it only grows): backwards by CHUNK, at most SCAN_MAX of it; past ROTATE_MAX it is put aside whole
   (journal-<date>.jsonl, kept) and a new one starts. */
export const CHUNK = 64 * 1024;
export const SCAN_MAX = 8 * 1024 * 1024;
export const ROTATE_MAX = 32 * 1024 * 1024;

/* Every secret replaced in a text. Short values are skipped: a secret of two
 * letters would blank every word holding them, and is no secret. */
export function hide(text, secrets = []) {
    let out = String(text);
    for (const s of secrets) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join(HIDDEN);
    return out;
}
const clean = (v, secrets) => {
    if (typeof v === 'string') return hide(v, secrets).slice(0, DETAIL_MAX);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, secrets)]));
    return v;
};

export function openJournal(dir, { now = () => Date.now(), secrets = () => [] } = {}) {
    mkdirSync(dir, { recursive: true });
    const FILE = join(dir, 'journal.jsonl');
    const listeners = new Set();
    return {
        file: FILE,
        onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        append(entry = {}) {
            const known = [...secrets()];
            const line = { at: new Date(now()).toISOString() };
            for (const k of FIELDS) if (entry[k] !== undefined && entry[k] !== null && entry[k] !== '') line[k] = clean(entry[k], known);
            try { const st = lstatSync(FILE, { throwIfNoEntry: false }); if (st?.isFile() && st.size > ROTATE_MAX) { const aside = join(dir, `journal-${line.at.replace(/[:.]/g, '-')}.jsonl`); if (!existsSync(aside)) renameSync(FILE, aside); } } catch { /* kept as it is */ }
            appendFileSync(FILE, `${JSON.stringify(line)}\n`);
            for (const fn of listeners) { try { fn(line); } catch { /* a listener's fault is its own */ } }
            return line;
        },
        /* Newest first. agent: an id; target: an id; since: an ISO time; limit: 1 to 1000. */
        read({ agent, target, since, limit = 100 } = {}) {
            const most = Math.max(1, Math.min(1000, Number(limit) || 100));
            const out = [];
            let fd;
            try { const st = lstatSync(FILE); if (!st.isFile()) return []; fd = openSync(FILE, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return []; }
            try {
                let end = lstatSync(FILE).size; let rest = Buffer.alloc(0); let scanned = 0;
                /* Lines are written in time order: one older than `since` ends the read. */
                const take = (text) => {
                    if (!text) return true;
                    let l; try { l = JSON.parse(text); } catch { return true; }
                    if (since && !(l.at >= since)) return false;
                    if (agent && l.agent?.id !== agent) return true;
                    if (target && l.target?.id !== target) return true;
                    out.push(l); return out.length < most;
                };
                while (end > 0 && scanned < SCAN_MAX) {
                    const size = Math.min(CHUNK, end); const buf = Buffer.alloc(size);
                    readSync(fd, buf, 0, size, end - size);
                    end -= size; scanned += size;
                    let chunk = Buffer.concat([buf, rest]);
                    let nl = chunk.lastIndexOf(0x0a, chunk.length - 1);
                    let stop = chunk.length;
                    while (nl >= 0) {
                        if (!take(chunk.subarray(nl + 1, stop).toString('utf8').trim())) return out;
                        stop = nl; nl = nl > 0 ? chunk.lastIndexOf(0x0a, nl - 1) : -1;
                    }
                    rest = chunk.subarray(0, stop);
                }
                if (end === 0) take(rest.toString('utf8').trim());
                return out;
            } finally { closeSync(fd); }
        },
    };
}
