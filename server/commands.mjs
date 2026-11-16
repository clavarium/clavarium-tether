/* A SHELL LINE, JUDGED BEFORE IT IS TYPED: what an agent may run alone at level `frame`, and what is
 * destructive whatever the level. Pure functions: no clock, no file, no connector.
 *
 * READ-ONLY (`readOnly`): at `frame`, an agent types alone only a line this strict parser accepts --
 *
 *   ONE simple command from a FIXED list (ls, df, du, uptime, free, ps, top -bn1, journalctl,
 *   systemctl status, cat/head/tail/less/wc/stat of files, uname, whoami, id, date, ip a, ss -tlnp,
 *   docker ps...), each with only the arguments that keep it a read (journalctl --vacuum-*, tail -f,
 *   date -s, ip addr add, ss -K, hostname NAME... refused);
 *   optionally followed by up to two read pipes: `| head`, `| tail`, `| grep` with plain flags and a
 *   pattern (`| grep -i error | head -n 20`);
 *   no ; & && || > < $ ( ) { } ` \ nor a line break or a control character anywhere -- a line that
 *   holds any of them is not read-only, whatever comes first.
 *
 * Anything else is asked of a person (a proposal). The list errs on the side of asking: a command
 * missed here is a card, never a command run.
 *
 * DESTRUCTIVE (`destructive`): the WHOLE line is looked at, every part of it (after ; && || | &, inside
 * $( ) and backticks, after sudo/env/nohup...): rm -r, mkfs, dd, shred, wipefs, a partition editor,
 * shutdown/reboot/poweroff/halt, chmod/chown/chgrp -R on / or a system folder, a write to a disk device
 * (> /dev/sda), a fork bomb, crontab -r, DROP TABLE/DATABASE, iptables -F... A destructive line is
 * always asked, at every level, `free` included, and marked as such on its card.
 *   -> null, or { kind: 'erase' | 'disk' | 'power' | 'rights' | 'other', what: 'the words that matched' }
 */

