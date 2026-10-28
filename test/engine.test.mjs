import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, ruleFrom, covers, cleanRule, normalPath, LEVELS } from '../server/rights.mjs';
import { check, detail, VERBS, reads } from '../server/verbs.mjs';
import { openStore } from '../server/store.mjs';
import { openJournal, hide } from '../host/journal.mjs';
import { approvals } from '../host/approvals.mjs';
import { keeper } from '../host/keeper.mjs';
import { local } from '../host/connectors/local.mjs';
import { ask, asked, TOOLS } from '../server/mcp.mjs';
import { read, run } from '../bin/cli.mjs';
import { NAME, FOLDER, VERSION, ENV_DIR } from '../server/name.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant · site' };
const OTHER = { id: 'agent:api', kind: 'agent', name: 'Assistant · api' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
/* A clock a test moves itself. */
const clock = (start = Date.parse('2026-10-25T10:00:00Z')) => { let t = start; const now = () => t; now.add = (ms) => { t += ms; }; return now; };
/* A connector that records what it was asked, and runs nothing. */
const fake = () => { const calls = []; return { calls, closed: [], run: async (verb, t, a) => { calls.push({ verb, a }); return { text: `did ${verb}`, size: 3, exit: 0 }; }, async close(agent) { this.closed.push(agent); } }; };
const tick = () => new Promise((r) => setImmediate(r));

test('the name is said in one place', () => {
    assert.equal(FOLDER, `.${NAME}`);
    assert.equal(ENV_DIR, `${NAME.toUpperCase()}_DIR`);
    assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, VERSION);
});

test('levels: watch reads, propose asks, frame asks what no rule covers, free does', () => {
    assert.deepEqual(LEVELS, ['watch', 'propose', 'frame', 'free']);
    const rules = [{ kind: 'command', value: 'git status' }, { kind: 'path', value: '~/Projects' }];
    assert.equal(decide('watch', 'files.read', { path: 'a' }).go, 'yes');
    assert.equal(decide('watch', 'terminal.run', { command: 'ls' }).go, 'no');
    assert.equal(decide('propose', 'terminal.run', { command: 'git status' }, rules).go, 'ask', 'propose asks, rules or not');
    assert.deepEqual(decide('frame', 'terminal.run', { command: 'git status --short' }, rules), { go: 'yes', because: 'rule', rule: rules[0] });
    assert.equal(decide('frame', 'terminal.run', { command: 'git stash' }, rules).go, 'ask');
    assert.equal(decide('frame', 'files.write', { path: '~/Projects/a/b.txt' }, rules).go, 'yes');
    assert.equal(decide('frame', 'files.write', { path: '~/Projects/../secret' }, rules).go, 'ask');
    assert.equal(decide('free', 'files.delete', { path: '/etc/x' }).go, 'yes');
    assert.equal(decide('nonsense', 'files.read', {}).go, 'no');
    for (const v of ['terminal.read', 'files.list', 'files.read', 'files.search', 'browser.tabs', 'browser.shot', 'browser.html', 'browser.console']) assert.ok(reads(v), v);
    for (const v of ['terminal.open', 'terminal.type', 'terminal.run', 'files.write', 'files.move', 'files.delete', 'browser.eval']) assert.ok(!reads(v), v);
});

test('a command with shell control is never covered by a rule, nor made into one', () => {
    const r = { kind: 'command', value: 'git status' };
    for (const c of ['git status; rm -rf ~', 'git status && curl x', 'git status | sh', 'git status `id`', 'git status $(id)', 'git status > /etc/passwd', 'git status \\; x']) {
        assert.equal(covers(r, 'terminal.run', { command: c }), false, c);
        assert.equal(ruleFrom('terminal.run', { command: c }), null, c);
    }
    assert.equal(covers(r, 'terminal.run', { command: 'git  status   -s' }), true);
    assert.equal(covers(r, 'terminal.type', { text: 'git status' }), false, 'command rules are for run only');
    assert.ok(cleanRule({ kind: 'command', value: 'ls; id' }).refused);
});

