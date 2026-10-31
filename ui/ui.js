/* THE SCREEN: what a person sees of the targets. The calls waiting for them,
 * as cards (Accept / Refuse / Always); the level of each target, with its
 * allow rules; the Stop button; the journal. The page that holds it (an
 * application, or `serve`) gives it a place, its words, and one function to
 * reach the keeper.
 *
 *   const s = mount(element, {
 *       call: (op, args) => Promise<{ ok, text, data }>,   the keeper, as this person
 *       words,                 the dictionary (ui/texts/en.json): what a person reads
 *       lang,                  for times
 *       agent,                 one agent's id (a page per conversation); else a choice of all
 *   });
 *   s.refresh();   something changed: read again
 *   s.destroy();
 *
 * Built element by element: nothing an agent sent is ever read as HTML.
 */

export const LEVELS = ['watch', 'propose', 'frame', 'free'];
export const KEYS = Object.freeze(['requests', 'access', 'journal', 'nothing-waits', 'no-agent', 'no-targets', 'no-journal',
    'accept', 'refuse', 'always', 'always-for', 'always-under', 'level-of', 'until',
    'level-watch', 'level-propose', 'level-frame', 'level-free', 'means-watch', 'means-propose', 'means-frame', 'means-free',
    'kind-computer', 'kind-ssh', 'kind-browser', 'kind-files', 'kind-screen', 'kind-device', 'kind-voicebox',
    'ask-terminal.run', 'ask-terminal.type', 'ask-terminal.open', 'ask-files.write', 'ask-files.move', 'ask-files.delete', 'ask-device.flash', 'ask-other', 'job', 'job-run', 'job-cancel',
    'did-yes', 'did-always', 'did-no', 'did-timeout', 'did-stopped', 'did-refused', 'did-read', 'did-rule', 'did-free', 'did-failed',
    'op-level', 'op-allow', 'op-unallow', 'op-stop', 'op-resume',
    'allowed', 'under', 'rule', 'rule-command', 'rule-path', 'add', 'cancel', 'remove', 'stop', 'stopped', 'resume', 'more', 'agent']);

/* Words with {name} holes filled. A missing word shows its key, so a gap is seen. */
export const fill = (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (values[k] ?? m));

/* How a rule reads: "git status", "under ~/Projects". */
export function ruleWords(rule, w) {
    if (rule.kind === 'path') return `${w('under')} ${rule.value}`;
    return rule.value;
}
/* The label of an Always button, or null when the request carries no rule. */
export function alwaysLabel(rule, w) {
    if (!rule) return null;
    if (rule.kind === 'path') return fill(w('always-under'), { path: rule.value });
    if (rule.kind === 'verb') return w('always');
    return fill(w('always-for'), { rule: rule.value });
}
/* What a journal line says of its decision: { key, tone } (tone: ok, no, dim). */
export function outcome(line) {
    if (line.op) return { key: `op-${line.op}`, tone: line.op === 'stop' ? 'no' : 'dim' };
    if (line.ok === false && line.decision !== 'no' && line.error) return { key: 'did-failed', tone: 'no' };
    switch (line.decision) {
        case 'auto': return { key: `did-${line.because ?? 'read'}`, tone: 'dim' };
        case 'yes': case 'always': return { key: `did-${line.decision}`, tone: 'ok' };
        default: return { key: `did-${line.decision}`, tone: 'no' };
    }
}

function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
}

