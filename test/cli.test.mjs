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
