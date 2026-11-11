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

test('read parses pending and withdraw', () => {
    assert.deepEqual(read(['pending'])[1], {});
    assert.deepEqual(read(['pending']).slice(0, 1), ['pending']);
    assert.deepEqual(read(['withdraw', 'req-123'])[1], { id: 'req-123' });
    assert.deepEqual(read(['withdraw', 'req-123', 'sent', 'by', 'mistake'])[1], { id: 'req-123', reason: 'sent by mistake' });
    assert.ok(read(['withdraw']).refused, 'withdraw needs an id');
});

/* AN EXTERNAL MCP SERVER, BY COMMAND (11-11): for an agent without MCP tools of its own. */
test('mcp: its tools listed from the folder, one called as the same mcp.call; bad arguments refused', async () => {
    assert.deepEqual(read(['mcp', 'crm']), ['mcp.tools', { target: 'crm' }]);
    assert.deepEqual(read(['mcp', 'crm', 'search', '{"q": "Ann"}', '--why', 'find her']), ['mcp.call', { target: 'crm', tool: 'search', arguments: { q: 'Ann' }, why: 'find her' }]);
    assert.deepEqual(read(['mcp', 'crm', 'list']), ['mcp.call', { target: 'crm', tool: 'list', arguments: {} }]);
    assert.match(read(['mcp']).refused, /mcp TARGET/);
    assert.match(read(['mcp', 'crm', 'search', 'not json']).refused, /one JSON object/);
    assert.match(read(['mcp', 'crm', 'search', '[1]']).refused, /one JSON object/);
    /* Listed from the folder the keeper writes, nothing asked. */
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'tether-mcp-'));
    mkdirSync(join(dir, '.tether'));
    writeFileSync(join(dir, '.tether', 'tools.json'), JSON.stringify({ tools: [
        { name: 'crm-search', target: 'crm', tool: 'search', description: 'Find a contact', inputSchema: { type: 'object', properties: { q: { type: 'string' }, why: { type: 'string' } }, required: ['q'] } },
        { name: 'other-x', target: 'other', tool: 'x', description: 'X' }] }));
    const r = await run(['mcp', 'crm'], { cwd: dir, env: {} });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 tools of crm/);
    assert.match(r.out, /search: Find a contact\n {6}args: q\* \(string\)/);
    assert.doesNotMatch(r.out, /other|why \(/);
    const none = await run(['mcp', 'nope'], { cwd: dir, env: {} });
    assert.equal(none.code, 1); assert.match(none.err, /No tools of nope here/);
});
