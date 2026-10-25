/* NO ASSISTANT SIGNS ANYTHING HERE.
 *
 * The tools that write in this repository leave their name behind by default:
 * a `Co-Authored-By:` trailer, a session URL, an author field. This refuses
 * the next one. Taken over from an earlier project of the same author, where
 * ninety-eight commits carried a signature before anybody looked.
 *
 * WHY IT IS IN THE REPOSITORY AND THE OTHER GUARD IS NOT. The leak guard lives
 * outside, because a list of the words that must not be published cannot itself
 * be published. This list is the opposite: every name in it is public, and no
 * secret is spent by writing it down.
 *
 * FOUR PLACES, because a signature arrives by four routes:
 *
 *   message    the commit message and its trailers      hooks/commit-msg
 *   identity   git's user.name and user.email           hooks/pre-commit
 *   staged     the lines a commit adds                  hooks/pre-commit
 *   tracked    everything the repository holds          npm run check
 *
 * ONE DIFFERENCE WITH THE PROJECT THIS CAME FROM, and it is deliberate. This
 * product RUNS command-line assistants: their names are its subject, the way a
 * package manager names packages. So:
 *
 *   - in a commit MESSAGE, in the git IDENTITY and in the commits being pushed,
 *     a name is refused, as before: nothing there needs one, and that is where
 *     a signature lives;
 *   - in FILE CONTENT (staged, tracked), only the SHAPE of a signature is
 *     refused -- a co-author trailer, a session identifier. A file may say
 *     which tool a conversation runs. It may not be signed by one.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/* THE LIST HAS TO NAME THE NAMES, so this file fails its own check -- it did,
   on the very commit that introduced it, which is the cheapest possible proof
   that the guard runs.
 *
 * It exempts ITSELF BY PATH, and nothing else. The alternative was to build
 * the names out of fragments so the literals never appear, and that is worse
 * in both directions: unreadable to whoever wants to add a name, and no harder
 * to defeat. What is refused should be legible to anybody who opens the file
 * that refuses it.
 *
 * The exemption is one path, written here rather than passed in, so that
 * widening it is an edit somebody has to make and explain. */
const SELF = 'tools/check-ai-names.mjs';

/* The names that sign work. Word boundaries, case-insensitive. Add to it
   freely: a name that never appears costs one regular expression. */
const NAMES = [
    /* the vendors */
    'claude', 'anthropic', 'openai', 'chatgpt', 'copilot', 'gemini',
    'codex', 'codeium', 'llama', 'bard', 'grok', 'deepseek', 'qwen',
    'kimi', 'windsurf', 'aider', 'tabnine',
    /* the models, because the trailer that leaked here named one rather than
       a vendor -- a tool that changes its template to the model alone would
       walk straight past a list of vendors. None of these collides with a word
       this repository uses: checked one by one before being added. */
    'opus', 'sonnet', 'haiku', 'fable', 'mistral',
    /* and the generations, suffixes included -- a word boundary alone misses
       the ones that end in a letter or a decimal */
    'gpt-?[0-9]+(\\.[0-9]+)?[a-z]?',
];

/* Written out before the scan, so the command survives and the signature does
   not. Anything added here has to be a phrase somebody TYPES, never a phrase
   somebody is called. */
const ALLOWED = [
    /claude\s+mcp\s+add/gi,
];

const NEEDLE = new RegExp(`\\b(${NAMES.join('|')})\\b`, 'gi');

/* THE SHAPE OF A SIGNATURE, WITHOUT ANY NAME IN IT. The list above only ever
   catches a name somebody thought to write; these two catch the FORM, which is
   what actually leaked eighty-five times. A tool that renames its model
   tomorrow still emits a trailer and still emits a session URL. */
const SHAPES = [
    [/session_[A-Za-z0-9_-]{16,}/g, 'a session identifier'],
    [/^\s*Co-Authored-By:.*<[^@>]+@(?!example\.(com|org|net)|users\.noreply\.github\.com)[^>]+>/gim,
     'a co-author trailer'],
];

/* TWO READINGS OF THE SAME TEXT, and a name found in either one is a name.
 *
 * WHY, and it was found by an audit rather than by thinking: the first version
 * deleted every `<...>` before scanning, so that the site's marked-up
 * `<span>claude</span> <span>mcp</span>` could match the one allowed phrase.
 * But the email in a co-author trailer sits in angle brackets too, and that is
 * the CANONICAL shape of a git signature. The guard was blind to the exact
 * thing it exists to stop: a trailer whose visible name says nothing and whose
 * address says everything went straight through.
 *
 * So nothing is deleted any more:
 *
 *   raw       the text as written. Catches a name inside angle brackets.
 *   stripped  element tags removed. Catches a name CUT BY a tag --
 *             `Cla<b>ude</b>` reads as one word to a browser and read as two
 *             to the first version.
 *
 * The allowed phrase is removed from each in the form it takes there, which is
 * why it survives both readings while a signature survives neither. */
