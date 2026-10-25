/* EVERY SHELL SCRIPT PARSES. `bash -n` reads a script without running it: a
   hook with a syntax error does not refuse anything, it just dies, and git
   reports that as a refusal nobody can explain. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => {
        if (f.endsWith('.sh')) return true;
        try { return readFileSync(f, 'utf8').startsWith('#!/bin/bash'); } catch { return false; }
    });
let bad = 0;
for (const f of files) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(`${f}: ${r.stderr.trim()}`); bad++; }
}
if (bad) { console.error(`\n${bad} shell script(s) do not parse.`); process.exit(1); }
console.log(`shell: ${files.length} script(s) parse`);