test('"always" builds the narrowest rule that covers the call again', () => {
    assert.deepEqual(ruleFrom('terminal.run', { command: 'sudo apt upgrade -y' }), { kind: 'command', value: 'sudo apt upgrade' });
    assert.deepEqual(ruleFrom('terminal.run', { command: 'git pull --rebase' }), { kind: 'command', value: 'git pull' });
    assert.deepEqual(ruleFrom('terminal.run', { command: 'cat notes.txt' }), { kind: 'command', value: 'cat' });
    assert.deepEqual(ruleFrom('files.write', { path: 'site/a.html' }), { kind: 'path', value: '~/site' });
    assert.deepEqual(ruleFrom('files.write', { path: 'a.html' }), { kind: 'path', value: '~' });
    assert.deepEqual(ruleFrom('files.move', { from: '~/a/b/c.txt', to: '~/a/d/c.txt' }), { kind: 'path', value: '~/a' });
    assert.deepEqual(ruleFrom('terminal.open', {}), { kind: 'verb', value: 'terminal.open' });
    assert.equal(ruleFrom('terminal.type', { text: 'y' }), null, 'typing is asked each time');
    for (const [verb, a] of [['terminal.run', { command: 'sudo apt upgrade -y' }], ['files.write', { path: 'site/x/y.html' }], ['files.move', { from: '~/a/b/c', to: '~/a/d' }]]) {
        assert.ok(covers(ruleFrom(verb, a), verb, a), `${verb} covered again`);
    }
    assert.equal(normalPath('a/../../b'), null);
    assert.equal(normalPath('./a//b/'), '~/a/b');
    assert.equal(normalPath('/etc/../var'), '/var');
});

test('a verb\'s arguments are checked; its detail never holds a file\'s content', () => {
    assert.throws(() => check('terminal.run', { target: 'x' }), /needs command/);
    assert.throws(() => check('terminal.run', { command: 'ls' }), /which target/);
    assert.throws(() => check('fly', {}), /no verb/);
    assert.equal(check('files.list', { target: 'x' }).path, '.');
    assert.equal(detail('files.write', check('files.write', { target: 'x', path: 'a.txt', text: 'the secret plan' })), 'a.txt (15 bytes)');
    assert.equal(detail('files.move', { from: 'a', to: 'b' }), 'a → b');
    /* The browser verbs are live (none is merely declared), and their args are checked. */
    assert.equal(Object.keys(VERBS).filter((v) => VERBS[v].done === false).length, 0, 'no verb is left merely declared');
    assert.equal(check('browser.eval', { target: 'b', script: '1+1', tab: 7 }).tab, 7);
    assert.throws(() => check('browser.click', { target: 'b' }), /selector or x and y/);
    assert.equal(detail('browser.click', check('browser.click', { target: 'b', selector: '.buy' })), '.buy');
    assert.equal(detail('browser.open', check('browser.open', { target: 'b', url: 'https://example.com' })), 'https://example.com');
});

test('an approval detail names the action, never a raw provider id', () => {
    const longId = 'AAMkAGVkZjQ5OThmLTYxNTktNDgxOS04MmYyLTVkZWYxOGExNmNmMw==';
    assert.equal(detail('calendar.attach', { attachName: 'slides.pdf', id: longId }), 'slides.pdf → an event');
    assert.equal(detail('calendar.delete', { id: longId }), 'delete an event');
    assert.equal(detail('calendar.respond', { answer: 'decline', id: longId }), 'decline an invitation');
    assert.equal(detail('contacts.delete', { id: longId }), 'delete a contact');
    for (const [v, a] of [['calendar.detach', { which: 'x', id: longId }], ['calendar.update', { id: longId }], ['contacts.update', { id: longId }], ['contacts.attach', { id: longId }], ['mail.delete', { uid: longId }], ['mail.move', { uid: longId, mailbox: 'Archive' }], ['mail.flag', { uid: longId, flag: 'read' }]])
        assert.ok(!detail(v, a).includes(longId), `${v} must not dump the raw id into the approval line`);
});

test('the store: a target holds no secret; grants, rules and stops are kept across a restart', () => {
    const dir = tmp();
    const s = openStore(dir);
    assert.throws(() => s.putTarget({ id: 'web', kind: 'ssh', connector: 'ssh', config: { password: 'x' } }), /looks like a secret/);
    assert.throws(() => s.putTarget({ id: 'web', kind: 'boat', connector: 'ssh' }), /kind/);
    s.putTarget({ id: 'web', title: 'Web server', kind: 'ssh', connector: 'ssh', config: { host: 'web.example.com' }, secrets: { key: 'web-key' } });
    s.grant('web', BOT.id, 'frame');
    s.allow('web', BOT.id, { kind: 'command', value: 'git   status' });
    s.allow('web', BOT.id, { kind: 'command', value: 'git status' });
    assert.throws(() => s.grant('web', BOT.id, 'god'), /level/);
    s.stop(BOT.id);
    const again = openStore(dir);
    assert.deepEqual(again.grantOf('web', BOT.id), { level: 'frame', rules: [{ kind: 'command', value: 'git status' }] });
    assert.equal(again.stopped(BOT.id), true);
    assert.equal(again.stopped(OTHER.id), false);
    again.resume(BOT.id);
    assert.equal(again.stopped(BOT.id), false);
    again.unallow('web', BOT.id, { kind: 'command', value: 'git status' });
    assert.deepEqual(again.grantOf('web', BOT.id).rules, []);
    assert.equal(again.target('web').secrets.key, 'web-key', 'a secret is named, its value is elsewhere');
});