export const LINE_MAX = 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHELL_CONTROL = /[;&<>`$(){}\\]/;

/* Words of a simple line, quotes honoured ('a b' "a b"); null when a quote is left open. Shell
   control is refused before this is called, so a quote never hides one. */
function wordsOf(text) {
    const out = []; let cur = ''; let quote = ''; let any = false;
    for (const ch of text) {
        if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
        if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
        if (/\s/.test(ch)) { if (any || cur) out.push(cur); cur = ''; any = false; continue; }
        cur += ch;
    }
    if (quote) return null;
    if (any || cur) out.push(cur);
    return out;
}

const flagsOnly = (args, allowed) => args.every((x) => allowed.test(x));
const isFlag = (x) => x.startsWith('-');
const NUM = /^\d{1,6}$/;
/* Flags and paths, no flag outside the ones given (each flag word whole, or letters of a short group). */
const pathsAnd = (shortLetters, longs = []) => (args) => args.every((x) => !isFlag(x) || longs.includes(x.split('=')[0]) || new RegExp(`^-[${shortLetters}]+$`).test(x));

/* name -> (args) => boolean: the arguments that keep it a read. */
const READERS = {
    ls: pathsAnd('alhrtRSdFi1AGgnoqsuUvXZ', ['--all', '--almost-all', '--human-readable', '--color', '--sort', '--time-style', '--full-time', '--group-directories-first']),
    df: pathsAnd('hHTiaklPx', ['--human-readable', '--inodes', '--print-type', '--total', '--output', '--exclude-type', '--type']),
    du: (args) => {
        for (let i = 0; i < args.length; i++) {
            const x = args[i];
            if (!isFlag(x)) continue;
            if (/^-[shacxkmLlPD0b]+$/.test(x)) continue;
            if (/^-d$/.test(x) && NUM.test(args[i + 1] ?? '')) { i++; continue; }
            if (/^-d\d+$/.test(x) || /^--max-depth=\d+$/.test(x) || ['--summarize', '--human-readable', '--total', '--apparent-size', '--one-file-system', '--time'].includes(x)) continue;
            return false;
        }
        return true;
    },
    uptime: (args) => flagsOnly(args, /^-(p|s|-pretty|-since)$/),
    free: (args) => flagsOnly(args, /^-(h|m|g|k|b|t|w|-human|-mega|-giga|-total|-wide|-si)$/),
    ps: (args) => args.every((x) => /^[-a-zA-Z0-9,=:_.]+$/.test(x)),
    top: (args) => ['-bn1', '-b -n1', '-b -n 1', '-n1 -b', '-n 1 -b', '-bn 1'].includes(args.join(' ')),
    journalctl: (args) => {
        for (let i = 0; i < args.length; i++) {
            const x = args[i];
            if (!isFlag(x)) { if (!/^[A-Za-z0-9_.@:=/-]+$/.test(x)) return false; continue; }
            const name = x.split('=')[0];
            if (/^-(f|-follow|-vacuum|-rotate|-flush|-sync|-relinquish|-smart-relinquish|-setup-keys|-update-catalog|-verify|-new-id128)/.test(name)) return false;
            if (/^-[xebrqkam]+$/.test(x) || /^-[npu]\d*$/.test(x) || /^-[SU]$/.test(x)) { if (/^-[npuSU]$/.test(x) && args[i + 1] !== undefined) i++; continue; }
            if (['--no-pager', '--unit', '--user-unit', '--lines', '--since', '--until', '--priority', '--boot', '--output', '-o', '--reverse', '--no-hostname', '--utc', '--catalog', '--identifier', '-t', '--grep', '-g', '--list-boots', '--disk-usage', '--dmesg', '-k', '--all', '--quiet', '--case-sensitive', '--system', '--user', '--pager-end', '--merge'].includes(name)) {
                if (!x.includes('=') && ['--unit', '--user-unit', '--lines', '--since', '--until', '--priority', '--boot', '--output', '-o', '--identifier', '-t', '--grep', '-g'].includes(name) && args[i + 1] !== undefined && !isFlag(args[i + 1])) i++;
                continue;
            }
            return false;
        }
        return true;
    },
    systemctl: (args) => {
        const plain = args.filter((x) => !isFlag(x));
        const flags = args.filter(isFlag);
        if (!flags.every((x) => /^(--no-pager|-l|--full|--all|-a|--no-legend|--plain|--failed|--user|--system|--type=[a-z,]+|--state=[a-z,]+|-n\d+|--lines=\d+)$/.test(x))) return false;
        return ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-timers', 'list-unit-files', 'list-sockets', 'show'].includes(plain[0]) && plain.slice(1).every((u) => /^[A-Za-z0-9_.@:*-]+$/.test(u));
    },
    cat: pathsAnd('nAbsvET', ['--number', '--show-all']),
    head: (args) => args.every((x, i) => !isFlag(x) || /^-(n|c)$/.test(x) && NUM.test(args[i + 1] ?? '') || /^-\d{1,6}$/.test(x) || /^-(n|c)\d{1,6}$/.test(x) || /^--(lines|bytes)=\d+$/.test(x) || /^-[qv]$/.test(x)),
    tail: (args) => args.every((x, i) => !isFlag(x) || /^-(n|c)$/.test(x) && /^\+?\d{1,6}$/.test(args[i + 1] ?? '') || /^-\d{1,6}$/.test(x) || /^-(n|c)\+?\d{1,6}$/.test(x) || /^--(lines|bytes)=\+?\d+$/.test(x) || /^-[qv]$/.test(x)),
    less: pathsAnd('NSRXFi', []),
    wc: pathsAnd('lwcmL', ['--lines', '--words', '--bytes', '--chars']),
    stat: pathsAnd('LfFt', ['--dereference', '--file-system', '--terse']),
    file: pathsAnd('bLiz', ['--mime', '--brief']),
    uname: (args) => flagsOnly(args, /^-[asnrvmpio]+$|^--all$/),
    whoami: (args) => args.length === 0,
    id: (args) => args.every((x) => /^-[ugGnr]+$/.test(x) || /^[a-z_][a-z0-9_-]{0,31}$/.test(x)),
    groups: (args) => args.every((x) => /^[a-z_][a-z0-9_-]{0,31}$/.test(x)),
    date: (args) => args.every((x) => /^-(u|R|I[a-z]*|-utc|-rfc-3339=[a-z]+|-iso-8601(=[a-z]+)?)$/.test(x) || /^\+[%A-Za-z0-9:_ .,/-]+$/.test(x)),
    hostname: (args) => flagsOnly(args, /^-(f|i|I|A|s|d|-fqdn|-all-ip-addresses|-short)$/),
    pwd: (args) => args.length === 0,
    w: (args) => flagsOnly(args, /^-[hsuif]+$/),
    who: (args) => flagsOnly(args, /^-[abdHlmpqrstTu]+$/),
    last: (args) => args.every((x, i) => /^-[aFiwx]+$/.test(x) || /^-n$/.test(x) || /^-\d{1,4}$/.test(x) || (args[i - 1] === '-n' && NUM.test(x))),
    lsblk: (args) => flagsOnly(args, /^-[afmplbdinoOrtSz]+$/),
    nproc: (args) => args.length === 0,
    lscpu: (args) => args.length === 0,
    ip: (args) => {
        const rest = args.filter((x) => !/^-(br|brief|4|6|c|color|s|stats|d|details|o|oneline)$/.test(x));
        if (!['a', 'addr', 'address', 'r', 'route', 'l', 'link', 'n', 'neigh', 'neighbour'].includes(rest[0])) return false;
        let tail = rest.slice(1);
        if (['show', 'list', 'ls'].includes(tail[0])) tail = tail.slice(1);
        if (tail[0] === 'dev') tail = tail.slice(1);
        return tail.length === 0 || (tail.length === 1 && /^[A-Za-z0-9_.@-]{1,32}$/.test(tail[0]));
    },
    ss: (args) => flagsOnly(args, /^-[tulnpaxwsoeimH46]+$/),
    docker: (args) => {
        const [sub, ...rest] = args;
        if (sub === 'ps' || sub === 'images') return rest.every((x) => /^(-a|--all|-q|--quiet|--no-trunc|-s|--size)$/.test(x));
        if (sub === 'version' || sub === 'info') return rest.length === 0;
        if (sub === 'stats') return rest.includes('--no-stream') && rest.every((x) => x === '--no-stream' || x === '-a' || x === '--all' || /^[A-Za-z0-9_.-]{1,64}$/.test(x));
        if (sub === 'logs') return rest.length > 0 && rest.every((x, i) => /^(-t|--timestamps)$/.test(x) || (x === '--tail' || x === '-n') && /^\d{1,6}$/.test(rest[i + 1] ?? '') || /^--tail=\d{1,6}$/.test(x) || ((rest[i - 1] === '--tail' || rest[i - 1] === '-n') && /^\d{1,6}$/.test(x)) || (!isFlag(x) && /^[A-Za-z0-9_.-]{1,64}$/.test(x)));
        return false;
    },
};
export const READ_ONLY_COMMANDS = Object.freeze(Object.keys(READERS));

/* A read pipe after the command: head, tail (no -f), grep (plain flags, one pattern). */
const PIPES = {
    head: READERS.head,
    tail: READERS.tail,
    grep: (args) => {
        const plain = args.filter((x) => !isFlag(x));
        return plain.length === 1 && args.filter(isFlag).every((x) => /^-[ivncEFwoxh]+$/.test(x) || /^-m\d{1,5}$/.test(x));
    },
};

/* -> { ok: true } or { ok: false, why } (in plain English, for a test or a log; the page has its own words). */
export function readOnly(line) {
    const text = String(line ?? '').trim();
    if (!text) return { ok: false, why: 'empty' };
    if (text.length > LINE_MAX) return { ok: false, why: 'too long' };
    if (CONTROL_CHARS.test(text)) return { ok: false, why: 'a control character or a line break' };
    if (SHELL_CONTROL.test(text)) return { ok: false, why: 'shell control (; & > < $ ( ) ` \\)' };
    const stages = text.split('|');
    if (stages.length > 3) return { ok: false, why: 'too many pipes' };
    const parsed = stages.map((s) => wordsOf(s.trim()));
    if (parsed.some((w) => w === null)) return { ok: false, why: 'an open quote' };
    if (parsed.some((w) => w.length === 0)) return { ok: false, why: 'an empty part' };
    const [first, ...pipes] = parsed;
    const [name, ...args] = first;
    if (!Object.hasOwn(READERS, name)) return { ok: false, why: `${name} is not a read-only command of the list` };
    if (!READERS[name](args)) return { ok: false, why: `${name} with these arguments is not only a read` };
    for (const [p, ...pargs] of pipes) {
        if (!Object.hasOwn(PIPES, p)) return { ok: false, why: `| ${p} is not a read pipe (head, tail, grep)` };
        if (!PIPES[p](pargs)) return { ok: false, why: `| ${p} with these arguments is not a plain read` };
    }
    return { ok: true };
}