const ALLOWED_MARKED = /claude(?:<[^>]*>|\s)+mcp(?:<[^>]*>|\s)+add/gi;

const findings = (text, where, names = true) => {
    const raw = String(text).replace(ALLOWED_MARKED, ' ');
    let stripped = String(text).replace(/<\/?[a-zA-Z][^>]*>/g, '');
    for (const phrase of ALLOWED) stripped = stripped.replace(phrase, ' ');

    const seen = new Set();
    const out = [];
    const note = (line, what) => {
        const key = what + '|' + line;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(`${where}: ${what} -- ${line.trim().slice(0, 90)}`);
    };
    for (const [pattern, what] of SHAPES) {
        for (const line of String(text).split('\n')) {
            pattern.lastIndex = 0;
            if (pattern.test(line)) note(line, what);
        }
    }
    /* File content: the shapes above are the whole check. See the header. */
    if (!names) return out;
    for (const body of [raw, stripped]) {
        for (const line of body.split('\n')) {
            const hit = line.match(NEEDLE);
            if (hit) note(line, hit[0]);
        }
    }
    return out;
};

const mode = process.argv[2];
const arg = process.argv[3];
let bad = [];

if (mode === 'message') {
    bad = findings(readFileSync(arg, 'utf8'), 'the commit message');
} else if (mode === 'staged') {
    const who = ['user.name', 'user.email'].map((k) => {
        try { return execFileSync('git', ['config', k], { encoding: 'utf8' }).trim(); }
        catch (e) { return ''; }
    }).join(' ');
    bad = findings(who, 'git identity');
    /* Added lines only: a commit that DELETES a name must not be refused, or
       the guard would forbid its own cleanup. */
    const diff = execFileSync('git', ['diff', '--cached', '--unified=0'], { encoding: 'utf8' });
    /* Walked file by file so the exemption can apply to one of them: a `+++`
       line names the file the hunks that follow belong to. */
    const added = [];
    let inSelf = false;
    for (const l of diff.split('\n')) {
        if (l.startsWith('+++ ')) { inSelf = l.slice(4).replace(/^b\//, '') === SELF; continue; }
        /* Without its leading `+`: a trailer is recognised at the START of a
           line, and the diff marker stood in the way -- a co-author line added
           to a file went straight through until this was measured. */
        if (!inSelf && l.startsWith('+')) added.push(l.slice(1));
    }
    bad = bad.concat(findings(added.join('\n'), 'a line this commit adds', false));
} else if (mode === 'range') {
    const range = arg || 'origin/main..HEAD';
    let log = '';
    /* FAILS CLOSED. This said `exit(0)` on any error, so an unfetched
       origin/main, a renamed remote or a detached repository all read as "no
       assistant named" -- a guard that answers yes when it cannot look is
       worse than none. */
    try { log = execFileSync('git', ['log', '--format=%an%n%ae%n%B', range], { encoding: 'utf8' }); }
    catch (e) {
        console.error(`REFUSED: cannot read the range ${range} -- ${e.message.split('\n')[0]}`);
        console.error('A range that cannot be read has not been checked.');
        process.exit(1);
    }
    bad = findings(log, 'a commit being pushed');
} else {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
        .split('\n').filter(Boolean);
    for (const path of files) {
        if (path === SELF) continue;
        let text;
        try { text = readFileSync(path, 'utf8'); } catch (e) { continue; }
        bad = bad.concat(findings(text, path, false));
    }
}

if (bad.length) {
    console.error('REFUSED: an assistant signs, or is named where nothing needs a name.\n');
    for (const line of bad.slice(0, 20)) console.error('  ' + line);
    if (bad.length > 20) console.error(`  ... and ${bad.length - 20} more`);
    console.error('\nNothing in this repository is signed by an assistant -- not in a');
    console.error('message, not in a trailer, not in the author field, not in a file.');
    console.error('See the header of tools/check-ai-names.mjs for what is refused where.');
    process.exit(1);
}
console.log(mode === 'message' ? 'commit message: no assistant named'
    : mode === 'staged' ? 'staged changes and git identity: no assistant signature'
    : mode === 'range' ? 'commits to push: no assistant named'
    : 'tracked files: no assistant signature');