test('the journal: appended, newest first, filtered; only its own fields; secrets hidden', () => {
    const dir = tmp(); const now = clock(); const secrets = new Set(['hunter2-long']);
    const j = openJournal(dir, { now, secrets: () => secrets });
    j.append({ agent: { id: 'a' }, target: { id: 't' }, verb: 'terminal.run', detail: 'echo hunter2-long', decision: 'yes', output: 'hunter2-long', text: 'file body', config: { x: 1 } });
    now.add(1000);
    j.append({ agent: { id: 'b' }, target: { id: 't' }, verb: 'files.read', detail: 'a', decision: 'auto' });
    const raw = readFileSync(j.file, 'utf8');
    assert.doesNotMatch(raw, /hunter2-long/);
    assert.doesNotMatch(raw, /file body|output|config/);
    assert.match(raw, /echo \[secret\]/);
    assert.equal(raw.trim().split('\n').length, 2);
    assert.deepEqual(j.read().map((l) => l.agent.id), ['b', 'a']);
    assert.deepEqual(j.read({ agent: 'a' }).map((l) => l.verb), ['terminal.run']);
    assert.equal(j.read({ since: '2026-10-25T10:00:00.500Z' }).length, 1);
    assert.equal(hide('ab ab', ['ab']), 'ab ab', 'a two-letter secret is no secret');
});

test('approvals: yes, no with a word, always; decided once; a timeout by the clock; stop ends what waits', async () => {
    const now = clock();
    const q = approvals({ now, timeout: 60_000 });
    const a = q.open({ agent: { id: 'x' }, verb: 'terminal.run', detail: 'ls' });
    assert.equal(a.request.until, '2026-10-25T10:01:00.000Z');
    q.decide(a.request.id, 'yes', { id: 'p', name: 'P' });
    assert.equal((await a.decision).decision, 'yes');
    assert.throws(() => q.decide(a.request.id, 'no'), /no longer waiting/);
    const b = q.open({ agent: { id: 'x' } });
    assert.throws(() => q.decide(b.request.id, 'maybe'), /one of/);
    q.decide(b.request.id, 'no', { id: 'p', name: 'P' }, ' not now ');
    assert.deepEqual(await b.decision, { decision: 'no', by: { id: 'p', name: 'P' }, word: 'not now', at: '2026-10-25T10:00:00.000Z' });
    const c = q.open({ agent: { id: 'x' } });
    now.add(59_999); assert.equal(q.expire(), 0);
    now.add(1); assert.equal(q.expire(), 1);
    assert.equal((await c.decision).decision, 'timeout');
    const d = q.open({ agent: { id: 'x' } }); const e = q.open({ agent: { id: 'y' } });
    assert.equal(q.stop('x'), 1);
    assert.equal((await d.decision).decision, 'stopped');
    assert.deepEqual(q.list().map((r) => r.id), [e.request.id]);
    assert.equal(q.stop(), 1);
    assert.equal(q.list().length, 0);
});

/* A keeper with one target given to BOT, through a connector that runs nothing. */
const setup = (level, opts = {}) => {
    const now = clock(); const conn = fake(); const asked = [];
    const k = keeper(tmp(), { now, timeout: 60_000, connectors: { fake: conn }, ask: opts.ask ?? ((r) => { asked.push(r); return undefined; }), ...opts });
    k.store.putTarget({ id: 'web', title: 'Web server', kind: 'ssh', connector: 'fake' });
    if (level) k.store.grant('web', BOT.id, level);
    return { k, now, conn, asked };
};

