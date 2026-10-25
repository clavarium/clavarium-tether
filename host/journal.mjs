/* THE JOURNAL: one line per call and per change of rights, appended, never
 * rewritten. Who, which target, which verb, what exactly (the detail), the
 * decision and by whom, when, and the result's size and exit code.
 *
 *   journal.jsonl   in the keeper's store
 *
 * NEVER A SECRET, by two locks:
 *   - only the fields below are written: an output, a file's content, a
 *     config never reach this file, whatever the caller passes;
 *   - every secret the keeper handed to a connector is replaced by "[secret]"
 *     wherever it would appear (a command that echoed a password, say).
 */
import { appendFileSync, readFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const FIELDS = Object.freeze(['op', 'agent', 'target', 'verb', 'detail', 'why', 'decision', 'because', 'by', 'word', 'ok', 'error', 'size', 'exit', 'ms', 'rule', 'level']);
export const DETAIL_MAX = 2000;
export const HIDDEN = '[secret]';

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
            appendFileSync(FILE, `${JSON.stringify(line)}\n`);
            for (const fn of listeners) { try { fn(line); } catch { /* a listener's fault is its own */ } }
            return line;
        },
        /* Newest first. agent: an id; target: an id; since: an ISO time; limit: 1 to 1000. */
        read({ agent, target, since, limit = 100 } = {}) {
            let text = '';
            try { if (!lstatSync(FILE).isSymbolicLink()) text = readFileSync(FILE, 'utf8'); } catch { return []; }
            const most = Math.max(1, Math.min(1000, Number(limit) || 100));
            const out = [];
            const all = text.split('\n');
            for (let i = all.length - 1; i >= 0 && out.length < most; i--) {
                if (!all[i]) continue;
                let l; try { l = JSON.parse(all[i]); } catch { continue; }
                if (agent && l.agent?.id !== agent) continue;
                if (target && l.target?.id !== target) continue;
                if (since && !(l.at >= since)) continue;
                out.push(l);
            }
            return out;
        },
    };
}
