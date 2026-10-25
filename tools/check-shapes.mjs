/* WHAT CAN BE CHECKED WITHOUT NAMING ANYBODY.

   THE LEAK GUARD CANNOT LIVE HERE, AND THAT IS NOT A GAP TO PLUG. Its patterns
   are names -- a person, a company, a client, a supplier -- and writing them
   into this repository to search for them would publish every one of them in
   the history, which is the one thing it exists to prevent. So it stays on the
   machine, outside, and CI has no way to run it.

   THIS IS THE OTHER HALF, AND IT IS THE HALF CI CAN HAVE. Some leaks have a
   SHAPE rather than a name: a home directory, an email address, a machine's
   address. None of those needs a secret list to be recognised, so they can be
   refused here -- on every push, on every pull request, and from a machine that
   has never heard of the guard.

   It does not replace the guard. A client's name is a word like any other and
   nothing here will ever see it. What this removes is the accident: a path
   pasted from a terminal, an address left in an example, an author line typed
   from muscle memory -- which is the mistake that actually happened.

   EVERY RULE IS AN ALLOWLIST OF SHAPES, never a denylist of names. */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
    .split('\n').filter(Boolean);

/* Binary and built artefacts are read as text on purpose: a path pasted into a
   built bundle is a path published, whatever the file calls itself. */
const RULES = [
    {
        name: 'a home directory',
        why: 'It names a user, and often a machine and a client with them.',
        find: /\/(home|Users)\/[A-Za-z0-9._-]+\//g,
        allow: () => false,
    },
    {
        name: 'an email address',
        why: 'example.com and example.org are for examples; a noreply form is '
            + 'what git should be carrying.',
        find: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        allow: (m) => /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i.test(m),
    },
    {
        name: 'a machine address',
        why: 'Loopback is a default anybody would write; anything else is '
            + 'somewhere real.',
        find: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
        allow: (m) => m === '127.0.0.1' || m === '0.0.0.0' || m === '255.255.255.255',
    },
];

let bad = 0;
for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const rule of RULES) {
        for (const m of text.matchAll(rule.find)) {
            if (rule.allow && rule.allow(m[0])) continue;
            const line = text.slice(0, m.index).split('\n').length;
            console.error(`${file}:${line}  ${rule.name}: ${m[0]}`);
            console.error(`  ${rule.why}`);
            bad++;
        }
    }
}

/* AND THE ONE THAT IS NOT IN A FILE. A commit carries an author and a
   committer, and neither is in any file this loop reads. An address was typed
   into one of them once, on this repository, and only the local guard caught
   it -- from another machine it would have gone out with the push. */
const identities = new Set(
    execSync('git log --all --format=%ae%n%ce', { encoding: 'utf8' })
        .split('\n').filter(Boolean));
for (const who of identities) {
    if (/@users\.noreply\.github\.com$/i.test(who)) continue;
    /* GitHub itself commits a change made on its site (Pages writing docs/CNAME,
       for instance): its committer is this one address, the author stays ours. */
    if (who === ['noreply', 'github.com'].join('@')) continue;
    console.error(`a commit is signed ${who}`);
    console.error('  Commits here are signed with a GitHub noreply address.');
    console.error('  A contributor whose form differs adds it to this rule, in the open.');
    bad++;
}

if (bad) {
    console.error(`\n${bad} shape(s) that name somebody or something.`);
    console.error('This is not the whole guard -- names have no shape and stay local.');
    process.exit(1);
}
console.log(`shapes: ${files.length} file(s) and ${identities.size} identity, nothing named`);