test('the keeper: a call that needs a person waits; Accept runs it, Refuse refuses it with the word', async () => {
    const { k, conn, asked } = setup('propose');
    const p = k.act('terminal.run', { target: 'web', command: 'sudo apt upgrade -y', why: 'Install 14 updates.' }, BOT);
    await tick();
    assert.equal(asked.length, 1, 'the host was asked');
    const [req] = k.approvals();
    assert.equal(req.detail, 'sudo apt upgrade -y'); assert.equal(req.why, 'Install 14 updates.');
    assert.deepEqual(req.rule, { kind: 'command', value: 'sudo apt upgrade' });
    assert.equal(conn.calls.length, 0, 'nothing runs before a person said yes');
    k.decide(req.id, 'yes', ME);
    const r = await p;
    assert.equal(r.ok, true); assert.equal(r.text, 'did terminal.run'); assert.deepEqual(r.data, { exit: 0, size: 3 });
    const q = k.act('files.delete', { target: 'web', path: 'old.log' }, BOT);
    await tick();
    k.decide(k.approvals()[0].id, 'no', ME, 'keep it');
    assert.deepEqual(await q, { ok: false, text: 'refused by Owner: "keep it"' });
    assert.equal(conn.calls.length, 1);
    const j = k.journal({ limit: 5 });
    assert.deepEqual(j.map((l) => l.decision), ['no', 'yes']);
    assert.equal(j[1].by.name, 'Owner'); assert.equal(j[1].exit, 0); assert.equal(j[1].size, 3);
});

test('the keeper: Always approves, adds the rule, and the same call no longer asks', async () => {
    const { k, conn } = setup('propose');
    const p = k.act('terminal.run', { target: 'web', command: 'git pull' }, BOT);
    await tick();
    k.decide(k.approvals()[0].id, 'always', ME);
    assert.equal((await p).ok, true);
    assert.deepEqual(k.store.grantOf('web', BOT.id), { level: 'frame', rules: [{ kind: 'command', value: 'git pull' }] }, 'propose moved to frame with the rule');
    const again = await k.act('terminal.run', { target: 'web', command: 'git pull --rebase' }, BOT);
    assert.equal(again.ok, true);
    assert.equal(k.approvals().length, 0);
    assert.equal(conn.calls.length, 2);
    const j = k.journal({ limit: 10 });
    assert.equal(j[0].decision, 'auto'); assert.equal(j[0].because, 'rule');
    assert.ok(j.some((l) => l.op === 'allow' && l.rule.value === 'git pull'));
    assert.ok(j.some((l) => l.op === 'level' && l.level === 'frame'));
});

test('the keeper: the host\'s ask callback may decide, as a word or with who', async () => {
    const { k } = setup('propose', { ask: async () => ({ decision: 'no', by: { id: 'p:phone', name: 'Phone' }, word: 'later' }) });
    assert.deepEqual(await k.act('terminal.run', { target: 'web', command: 'ls' }, BOT), { ok: false, text: 'refused by Phone: "later"' });
    const yes = setup('propose', { ask: async () => 'yes' });
    assert.equal((await yes.k.act('terminal.run', { target: 'web', command: 'ls' }, BOT)).ok, true);
});

test('the keeper: not answered in time is refused, by the injected clock', async () => {
    const { k, now, conn } = setup('propose');
    const p = k.act('terminal.run', { target: 'web', command: 'reboot' }, BOT);
    await tick();
    now.add(59_000); k.pump(); await tick();
    assert.equal(k.approvals().length, 1);
    now.add(1_000); k.pump();
    assert.deepEqual(await p, { ok: false, text: 'not answered within 1 minute: nothing was done' });
    assert.equal(conn.calls.length, 0);
    assert.equal(k.journal({ limit: 1 })[0].decision, 'timeout');
});

test('the keeper: stop refuses what waits, closes the sessions, refuses what comes; resume opens again', async () => {
    const { k, conn } = setup('propose');
    k.store.grant('web', OTHER.id, 'free');
    const p = k.act('terminal.run', { target: 'web', command: 'make deploy' }, BOT);
    await tick();
    await k.stop(BOT.id, ME);
    assert.deepEqual(await p, { ok: false, text: 'a person stopped everything for you: nothing was done' });
    assert.deepEqual(conn.closed, [BOT.id]);
    assert.equal((await k.act('files.read', { target: 'web', path: 'a' }, BOT)).ok, false, 'even reads');
    assert.equal((await k.act('targets', {}, BOT)).ok, false);
    assert.equal((await k.act('terminal.run', { target: 'web', command: 'ls' }, OTHER)).ok, true, 'another agent goes on');
    await k.stop(undefined, ME);
    assert.equal((await k.act('files.read', { target: 'web', path: 'a' }, OTHER)).ok, false, 'stop for everybody');
    k.resume('*', ME);
    assert.equal((await k.act('files.read', { target: 'web', path: 'a' }, BOT)).ok, true);
    const ops = k.journal({ limit: 20 }).map((l) => l.op).filter(Boolean);
    assert.deepEqual(ops, ['resume', 'stop', 'stop']);
});

