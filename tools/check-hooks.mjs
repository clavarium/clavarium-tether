/* THE HOOKS ARE WIRED, AND THE GUARD IS ALIVE.
 *
 * A hook that is not installed refuses nothing, and says nothing. Git does not
 * install hooks on clone: `core.hooksPath` is set per clone, and a clone that
 * forgot it commits anything. This is the check that notices.
 *
 * It also asks the leak guard to prove itself. The guard is outside the
 * repository and its lists cannot be read from here, so it is asked the only
 * question that does not publish them: are your lists loaded, and do you
 * refuse your own words?
 *
 * In continuous integration there is no guard, on purpose. Set CI=true and
 * only what CAN be checked there is checked; the names stay a local matter.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

const git = (...args) => {
    try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const problems = [];
const HOOKS = ['pre-commit', 'commit-msg', 'pre-push', 'guard.sh'];

for (const hook of HOOKS) {
    try { accessSync(`hooks/${hook}`, constants.X_OK); }
    catch { problems.push(`hooks/${hook} is missing or not executable`); }
}

if (process.env.CI === 'true') {
    console.log('hooks: present and executable (CI: wiring and guard are local matters)');
} else {
    if (git('config', '--get', 'core.hooksPath') !== 'hooks') {
        problems.push('core.hooksPath is not "hooks": NOTHING is checked on commit. Run: npm run hooks');
    }
    const alive = spawnSync('hooks/guard.sh', ['--self-test'], { encoding: 'utf8' });
    if (alive.status !== 0) {
        problems.push(`the leak guard is not answering: ${(alive.stdout || alive.stderr || '').trim().split('\n')[0]}`);
    } else if (problems.length === 0) {
        /* Said only when BOTH are true. It once said "wired" above a refusal
           about the wiring, and the first line is the one people read. */
        console.log(`hooks: wired; ${alive.stdout.trim()}`);
    }
}
if (problems.length) {
    for (const p of problems) console.error(p);
    console.error('\nUntil this is fixed, a commit here is an unchecked commit.');
    process.exit(1);
}
