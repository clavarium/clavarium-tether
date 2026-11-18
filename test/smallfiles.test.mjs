/* 18-11: the keeper read every folder's asks and answers whole each second (20 MB on the owner's server): read once,
   then only what was added; and the files kept small (only what is active, a little past). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, existsSync, statSync, symlinkSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeper, ROTATE_BYTES, KEEP_MS, OLD_MS } from '../host/keeper.mjs';
import { lines } from '../server/mcp.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-small-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant · site' };
const fake = () => ({ run: async (verb) => ({ text: `did ${verb}`, size: 3, exit: 0 }), async close() {} });

test('lines: read once, then only what was added; a line not ended yet given but not kept; replaced, read again; never a link', () => {
    const dir = tmp(); const f = join(dir, 'a.jsonl');
    assert.deepEqual(lines(f), [], 'none yet');
    appendFileSync(f, '{"n":1}\n{"n":2}\n');
    assert.deepEqual(lines(f).map((x) => x.n), [1, 2]);
    appendFileSync(f, 'not json\n{"n":3}\n{"n":4');
    assert.deepEqual(lines(f).map((x) => x.n), [1, 2, 3], 'an unfinished last line is not read yet');
    appendFileSync(f, '}\n{"n":5}\n');
    assert.deepEqual(lines(f).map((x) => x.n), [1, 2, 3, 4, 5], 'finished, then counted once');
    writeFileSync(`${f}.new`, '{"n":9}\n'); renameSync(`${f}.new`, f);
    assert.deepEqual(lines(f).map((x) => x.n), [9], 'replaced: read again whole');
    writeFileSync(f, '');
    assert.deepEqual(lines(f), [], 'emptied');
    const link = join(dir, 'link.jsonl'); symlinkSync(f, link);
    assert.deepEqual(lines(link), [], 'never through a link');
});

test('the keeper answers each ask once, reading only what came since; an ask older than KEEP_MS is history, never answered', () => {
    const side = tmp();
    const k = keeper(tmp(), { sides: () => [{ dir: side, who: BOT }], connectors: { fake: fake() } });
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'ancient', at: new Date(Date.now() - KEEP_MS - 1000).toISOString(), op: 'targets', args: {} })}\n`);
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'old', at: new Date(Date.now() - 120_000).toISOString(), op: 'targets', args: {} })}\n`);
    assert.equal(k.pump(), 1);
    const answers = readFileSync(join(side, 'answers.jsonl'), 'utf8');
    assert.match(answers, /"ask":"old".*too late/);
    assert.doesNotMatch(answers, /ancient/, 'history: not answered again');
    assert.equal(k.pump(), 0, 'answered once');
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'late2', at: new Date(Date.now() - 120_000).toISOString(), op: 'targets', args: {} })}\n`);
    assert.equal(k.pump(), 1, 'a new one seen');
    assert.equal(k.pump(), 0);
});

test('the files stay small: past ROTATE_BYTES the answers keep the last hour, the asks are put aside then go; nothing open is lost', () => {
    const side = tmp();
    const k = keeper(tmp(), { sides: () => [{ dir: side, who: BOT }], connectors: { fake: fake() } });
    const old = new Date(Date.now() - KEEP_MS - 60_000).toISOString();
    const pad = 'x'.repeat(500);
    let a = ''; let q = '';
    for (let i = 0; a.length <= ROTATE_BYTES; i++) { a += `${JSON.stringify({ at: old, ask: `o${i}`, ok: true, text: pad })}\n`; q += `${JSON.stringify({ id: `o${i}`, at: old, op: 'targets', args: {}, pad })}\n`; }
    a += `${JSON.stringify({ at: new Date().toISOString(), ask: 'recent', ok: true, text: 'kept' })}\n`;
    writeFileSync(join(side, 'answers.jsonl'), a); writeFileSync(join(side, 'asks.jsonl'), q);
    assert.equal(k.pump(), 0, 'nothing to do: all answered or history');
    const kept = readFileSync(join(side, 'answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(kept.map((x) => x.ask), ['recent'], 'only the last hour');
    assert.ok(!existsSync(join(side, 'asks.jsonl')) && existsSync(join(side, 'asks.jsonl.old')), 'the asks put aside');
    /* A new ask in the new file, and one that raced into the old one: both answered. */
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'n1', at: new Date(Date.now() - 120_000).toISOString(), op: 'targets', args: {} })}\n`);
    appendFileSync(join(side, 'asks.jsonl.old'), `${JSON.stringify({ id: 'raced', at: new Date(Date.now() - 120_000).toISOString(), op: 'targets', args: {} })}\n`);
    assert.equal(k.pump(), 2);
    assert.equal(k.pump(), 0);
    const then = new Date(Date.now() - OLD_MS - 1000);
    utimesSync(join(side, 'asks.jsonl.old'), then, then);
    k.pump();
    assert.ok(!existsSync(join(side, 'asks.jsonl.old')), 'put aside, then gone');
    assert.ok(statSync(join(side, 'answers.jsonl')).size < ROTATE_BYTES);
    assert.equal(k.pump(), 0, 'nothing answered twice after the files changed');
});

test('the journal is read from its end: newest first, across chunks, limit, since and filters as before', async () => {
    const { openJournal, CHUNK } = await import('../host/journal.mjs');
    const dir = tmp(); let t = Date.parse('2026-11-18T00:00:00Z');
    const j = openJournal(dir, { now: () => t });
    const n = Math.ceil((3 * CHUNK) / 120);
    for (let i = 0; i < n; i++) { t += 1000; j.append({ op: 'call', agent: { id: i % 3 === 0 ? 'agent:a' : 'agent:b' }, target: { id: 'web' }, detail: `n${i} ${'z'.repeat(60)}` }); }
    const last = j.read({ limit: 5 });
    assert.deepEqual(last.map((l) => l.detail.split(' ')[0]), [n - 1, n - 2, n - 3, n - 4, n - 5].map((i) => `n${i}`));
    const all = j.read({ limit: 1000 });
    assert.equal(all.length, Math.min(1000, n));
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at > all[i].at, 'newest first, no line torn at a chunk');
    const a = j.read({ agent: 'agent:a', limit: 1000 });
    assert.ok(a.length > 0 && a.every((l) => l.agent.id === 'agent:a'));
    const since = new Date(t - 10_000).toISOString();
    assert.equal(j.read({ since, limit: 1000 }).length, 11, 'since: stops at the first older line');
    assert.deepEqual(openJournal(tmp()).read(), [], 'none yet');
});
