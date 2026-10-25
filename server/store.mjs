/* THE STORE: the targets, who was given each, at which level, with which
 * rules; and who was stopped. Held by the keeper alone (the application, or
 * `tether serve`): an agent asks through its own folder and never writes here.
 *
 *   state.json     every target as it is now, rewritten whole (by a rename)
 *
 * The journal of what was done is beside it (host/journal.mjs), append-only.
 *
 * A TARGET HOLDS NO SECRET. Its `config` is what is not secret (a folder, a
 * host name); a password or a key is NAMED in `secrets` ({ password: "name" })
 * and asked of the application when the connector needs it. A config value
 * whose name says it is a secret is refused, so one cannot slip in by habit.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { KINDS, Refused, no, oneLine } from './verbs.mjs';
import { LEVELS, RULES_MAX, cleanRule } from './rights.mjs';

export { Refused };
export const TARGETS_MAX = 200;
const SECRET_NAME = /pass|secret|token|key|credential/i;
const idOf = (text) => oneLine(text, 60).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const empty = () => ({ v: 1, targets: {}, stopped: {} });

export function openStore(dir, { now = () => Date.now() } = {}) {
    mkdirSync(dir, { recursive: true });
    const STATE = join(dir, 'state.json');
    const read = () => {
        try { if (lstatSync(STATE).isSymbolicLink()) return empty(); } catch { return empty(); }
        try { const s = JSON.parse(readFileSync(STATE, 'utf8')); return s && s.v === 1 ? { ...empty(), ...s } : empty(); } catch { return empty(); }
    };
    let s = read();
    const listeners = new Set();
    const save = (what) => {
        const tmp = `${STATE}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, STATE);
        for (const fn of listeners) { try { fn(what); } catch { /* a listener's fault is its own */ } }
    };
    const targetOf = (id) => s.targets[oneLine(id, 100)] ?? no(`no target ${oneLine(id, 100) || '(none given)'}`);
    const shown = (t) => structuredClone(t);

    return {
        dir,
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        reload() { s = read(); },
        targets() { return Object.values(s.targets).map(shown); },
        target(id) { const t = s.targets[oneLine(id, 100)]; return t ? shown(t) : null; },
        /* A target added or changed. Its grants stay. */
        putTarget({ id, title, kind, connector, config = {}, secrets = {} } = {}) {
            const name = oneLine(title, 120);
            const key = idOf(id || name);
            if (!key) no('a target needs an id or a title');
            if (!KINDS.includes(kind)) no(`a target's kind is one of: ${KINDS.join(', ')}`);
            const conn = oneLine(connector, 40);
            if (!conn) no('say which connector reaches it');
            if (!s.targets[key] && Object.keys(s.targets).length >= TARGETS_MAX) no(`${TARGETS_MAX} targets at most`);
            const conf = {};
            for (const [k, v] of Object.entries(config ?? {})) {
                if (SECRET_NAME.test(k)) no(`"${k}" looks like a secret: name it in secrets, never in config`);
                conf[oneLine(k, 40)] = typeof v === 'number' || typeof v === 'boolean' ? v : oneLine(v, 1000);
            }
            const sec = Object.fromEntries(Object.entries(secrets ?? {}).map(([k, v]) => [oneLine(k, 40), oneLine(v, 200)]));
            const before = s.targets[key];
            s.targets[key] = { id: key, title: name || key, kind, connector: conn, config: conf, secrets: sec, grants: before?.grants ?? {}, created: before?.created ?? new Date(now()).toISOString() };
            save({ op: 'put-target', target: key });
            return shown(s.targets[key]);
        },
        removeTarget(id) { const t = targetOf(id); delete s.targets[t.id]; save({ op: 'remove-target', target: t.id }); return { id: t.id }; },
        /* A level given to an agent on a target; null takes the target back. Rules stay with the grant. */
        grant(target, agent, level) {
            const t = targetOf(target);
            const who = oneLine(agent, 100);
            if (!who) no('say which agent');
            if (level === null || level === undefined || level === 'none') delete t.grants[who];
            else {
                if (!LEVELS.includes(level)) no(`a level is one of: ${LEVELS.join(', ')}`);
                t.grants[who] = { level, rules: t.grants[who]?.rules ?? [] };
            }
            save({ op: 'grant', target: t.id, agent: who, level: level ?? null });
            return t.grants[who] ? structuredClone(t.grants[who]) : null;
        },
        grantOf(target, agent) { const g = s.targets[oneLine(target, 100)]?.grants?.[agent]; return g ? structuredClone(g) : null; },
        /* An allow rule added (once) to an agent's grant on a target. */
        allow(target, agent, rule) {
            const t = targetOf(target);
            const g = t.grants[agent] ?? no(`${agent} was not given ${t.title}`);
            const r = cleanRule(rule);
            if (r.refused) no(r.refused);
            if (!g.rules.some((x) => x.kind === r.kind && x.value === r.value)) {
                if (g.rules.length >= RULES_MAX) no(`${RULES_MAX} rules at most`);
                g.rules.push(r);
                save({ op: 'allow', target: t.id, agent, rule: r });
            }
            return r;
        },
        unallow(target, agent, rule) {
            const t = targetOf(target);
            const g = t.grants[agent] ?? no(`${agent} was not given ${t.title}`);
            const at = g.rules.findIndex((x) => x.kind === rule?.kind && x.value === rule?.value);
            if (at < 0) no('no such rule');
            const [gone] = g.rules.splice(at, 1);
            save({ op: 'unallow', target: t.id, agent, rule: gone });
            return gone;
        },
        /* Stopped: every call of that agent refused until a person opens again. "*" is everybody. */
        stopped(agent) { return !!(s.stopped['*'] || s.stopped[agent]); },
        stops() { return { ...s.stopped }; },
        stop(agent = '*') { s.stopped[oneLine(agent, 100) || '*'] = new Date(now()).toISOString(); save({ op: 'stop', agent }); },
        resume(agent = '*') {
            if (agent === '*') s.stopped = {}; else delete s.stopped[oneLine(agent, 100)];
            save({ op: 'resume', agent });
        },
    };
}