test('the keeper: watch refuses an action; a target not given, a kind that does not fit, a browser verb, a connector off are refused', async () => {
    const { k } = setup('watch');
    assert.match((await k.act('terminal.run', { target: 'web', command: 'ls' }, BOT)).text, /level watch: read only/);
    assert.equal((await k.act('terminal.read', { target: 'web' }, BOT)).ok, true);
    assert.match((await k.act('files.read', { target: 'web', path: 'a' }, OTHER)).text, /no target web that you were given/);
    k.store.putTarget({ id: 'tab', title: 'A tab', kind: 'browser', connector: 'browser' });
    k.store.grant('tab', BOT.id, 'free');
    assert.match((await k.act('terminal.run', { target: 'tab', command: 'ls' }, BOT)).text, /not for a browser target/);
    assert.match((await k.act('browser.tabs', { target: 'tab' }, BOT)).text, /connector is off/, 'a browser verb with no browser connector wired');
    k.store.putTarget({ id: 'pc', title: 'PC', kind: 'computer', connector: 'local' });
    k.store.grant('pc', BOT.id, 'free');
    assert.match((await k.act('files.list', { target: 'pc' }, BOT)).text, /connector is off/, 'local is off unless asked for');
    const t = await k.act('targets', {}, BOT);
    assert.deepEqual(t.data.map((x) => [x.id, x.level]), [['web', 'watch'], ['tab', 'free'], ['pc', 'free']]);
    assert.match(t.text, /web \(ssh\) "Web server": watch: read only/);
});

test('the keeper: secrets come from the host by name, never reach the agent or the journal', async () => {
    const SECRET = 'correct-horse-battery';
    const conn = { run: async (verb, t, a, ctx) => { const s = await ctx.secret('password'); return { text: `logged in with ${s}`, size: 1, exit: 0 }; } };
    const k = keeper(tmp(), { connectors: { vault: conn }, secrets: async (name) => (name === 'web-pass' ? SECRET : '') });
    k.store.putTarget({ id: 'web', kind: 'ssh', connector: 'vault', secrets: { password: 'web-pass' } });
    k.store.grant('web', BOT.id, 'free');
    const r = await k.act('terminal.run', { target: 'web', command: `echo ${SECRET}` }, BOT);
    assert.equal(r.text, 'logged in with [secret]');
    const raw = readFileSync(join(k.store.dir, 'journal.jsonl'), 'utf8') + readFileSync(join(k.store.dir, 'state.json'), 'utf8');
    assert.doesNotMatch(raw, new RegExp(SECRET));
    const shown = await k.act('targets', {}, ME);
    assert.deepEqual(shown.data[0].secrets, ['password'], 'a page sees which secrets are named, not their names in the host store');
});

test('a person\'s changes from the page: level, rules, decide, stop, all in the journal', async () => {
    const sides = [{ dir: tmp(), who: BOT }];
    const k = keeper(tmp(), { sides: () => sides, connectors: { fake: fake() } });
    k.store.putTarget({ id: 'web', title: 'Web', kind: 'ssh', connector: 'fake' });
    assert.equal((await k.act('level', { target: 'web', agent: BOT.id, level: 'frame' }, ME)).ok, true);
    assert.equal((await k.act('allow', { target: 'web', agent: BOT.id, rule: { kind: 'path', value: 'site/../site/www' } }, ME)).data.value, '~/site/www');
    assert.equal((await k.act('allow', { target: 'web', agent: BOT.id, rule: { kind: 'command', value: 'ls && id' } }, ME)).ok, false);
    const st = (await k.act('state', {}, ME)).data;
    assert.deepEqual(st.agents, [BOT]);
    assert.deepEqual(st.targets[0].grants[BOT.id], { level: 'frame', rules: [{ kind: 'path', value: '~/site/www' }] });
    assert.deepEqual(st.journal.map((l) => l.op), ['allow', 'level']);
    assert.equal(st.journal[1].agent.name, BOT.name);
    assert.equal((await k.act('decide', { id: 'nope', decision: 'yes' }, ME)).text, 'this request is no longer waiting');
    assert.equal((await k.act('fly', {}, ME)).ok, false);
});

test('through the folder: the agent waits while a person decides, then gets the answer', async () => {
    const side = tmp();
    const k = keeper(tmp(), { sides: () => [{ dir: side, who: BOT }], connectors: { fake: fake() } });
    k.store.putTarget({ id: 'web', title: 'Web', kind: 'ssh', connector: 'fake' });
    k.store.grant('web', BOT.id, 'propose');
    const timer = setInterval(() => k.pump(), 10);
    try {
        let heldUntil = null;
        const p = ask(side, 'terminal.run', { target: 'web', command: 'ls' }, { wait: 2000, every: 10, onHeld: (u) => { heldUntil = u; } });
        while (!k.approvals().length) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 50));
        assert.ok(heldUntil, 'the agent was told it waits for a person');
        k.decide(k.approvals()[0].id, 'yes', ME);
        const r = await p;
        assert.equal(r.ok, true); assert.equal(r.held, true);
        const cli = await run(['files', 'web', 'list'], { env: { [ENV_DIR]: side }, wait: 2000 });
        assert.equal(cli.code, 0, cli.err);
        assert.equal(cli.out, 'did files.list\n');
    } finally { clearInterval(timer); }
});