export function mount(root, { call, words = {}, lang = 'en', agent = null } = {}) {
    const w = (k) => words[k] ?? k;
    const ui = { data: null, agent, adding: null, draft: { kind: 'command', value: '' }, limit: 30, error: '', busy: new Set(), places: new Map() };
    const box = h('div', { class: 'tether' });
    root.replaceChildren(box);
    let alive = true;
    const time = (iso) => { try { return new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }); } catch { return String(iso).slice(11, 16); } };
    const ask = async (op, args) => {
        const r = await call(op, args);
        ui.error = r.ok ? '' : r.text;
        if (!r.ok) paint();
        return r;
    };

    async function load() {
        const r = await call('state', { agent: ui.agent ?? undefined, limit: ui.limit });
        if (!r.ok) { ui.error = r.text; return; }
        ui.data = r.data;
        if (!ui.agent || !ui.data.agents.some((a) => a.id === ui.agent)) ui.agent = agent ?? ui.data.agents[0]?.id ?? null;
        if (!agent && ui.agent) { const again = await call('state', { agent: ui.agent, limit: ui.limit }); if (again.ok) ui.data = again.data; }
    }
    async function refresh() { if (!alive) return; try { await load(); } catch (e) { ui.error = String(e?.message ?? e); } paint(); }
    const act = (op, args) => async () => { await ask(op, args); await refresh(); };

    const nameOf = (id) => ui.data?.agents.find((a) => a.id === id)?.name ?? id;
    const targetOf = (id) => ui.data?.targets.find((t) => t.id === id);
    const isStopped = () => !!(ui.data?.stops['*'] || (ui.agent && ui.data?.stops[ui.agent]));

    /* ---- a call waiting for a person ---- */
    function card(r) {
        const t = targetOf(r.target.id);
        const level = t?.grants?.[r.agent.id]?.level ?? r.level;
        const title = fill(w(`ask-${r.verb}`) === `ask-${r.verb}` ? w('ask-other') : w(`ask-${r.verb}`), { target: r.target.title });
        const always = alwaysLabel(r.rule, w);
        const busy = ui.busy.has(r.id);
        const decide = (decision) => async () => {
            ui.busy.add(r.id); paint();
            await ask('decide', { id: r.id, decision });
            ui.busy.delete(r.id); await refresh();
        };
        const several = !agent && (ui.data?.agents.length ?? 0) > 1;
        return h('article', { class: 'tether-card tether-wait', 'data-request': r.id },
            h('h3', {}, h('span', { class: 'tether-dot', 'aria-hidden': 'true' }), title),
            r.detail ? h('pre', { class: 'tether-code' }, r.detail) : null,
            r.why ? h('p', { class: 'tether-why' }, r.why) : null,
            h('div', { class: 'tether-buttons' },
                h('button', { type: 'button', class: 'tether-accept', 'data-act': 'yes', disabled: busy, onclick: decide('yes') }, w('accept')),
                h('button', { type: 'button', class: 'tether-plain', 'data-act': 'no', disabled: busy, onclick: decide('no') }, w('refuse')),
                always ? h('button', { type: 'button', class: 'tether-soft', 'data-act': 'always', disabled: busy, onclick: decide('always') }, always) : null),
            h('p', { class: 'tether-foot' },
                `${several ? `${r.agent.name} · ` : ''}${fill(w('level-of'), { target: r.target.title })} ${w(`level-${level}`)} · ${w(`means-${level}`)} · ${fill(w('until'), { time: time(r.until) })}`));
    }
    /* A call a person decided, as it ended. */
    function ended(l) {
        const o = outcome(l);
        return h('article', { class: `tether-card tether-ended tether-${o.tone}`, 'data-ended': l.decision },
            h('h3', {}, h('span', { class: 'tether-dot', 'aria-hidden': 'true' }), `${w(o.key)} · ${time(l.at)}`),
            l.detail ? h('pre', { class: 'tether-code' }, l.detail) : h('p', { class: 'tether-why' }, fill(w(`ask-${l.verb}`), { target: l.target?.title ?? '' })));
    }
    /* An approved act that only this browser can do: a click runs it (jobs.js). */
    function job(j) {
        /* The same element from one paint to the next: the module draws in it while it runs. */
        if (!ui.places.has(j.id)) ui.places.set(j.id, h('div', { class: 'tether-job' }));
        const place = ui.places.get(j.id);
        const busy = ui.busy.has(j.id);
        const go = async () => {
            ui.busy.add(j.id);
            const { runJob } = await import('./jobs.js');
            await runJob(j, { call, root: place, words });
            ui.busy.delete(j.id); ui.places.delete(j.id); await refresh();
        };
        return h('article', { class: 'tether-card tether-wait', 'data-job': j.id },
            h('h3', {}, h('span', { class: 'tether-dot', 'aria-hidden': 'true' }), `${w('job')} · ${fill(w(`ask-${j.verb}`), { target: j.target.title })}`),
            busy ? null : h('div', { class: 'tether-buttons' },
                h('button', { type: 'button', class: 'tether-accept', 'data-act': 'run-job', onclick: () => { void go(); } }, w('job-run')),
                h('button', { type: 'button', class: 'tether-plain', 'data-act': 'cancel-job', onclick: act('job-done', { id: j.id, ok: false, text: 'cancelled by a person' }) }, w('job-cancel'))),
            place);
    }
    function requests() {
        const jobs = (ui.data?.jobs ?? []).filter((j) => !ui.agent || j.agent === ui.agent);
        const waiting = (ui.data?.approvals ?? []).filter((r) => !ui.agent || r.agent.id === ui.agent);
        const decided = (ui.data?.journal ?? []).filter((l) => !l.op && ['yes', 'always', 'no', 'timeout', 'stopped'].includes(l.decision) && l.verb).slice(0, 4);
        return h('section', { class: 'tether-col', 'aria-label': w('requests') },
            h('h2', {}, w('requests')),
            jobs.map(job),
            waiting.length ? waiting.map(card) : jobs.length ? null : h('p', { class: 'tether-empty' }, w('nothing-waits')),
            decided.map(ended));
    }

    /* ---- the level of each target, its rules, Stop ---- */
    function rules(t, g) {
        const list = g.rules ?? [];
        const adding = ui.adding === t.id;
        const parts = [h('span', { class: 'tether-dim' }, `${w('allowed')} `)];
        list.forEach((r, i) => {
            if (i) parts.push(h('span', { class: 'tether-dim' }, r.kind === 'path' ? ' · ' : ', '));
            parts.push(h('span', { class: 'tether-rule', 'data-rule': `${r.kind}:${r.value}` }, r.kind === 'path' ? `${w('under')} ${r.value}` : h('b', {}, r.value),
                h('button', { type: 'button', class: 'tether-x', 'data-act': 'remove-rule', 'aria-label': `${w('remove')} ${ruleWords(r, w)}`, title: w('remove'),
                    onclick: act('unallow', { target: t.id, agent: ui.agent, rule: r }) }, '×')));
        });
        const line = h('p', { class: 'tether-rules' }, ...parts,
            adding ? null : h('button', { type: 'button', class: 'tether-link', 'data-act': 'add-rule', onclick: () => { ui.adding = t.id; ui.draft = { kind: 'command', value: '' }; paint(); box.querySelector('.tether-addrule input')?.focus(); } }, `+ ${w('rule')}`));
        if (!adding) return line;
        const input = h('input', { type: 'text', value: ui.draft.value, 'aria-label': w('rule'), placeholder: ui.draft.kind === 'path' ? '~/Projects' : 'git status', maxlength: '300',
            oninput: (e) => { ui.draft.value = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') { ui.adding = null; paint(); } } });
        const add = async () => { if (!ui.draft.value.trim()) return; const r = await ask('allow', { target: t.id, agent: ui.agent, rule: { ...ui.draft } }); if (r.ok) ui.adding = null; await refresh(); };
        return h('div', {}, line, h('div', { class: 'tether-addrule' },
            h('select', { 'aria-label': w('rule'), onchange: (e) => { ui.draft.kind = e.target.value; paint(); } },
                ['command', 'path'].map((k) => h('option', { value: k, selected: ui.draft.kind === k }, w(`rule-${k}`)))),
            input,
            h('button', { type: 'button', class: 'tether-accept', 'data-act': 'save-rule', onclick: add }, w('add')),
            h('button', { type: 'button', class: 'tether-plain', onclick: () => { ui.adding = null; paint(); } }, w('cancel'))));
    }
    function target(t) {
        const g = t.grants?.[ui.agent] ?? null;
        return h('div', { class: 'tether-target', 'data-target': t.id },
            h('div', { class: 'tether-head' },
                h('div', { class: 'tether-name' }, h('b', {}, t.title), h('span', { class: 'tether-dim' }, w(`kind-${t.kind}`))),
                h('div', { class: 'tether-seg', role: 'group', 'aria-label': t.title }, LEVELS.map((l) => h('button', { type: 'button', 'data-level': l, 'aria-pressed': String(g?.level === l),
                    onclick: g?.level === l ? null : act('level', { target: t.id, agent: ui.agent, level: l }) }, w(`level-${l}`))))),
            g?.level === 'frame' ? rules(t, g) : null);
    }
    function access() {
        const agents = ui.data?.agents ?? [];
        const stopped = isStopped();
        const pick = !agent && agents.length > 1 ? h('label', { class: 'tether-pick' }, h('span', { class: 'tether-dim' }, w('agent')),
            h('select', { 'data-act': 'agent', onchange: (e) => { ui.agent = e.target.value; ui.adding = null; void refresh(); } }, agents.map((a) => h('option', { value: a.id, selected: a.id === ui.agent }, a.name)))) : null;
        const body = !ui.agent ? [h('p', { class: 'tether-empty' }, w('no-agent'))]
            : [
                ...(ui.data.targets.length ? ui.data.targets.map(target) : [h('p', { class: 'tether-empty' }, w('no-targets'))]),
                stopped
                    ? h('div', { class: 'tether-stopped', role: 'status' }, h('b', {}, w('stopped')), h('button', { type: 'button', class: 'tether-plain', 'data-act': 'resume', onclick: act('resume', { agent: ui.data.stops['*'] ? '*' : ui.agent }) }, w('resume')))
                    : h('button', { type: 'button', class: 'tether-stop', 'data-act': 'stop', onclick: act('stop', { agent: ui.agent }) }, w('stop')),
            ];
        return h('section', { class: 'tether-col', 'aria-label': w('access') },
            h('h2', {}, w('access')),
            h('div', { class: 'tether-panel' }, pick, ...body));
    }

    /* ---- the journal ---- */
    function journal() {
        const lines = ui.data?.journal ?? [];
        return h('section', { class: 'tether-col tether-wide', 'aria-label': w('journal') },
            h('h2', {}, w('journal')),
            lines.length ? h('ol', { class: 'tether-journal' }, lines.map((l) => {
                const o = outcome(l);
                const what = l.op === 'level' ? w(`level-${l.level}`) : l.rule ? ruleWords(l.rule, w) : l.detail || (l.verb ?? '');
                const by = l.by?.name && !l.op ? ` · ${l.by.name}` : '';
                return h('li', { 'data-line': l.op ?? l.decision },
                    h('time', { datetime: l.at }, time(l.at)),
                    h('span', { class: 'tether-where' }, l.target?.title ?? (l.agent?.name ?? '')),
                    h('code', {}, what),
                    h('span', { class: `tether-pill tether-${o.tone}` }, `${w(o.key)}${by}`));
            })) : h('p', { class: 'tether-empty' }, w('no-journal')),
            lines.length >= ui.limit ? h('button', { type: 'button', class: 'tether-link', 'data-act': 'more', onclick: () => { ui.limit += 50; void refresh(); } }, w('more')) : null);
    }

    function paint() {
        if (!alive) return;
        const focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute?.('data-act') : null;
        const parts = [];
        if (ui.error) parts.push(h('div', { class: 'tether-error', role: 'alert' }, ui.error));
        if (ui.data) parts.push(h('div', { class: 'tether-grid' }, requests(), access(), journal()));
        box.replaceChildren(...parts);
        if (ui.adding) box.querySelector?.('.tether-addrule input')?.focus();
        else if (focus) box.querySelector?.(`[data-act="${focus}"]`)?.focus();
    }

    void refresh();
    return { refresh, destroy() { alive = false; box.remove(); }, get state() { return { agent: ui.agent, waiting: ui.data?.approvals.length ?? 0 }; } };
}
