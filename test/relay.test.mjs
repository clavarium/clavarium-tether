import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { relay } from '../server/relay.mjs';

/* A tiny MCP server: answers each request with the version installed when it started. */
const CHILD = `import { createInterface } from 'node:readline'; import { readFileSync } from 'node:fs';
const v = JSON.parse(readFileSync(process.argv[2], 'utf8')).version;
createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { version: v, method: m.method } }) + '\\n'); });`;

test('a new version installed is taken up between two requests, the session never restarted (02-11)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pkg = join(dir, 'package.json'); const child = join(dir, 'child.mjs');
    writeFileSync(child, CHILD); writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }));
    const input = new PassThrough(); const output = new PassThrough(); const got = [];
    output.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) got.push(JSON.parse(l)); });
    const r = relay({ args: [child, pkg], packageJson: pkg, input, output });
    t.after(() => { input.end(); try { r.child?.kill(); } catch { /* gone */ } });
    const say = (m) => input.write(`${JSON.stringify(m)}\n`);
    const answer = async (id) => { for (let i = 0; i < 200; i++) { const a = got.find((m) => m.id === id); if (a) return a; await new Promise((ok) => setTimeout(ok, 15)); } return null; };
    say({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal((await answer(1)).result.version, '1.0.0');
    say({ jsonrpc: '2.0', id: 2, method: 'tools/call' });
    assert.equal((await answer(2)).result.version, '1.0.0');
    writeFileSync(pkg, JSON.stringify({ version: '1.1.0' }));
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
    assert.equal((await answer(3)).result.version, '1.1.0', 'the new version answers the next request');
    assert.ok(got.some((m) => m.method === 'notifications/tools/list_changed'), 'the session is told its tools may have changed');
    assert.ok(!got.some((m) => typeof m.id === 'string' && m.id.startsWith('relay:')), 'the hello said again stays between the relay and the tool');
    assert.equal(r.version, '1.1.0');
});