test('through the folder: too old is not done; held by a keeper that restarted is not done; nobody keeping says so', async () => {
    const side = tmp();
    const k = keeper(tmp(), { sides: () => [{ dir: side, who: BOT }], connectors: { fake: fake() } });
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'old', at: new Date(Date.now() - 120_000).toISOString(), op: 'targets', args: {} })}\n`);
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'held', at: new Date().toISOString(), op: 'targets', args: {} })}\n`);
    appendFileSync(join(side, 'answers.jsonl'), `${JSON.stringify({ ask: 'held', held: true, until: new Date().toISOString() })}\n`);
    assert.equal(k.pump(), 2);
    const answers = readFileSync(join(side, 'answers.jsonl'), 'utf8');
    assert.match(answers, /too late/); assert.match(answers, /keeper restarted/);
    assert.equal(k.pump(), 0, 'answered once');
    const nobody = await run(['targets'], { env: { [ENV_DIR]: tmp() }, wait: 200 });
    assert.equal(nobody.code, 3);
    assert.match(nobody.err, /nobody keeps these targets/);
});

test('the command line is read as the help says', () => {
    assert.deepEqual(read([]), ['targets', {}]);
    assert.deepEqual(read(['run', 'web', 'git', 'status', '--why', 'see what changed']), ['terminal.run', { target: 'web', command: 'git status', why: 'see what changed' }]);
    assert.deepEqual(read(['run', 'web', 'make', '--timeout', '120']), ['terminal.run', { target: 'web', command: 'make', timeout: 120 }]);
    assert.deepEqual(read(['type', 'web', 'q', '--enter']), ['terminal.type', { target: 'web', text: 'q', enter: true }]);
    assert.deepEqual(read(['read', 'web', '--lines', '10']), ['terminal.read', { target: 'web', lines: 10 }]);
    assert.deepEqual(read(['open', 'web']), ['terminal.open', { target: 'web' }]);
    assert.deepEqual(read(['files', 'web', 'list']), ['files.list', { target: 'web', path: '.' }]);
    assert.deepEqual(read(['files', 'web', 'search', 'todo', '--in', 'src']), ['files.search', { target: 'web', text: 'todo', path: 'src' }]);
    assert.deepEqual(read(['files', 'web', 'write', 'a.txt', '--text', 'hi']), ['files.write', { target: 'web', path: 'a.txt', text: 'hi' }]);
    assert.deepEqual(read(['files', 'web', 'move', 'a', 'b']), ['files.move', { target: 'web', from: 'a', to: 'b' }]);
    assert.deepEqual(read(['files', 'web', 'delete', 'a']), ['files.delete', { target: 'web', path: 'a' }]);
    assert.ok(read(['files', 'web', 'write', 'a.txt']).refused, 'write needs --text or --from');
    assert.ok(read(['files', 'web', 'write', 'a.txt', '--text', 'x', '--from', 'y']).refused);
    /* mail / calendar / contacts, as the help says */
    assert.deepEqual(read(['mail', 'box', 'list']), ['mail.list', { target: 'box' }]);
    assert.deepEqual(read(['mail', 'box', 'list', '--mailbox', 'Sent']), ['mail.list', { target: 'box', mailbox: 'Sent' }]);
    assert.deepEqual(read(['mail', 'box', 'read', '42']), ['mail.read', { target: 'box', uid: '42' }]);
    assert.deepEqual(read(['mail', 'box', 'search', 'invoice march']), ['mail.search', { target: 'box', text: 'invoice march' }]);
    assert.deepEqual(read(['mail', 'box', 'move', '42', 'Archive', '--why', 'done']), ['mail.move', { target: 'box', uid: '42', mailbox: 'Archive', why: 'done' }]);
    assert.deepEqual(read(['mail', 'box', 'flag', '42', 'read']), ['mail.flag', { target: 'box', uid: '42', flag: 'read' }]);
    assert.deepEqual(read(['mail', 'box', 'send', '--to', 'a@example.com', '--subject', 'Hi', '--body', 'there']), ['mail.send', { target: 'box', to: 'a@example.com', subject: 'Hi', body: 'there' }]);
    assert.ok(read(['mail', 'box', 'send', '--to', 'a@example.com']).refused, 'send needs subject and body');
    assert.ok(read(['mail', 'box', 'move', '42']).refused, 'move needs a destination');
    assert.ok(read(['mail', 'box', 'nope']).refused);
    assert.deepEqual(read(['calendar', 'cal', 'list']), ['calendar.list', { target: 'cal' }]);
    assert.deepEqual(read(['calendar', 'cal', 'read', 'ev1']), ['calendar.read', { target: 'cal', id: 'ev1' }]);
    assert.deepEqual(read(['calendar', 'cal', 'create', '--title', 'Lunch', '--start', '2026-01-01T12:00:00Z', '--end', '2026-01-01T13:00:00Z', '--where', 'Paris']), ['calendar.create', { target: 'cal', title: 'Lunch', start: '2026-01-01T12:00:00Z', end: '2026-01-01T13:00:00Z', where: 'Paris' }]);
    assert.ok(read(['calendar', 'cal', 'create', '--title', 'X']).refused, 'create needs start and end');
    assert.deepEqual(read(['contacts', 'ab', 'list']), ['contacts.list', { target: 'ab' }]);
    assert.deepEqual(read(['contacts', 'ab', 'read', 'c7']), ['contacts.read', { target: 'ab', id: 'c7' }]);
    assert.ok(read(['contacts', 'ab', 'read']).refused);
    assert.ok(read(['run', 'web']).refused);
    assert.ok(read(['fly']).refused);
    assert.ok(read(['run', 'web', 'ls', '--why']).refused);
});

