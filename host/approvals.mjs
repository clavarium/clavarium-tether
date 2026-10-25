/* THE APPROVALS: calls held until a person decides.
 *
 * A request is { id, agent, target, verb, detail, why, rule, level, at, until }.
 * It ends one way only, the first that comes:
 *
 *   yes       a person approves this call
 *   always    approves it, and the rule it carries is added (the keeper does)
 *   no        a person refuses it, with a word or not
 *   timeout   nobody answered before `until` (the host's time limit)
 *   stopped   a person stopped that agent, or everybody
 *
 * The clock is given (`now`), and time is looked at when `expire()` is called:
 * the keeper calls it with every pump, a test calls it after moving its clock.
 * No timer here, so nothing runs behind a test's back.
 */
import { randomUUID } from 'node:crypto';
import { Refused, no, oneLine } from '../server/verbs.mjs';

export const DECISIONS = Object.freeze(['yes', 'no', 'always']);
export const TIMEOUT_MS = 10 * 60_000;
export const WORD_MAX = 300;

export function approvals({ now = () => Date.now(), timeout = TIMEOUT_MS, onChange = () => {} } = {}) {
    const pending = new Map();
    const end = (id, outcome) => {
        const p = pending.get(id);
        if (!p) return null;
        pending.delete(id);
        p.resolve({ ...outcome, at: new Date(now()).toISOString() });
        try { onChange({ op: 'end', id, decision: outcome.decision }); } catch { /* its fault */ }
        return p.request;
    };
    return {
        timeout,
        /* A call held: { request, decision: Promise<{ decision, by?, word?, at }> }. */
        open(fields) {
            const id = randomUUID();
            const t = now();
            const request = { ...fields, id, at: new Date(t).toISOString(), until: new Date(t + timeout).toISOString() };
            let resolve;
            const decision = new Promise((r) => { resolve = r; });
            pending.set(id, { request, resolve, until: t + timeout });
            try { onChange({ op: 'open', id }); } catch { /* its fault */ }
            return { request, decision };
        },
        /* A person's decision. A request no longer waiting is refused: decided
           twice, or too late, the first word stands. */
        decide(id, decision, by = null, word = '') {
            if (!DECISIONS.includes(decision)) no(`a decision is one of: ${DECISIONS.join(', ')}`);
            if (!pending.has(id)) no('this request is no longer waiting');
            const w = oneLine(word, WORD_MAX);
            return end(id, { decision, ...(by ? { by } : {}), ...(w ? { word: w } : {}) });
        },
        /* Those whose time is up end as "timeout". How many ended. */
        expire() {
            let n = 0;
            const t = now();
            for (const [id, p] of [...pending]) if (t >= p.until) { end(id, { decision: 'timeout' }); n++; }
            return n;
        },
        /* Every request of an agent ("*": of everybody) ends as "stopped". */
        stop(agent = '*', by = null) {
            let n = 0;
            for (const [id, p] of [...pending]) if (agent === '*' || p.request.agent?.id === agent) { end(id, { decision: 'stopped', ...(by ? { by } : {}) }); n++; }
            return n;
        },
        list(agent) { return [...pending.values()].map((p) => p.request).filter((r) => !agent || r.agent?.id === agent); },
        get(id) { return pending.get(id)?.request ?? null; },
    };
}
export { Refused };