/* ---- destructive ---- */
/* The parts of a line run as commands: split at ; && || | & and line breaks, and inside $( ) and backticks. */
function partsOf(text) {
    return String(text).split(/;|&&|\|\||\||&|\n|\r|`|\$\(|\(|\)|\{|\}/).map((s) => s.trim()).filter(Boolean);
}
/* Words that only run what follows them. */
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'nice', 'ionice', 'exec', 'command', 'builtin', 'xargs', 'env', 'busybox', 'stdbuf', 'timeout', 'watch', 'chroot', 'su']);
function commandOf(part) {
    const w = String(part).split(/\s+/).filter(Boolean).map((x) => x.replace(/^['"]|['"]$/g, ''));
    let i = 0;
    while (i < w.length) {
        const x = w[i];
        if (WRAPPERS.has(x)) { i++; while (i < w.length && (w[i].startsWith('-') || /^\d+[smhd]?$/.test(w[i]))) i++; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) { i++; continue; }      /* VAR=value before a command */
        break;
    }
    const name = (w[i] ?? '').replace(/^.*\//, '');                     /* /bin/rm is rm */
    return { name, args: w.slice(i + 1) };
}
const SYSTEM_DIRS = /^\/(\*|bin|boot|dev|etc|home|lib|lib32|lib64|opt|proc|root|sbin|srv|sys|usr|var)?\/?\*?$/;
const shortHas = (args, letter) => args.some((x) => /^-[A-Za-z]+$/.test(x) && x.includes(letter));
const WHY = {
    erase: 'erase',
    disk: 'disk',
    power: 'power',
    rights: 'rights',
    other: 'other',
};

export function destructive(line) {
    const text = String(line ?? '');
    if (!text.trim()) return null;
    if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(text)) return { kind: WHY.other, what: 'fork bomb' };
    const dev = /(^|[^0-9&])>{1,2}\s*\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d|md\d|dm-\d|mapper\/)/.exec(text);
    if (dev) return { kind: WHY.disk, what: `> /dev/${dev[2]}` };
    if (/\bdrop\s+(database|table|schema)\b/i.test(text) || /\btruncate\s+table\b/i.test(text)) return { kind: WHY.erase, what: (/\b(drop|truncate)\s+\w+/i.exec(text) ?? ['DROP'])[0].toUpperCase() };
    for (const part of partsOf(text)) {
        const { name, args } = commandOf(part);
        if (!name) continue;
        switch (name) {
            case 'rm': {
                const recursive = shortHas(args, 'r') || shortHas(args, 'R') || args.includes('--recursive');
                const rootish = args.some((x) => !x.startsWith('-') && SYSTEM_DIRS.test(x));
                if (recursive || rootish || args.includes('--no-preserve-root')) return { kind: WHY.erase, what: `rm ${args.filter((x) => x.startsWith('-')).join(' ')}`.trim() };
                break;
            }
            case 'shred': case 'wipefs': case 'srm': return { kind: WHY.erase, what: name };
            case 'dd': if (args.some((x) => /^of=/.test(x))) return { kind: WHY.disk, what: 'dd of=' }; break;
            case 'fdisk': case 'sfdisk': case 'cfdisk': case 'gdisk': case 'sgdisk': case 'parted': case 'mkswap': case 'pvremove': case 'vgremove': case 'lvremove': case 'blkdiscard':
                if (name === 'fdisk' && args.length && args.every((x) => x === '-l' || x.startsWith('/dev/'))) break;  /* fdisk -l only lists */
                if (name === 'parted' && args.includes('-l')) break;
                return { kind: WHY.disk, what: name };
            case 'shutdown': case 'reboot': case 'poweroff': case 'halt': case 'kexec': return { kind: WHY.power, what: name };
            case 'init': case 'telinit': if (['0', '6'].includes(args[0])) return { kind: WHY.power, what: `${name} ${args[0]}` }; break;
            case 'systemctl': if (args.some((x) => ['reboot', 'poweroff', 'halt', 'kexec', 'suspend', 'hibernate', 'emergency', 'rescue'].includes(x))) return { kind: WHY.power, what: `systemctl ${args.find((x) => !x.startsWith('-'))}` }; break;
            case 'chmod': case 'chown': case 'chgrp': {
                const recursive = shortHas(args, 'R') || args.includes('--recursive');
                if (recursive && args.some((x) => !x.startsWith('-') && SYSTEM_DIRS.test(x))) return { kind: WHY.rights, what: `${name} -R` };
                break;
            }
            case 'crontab': if (shortHas(args, 'r')) return { kind: WHY.erase, what: 'crontab -r' }; break;
            case 'iptables': case 'ip6tables': case 'nft': if (args.some((x) => ['-F', '--flush', '-X', 'flush'].includes(x))) return { kind: WHY.other, what: `${name} flush` }; break;
            case 'userdel': case 'deluser': case 'groupdel': return { kind: WHY.erase, what: name };
            case 'mv': if (args.some((x) => !x.startsWith('-') && SYSTEM_DIRS.test(x) && x !== '/home')) return { kind: WHY.erase, what: 'mv of a system folder' }; if (args[args.length - 1] === '/dev/null') return { kind: WHY.erase, what: 'mv to /dev/null' }; break;
            case 'git': if ((args[0] === 'reset' && args.includes('--hard')) || (args[0] === 'clean' && shortHas(args, 'f')) || (args[0] === 'push' && args.some((x) => x === '--force' || x === '-f'))) return { kind: WHY.erase, what: `git ${args[0]}` }; break;
            case 'docker': case 'podman': if (((args[0] === 'system' || args[0] === 'volume' || args[0] === 'image' || args[0] === 'container') && args.includes('prune')) || args[0] === 'rm' && shortHas(args, 'f') || args[0] === 'rmi') return { kind: WHY.erase, what: `${name} ${args.slice(0, 2).join(' ')}` }; break;
            case 'find': if (args.includes('-delete')) return { kind: WHY.erase, what: 'find -delete' }; break;
            case 'truncate': return { kind: WHY.erase, what: 'truncate' };
            default:
                if (/^mkfs(\.|$)/.test(name)) return { kind: WHY.disk, what: name };
        }
    }
    return null;
}

/* The line a terminal verb would run, as the rights judge it: terminal.run's command, terminal.type's text. */
export const lineOf = (verb, a = {}) => (verb === 'terminal.run' ? String(a.command ?? '') : verb === 'terminal.type' ? String(a.text ?? '') : '');