test('the MCP tools map to the verbs, and each verb they name exists and is done', () => {
    assert.deepEqual(asked('terminal-run', { target: 'web', command: 'ls', why: 'look', extra: 1 }), ['terminal.run', { target: 'web', command: 'ls', why: 'look' }]);
    assert.deepEqual(asked('targets', {}), ['targets', {}]);
    assert.deepEqual(asked('files-move', { target: 'w', from: 'a', to: 'b' }), ['files.move', { target: 'w', from: 'a', to: 'b' }]);
    assert.deepEqual(asked('browser-eval', { target: 'b', tab: 7, script: '1+1', why: 'check', extra: 1 }), ['browser.eval', { target: 'b', tab: 7, script: '1+1', why: 'check' }]);
    for (const t of TOOLS) {
        assert.match(t.name, /^[a-z-]{1,64}$/);
        const [verb] = asked(t.name, {});
        assert.ok(VERBS[verb] && VERBS[verb].done !== false, t.name);
        for (const k of t.inputSchema.required) assert.ok(k in t.inputSchema.properties, `${t.name}.${k}`);
    }
    const acting = TOOLS.filter((t) => !reads(asked(t.name, {})[0]) && t.name !== 'targets');
    assert.ok(acting.every((t) => 'why' in t.inputSchema.properties), 'every acting tool takes a why');
});

test('the local connector: a clean environment, a folder it does not leave, output and exit code', async () => {
    const folder = tmp(); const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'no');
    symlinkSync(outside, join(folder, 'door'));
    const c = local({ socket: `tether-test-${process.pid}`, env: { PATH: process.env.PATH, HOME: folder, LANG: 'C.UTF-8', TERM: 'dumb', SHELL: '/bin/bash' } });
    const t = { id: 'pc', title: 'PC', kind: 'computer', connector: 'local', config: { folder } };
    const ctx = { agent: BOT.id };
    try {
        process.env.TETHER_TEST_SECRET = 'should-not-show';
        const r = await c.run('terminal.run', t, { command: 'echo $TETHER_TEST_SECRET; pwd; exit 3' }, ctx);
        assert.equal(r.exit, 3);
        assert.doesNotMatch(r.text, /should-not-show/);
        assert.match(r.text, /\[exit 3\]$/);
        await c.run('files.write', t, { path: 'a/b.txt', text: 'hello world' }, ctx);
        assert.equal((await c.run('files.read', t, { path: '~/a/b.txt' }, ctx)).text, 'hello world');
        assert.match((await c.run('files.search', t, { path: '.', text: 'world' }, ctx)).text, /~\/a\/b.txt:1: hello world/);
        await c.run('files.move', t, { from: 'a/b.txt', to: 'c.txt' }, ctx);
        assert.match((await c.run('files.list', t, { path: '.' }, ctx)).text, /c.txt/);
        await assert.rejects(c.run('files.read', t, { path: 'door/secret.txt' }, ctx), /outside the folder/);
        await assert.rejects(c.run('files.read', t, { path: '../x' }, ctx), /climbs above/);
        await assert.rejects(c.run('files.read', t, { path: '/etc/hostname' }, ctx), /outside the folder/);
        await assert.rejects(c.run('files.delete', t, { path: '.' }, ctx), /folder itself/);
        await c.run('files.delete', t, { path: 'c.txt' }, ctx);
        assert.equal(existsSync(join(folder, 'c.txt')), false);
        const slow = await c.run('terminal.run', t, { command: 'sleep 5', timeout: 0.2 }, ctx);
        assert.match(slow.text, /stopped after 0.2 s/);
        await c.run('terminal.open', t, {}, ctx);
        await c.run('terminal.type', t, { text: 'echo typed-$((40+2))', enter: true }, ctx);
        let screen = '';
        for (let i = 0; i < 50 && !/typed-42/.test(screen); i++) { await new Promise((r) => setTimeout(r, 50)); screen = (await c.run('terminal.read', t, {}, ctx)).text; }
        assert.match(screen, /typed-42/);
        await c.close(BOT.id);
        await assert.rejects(c.run('terminal.read', t, {}, ctx), /no terminal open/);
    } finally { delete process.env.TETHER_TEST_SECRET; await c.shutdown(); }
});

