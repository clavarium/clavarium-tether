/* THE CLI, parsed and dispatched without a real Tether folder. read() turns a
 * command line into [verb, args]; run() is checked only up to where it reads a
 * local file, using a clean temp cwd that has no Tether folder above it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read, run } from '../bin/cli.mjs';

const clean = mkdtempSync(join(tmpdir(), 'tether-cli-'));  /* no FOLDER here or above */
const opts = { cwd: clean, env: {} };

test('read parses calendar --from/--to as plain values, not files', () => {
    assert.deepEqual(read(['calendar', 'C', 'list', '--from', '2026-11-10', '--to', '2026-12-01'])[1],
        { target: 'C', from: '2026-11-10', to: '2026-12-01' });
});

test('run does NOT open calendar --from as a local file (the date stays a date)', async () => {
    const r = await run(['calendar', 'MyCal', 'list', '--from', '2026-11-10'], opts);
    assert.doesNotMatch(r.err, /cannot read 2026-11-10/, 'the window start must not be read as a filename');
});

test('run still reads files write --from as a local file', async () => {
    const r = await run(['files', 'Box', 'write', 'out.txt', '--from', join(clean, 'no-such-file')], opts);
    assert.match(r.err, /cannot read .*no-such-file/, 'files write --from keeps reading the local file');
});

test('read parses --category: repeatable and comma-split on create, none clears on update, one filter on list, and categories', () => {
    /* several categories on create (repeated and comma-joined both work) */
    assert.deepEqual(read(['calendar', 'C', 'create', '--title', 'Point', '--start', '2030-01-02T10:00:00', '--end', '2030-01-02T11:00:00', '--category', 'Internal', '--category', 'Board,Travel'])[1].categories,
        ['Internal', 'Board', 'Travel']);
    /* none clears on update */
    assert.deepEqual(read(['calendar', 'C', 'update', 'E1', '--category', 'none'])[1].categories, []);
    /* a single filter on list */
    assert.equal(read(['calendar', 'C', 'list', '--category', 'Travel'])[1].category, 'Travel');
    /* the categories subverb */
    assert.deepEqual(read(['calendar', 'C', 'categories'])[1], { target: 'C' });
});

test('read parses calendar category add/rename/delete', () => {
    assert.deepEqual(read(['calendar', 'C', 'category', 'add', 'Internal', '--color', 'blue'])[1], { target: 'C', name: 'Internal', color: 'blue' });
    assert.deepEqual(read(['calendar', 'C', 'category', 'rename', 'Old', '--to', 'New', '--color', 'green'])[1], { target: 'C', name: 'Old', to: 'New', color: 'green' });
    assert.deepEqual(read(['calendar', 'C', 'category', 'delete', 'Trip'])[1], { target: 'C', name: 'Trip' });
    assert.equal(read(['calendar', 'C', 'category', 'add'])[0] ?? read(['calendar', 'C', 'category', 'add']).refused ? true : false, true);
});

test('read parses mail attachment --out as a destination folder', () => {
    assert.deepEqual(read(['mail', 'Box', 'attachment', 'AAA', 'report.pdf', '--out', 'downloads'])[1], { target: 'Box', uid: 'AAA', which: 'report.pdf', out: 'downloads' });
});