test('the MCP server over standard input: initialize, the tools, a call through the folder', async () => {
    const { PassThrough } = await import('node:stream');
    const { serve } = await import('../server/mcp.mjs');
    const side = tmp();
    const k = keeper(tmp(), { sides: () => [{ dir: side, who: BOT }], connectors: { fake: fake() } });
    k.store.putTarget({ id: 'web', title: 'Web', kind: 'ssh', connector: 'fake' });
    k.store.grant('web', BOT.id, 'watch');
    const input = new PassThrough(); const output = new PassThrough();
    const got = []; output.on('data', (d) => got.push(...String(d).trim().split('\n').map((l) => JSON.parse(l))));
    const rl = serve(side, { input, output, wait: 2000 });
    const timer = setInterval(() => k.pump(), 10);
    try {
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terminal-run', arguments: { target: 'web', command: 'ls' } } })}\n`);
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'files-read', arguments: { target: 'web', path: 'a' } } })}\n`);
        for (let i = 0; i < 200 && got.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
        const by = Object.fromEntries(got.map((m) => [m.id, m]));
        assert.equal(by[1].result.serverInfo.name, NAME);
        assert.equal(by[2].result.tools.length, TOOLS.length);
        assert.equal(by[3].result.isError, true);
        assert.match(by[3].result.content[0].text, /^Not done: Web is at level watch/);
        assert.equal(by[4].result.content[0].text, 'did files.read');
    } finally { clearInterval(timer); rl.close(); }
});

test('a screen target: a slot with no built-in engine; a plugged engine runs, and Always allows the whole verb', async () => {
    /* No engine plugged in: a screen target says its connector is off. */
    const bare = keeper(tmp(), {});
    bare.store.putTarget({ id: 'desk', title: 'Desktop', kind: 'screen', connector: 'screen' });
    bare.store.grant('desk', BOT.id, 'free');
    assert.match((await bare.act('screen.shot', { target: 'desk' }, BOT)).text, /connector is off/);
    bare.close();

    /* An engine plugged in under the name screen: the keeper runs it, with rights and approval. */
    const engine = fake();
    const k = keeper(tmp(), { connectors: { screen: engine }, ask: (r) => r.verb === 'screen.click' ? 'always' : undefined });
    k.store.putTarget({ id: 'desk', title: 'Desktop', kind: 'screen', connector: 'screen' });
    k.store.grant('desk', BOT.id, 'watch');
    /* screen.shot reads: at watch, it goes; an action does not. */
    assert.equal((await k.act('screen.shot', { target: 'desk' }, BOT)).ok, true);
    assert.match((await k.act('screen.click', { target: 'desk', x: 10, y: 20 }, BOT)).text, /level watch: read only/);
    /* At propose, the action is asked; "Always" allows that verb and moves to frame. */
    k.store.grant('desk', BOT.id, 'propose');
    assert.equal((await k.act('screen.click', { target: 'desk', x: 10, y: 20 }, BOT)).ok, true);
    assert.equal(k.store.grantOf('desk', BOT.id).level, 'frame');
    /* A second click now goes without asking (the verb is allowed), but a different verb still asks. */
    assert.equal((await k.act('screen.click', { target: 'desk', x: 1, y: 2 }, BOT)).ok, true);
    assert.equal(engine.calls.filter((c) => c.verb === 'screen.click').length, 2);
    k.close();
});
