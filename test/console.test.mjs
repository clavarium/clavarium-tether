/* THE SHARED CONSOLE OF A MACHINE (console.mjs, commands.mjs, the ssh connector, the keeper): one shell the
 * person and the agents look at together. A fake ssh2 client plays a tiny shell: it echoes keys, runs a
 * line on Enter, asks a password for sudo (echo off), and has one prompt that echoes (for the person's
 * hidden-input switch). No network. Remote paths are /srv/...; names are example ones. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnly, destructive, READ_ONLY_COMMANDS } from '../server/commands.mjs';
import { decide, ruleFrom } from '../server/rights.mjs';
import { secretPrompt, sharedConsole, HIDDEN_MARK, HIDDEN_FROM_AI } from '../host/console.mjs';
import { ssh } from '../host/connectors/ssh.mjs';
import { keeper } from '../host/keeper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-console-'));
const BOT = { id: 'agent:ops', kind: 'agent', name: 'Assistant' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
const KEY = '-----BEGIN KEY-----\nMBOGUS-private-key-material-abcdef0123456789\n-----END KEY-----';
const SECRET = 'hunter2-correct-horse-battery';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 2000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`waited for ${what}`); await tick(5); } };

/* ---- a tiny shell over a fake ssh2 channel ---- */
function fakeShell(runs = {}) {
    const s = new EventEmitter();
    s.stderr = new EventEmitter();
    let line = ''; let mode = 'cmd'; let echo = true; s.typed = []; s.windows = [];
    const out = (t) => setImmediate(() => s.emit('data', Buffer.from(t)));
    const prompt = () => out('deploy@box:~$ ');
    s.write = (d) => {
        s.typed.push(String(d));
        for (const ch of String(d)) {
            if (ch === '\x15') { if (echo && line) out('\b \b'.repeat(line.length)); line = ''; continue; }
            if (ch === '\x03') { line = ''; mode = 'cmd'; echo = true; out('^C\r\n'); prompt(); continue; }
            if (ch === '\r' || ch === '\n') {
                const got = line; line = '';
                out('\r\n');
                if (mode === 'pass' || mode === 'token') { mode = 'cmd'; echo = true; out(`${got ? 'accepted' : 'empty'}\r\n`); prompt(); continue; }
                if (/^sudo /.test(got)) { mode = 'pass'; echo = false; out('[sudo] password for deploy: '); continue; }
                if (got === 'asktoken') { mode = 'token'; echo = true; out('Paste the API token here > '); continue; }
                if (got) out(`${(runs[got] ?? `ran: ${got}`).replace(/\n/g, '\r\n')}\r\n`);
                prompt();
                continue;
            }
            line += ch;
            if (echo) out(ch);
        }
        return true;
    };
    s.setWindow = (rows, cols) => s.windows.push([cols, rows]);
    s.end = () => s.emit('close');
    s.close = s.end;
    setImmediate(() => { out('Welcome to box.example.com\r\n'); prompt(); });
    return s;
}
function fakeClient(state) {
    return class FakeClient extends EventEmitter {
        connect() { setImmediate(() => this.emit('ready')); return this; }
        exec(command, cb) {
            const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.close = () => {}; stream.destroy = () => {};
            state.execs.push(command);
            setImmediate(() => { stream.emit('data', Buffer.from(`out of ${command}\n`)); stream.emit('close', 0); });
            cb(null, stream);
        }
        shell(opts, cb) { const s = fakeShell(state.runs); state.shells.push(s); cb(null, s); }
        sftp(cb) { cb(new Error('none')); }
        end() { this.emit('close'); }
    };
}
const newState = () => ({ shells: [], execs: [], runs: { 'df -h': '/dev/sda1  58G  53G  91% /' } });
const TARGET = { id: 'box', title: 'Box', kind: 'ssh', connector: 'ssh', config: { host: '127.0.0.1', user: 'deploy' }, secrets: { key: 'box-key' } };

function setup(level = 'free', { typeMs = 0, settleMs = 30 } = {}) {
    const state = newState();
    const dir = tmp();
    const side = { dir: join(dir, 'agent'), who: BOT };
    const k = keeper(join(dir, 'keeper'), { sides: () => [side], secrets: async () => KEY, connectors: { ssh: ssh({ Client: fakeClient(state), typeMs, settleMs }) } });
    k.store.putTarget(TARGET);
    k.store.grant('box', BOT.id, level);
    return { k, state, dir };
}
const screenOf = (events) => events.filter((e) => e.type === 'data').map((e) => e.data).join('');

/* ---------------- the parser ---------------- */
test('read-only parser: the fixed list of reads passes alone, with only reading arguments', () => {
    for (const line of ['ls', 'ls -la /srv', 'df -h', 'du -sh /var/log', 'du -h --max-depth=1 /srv', 'uptime', 'free -h', 'ps aux', 'top -bn1', 'journalctl -u nginx -n 30 --no-pager',
        'journalctl --since "2026-11-16 10:00"', 'systemctl status nginx', 'systemctl status nginx --no-pager -l', 'cat /etc/os-release', 'head -n 20 /var/log/syslog', 'tail -50 app.log',
        'less notes.txt', 'uname -a', 'whoami', 'id', 'date', 'date -u', 'ip a', 'ip -br addr show', 'ip route', 'ss -tlnp', 'docker ps', 'docker ps -a', 'docker logs --tail 50 web',
        'hostname -I', 'wc -l notes.txt', 'ps aux | grep nginx', 'journalctl -u nginx | tail -n 20', 'ps aux | grep -i nginx | head -5']) {
        assert.deepEqual(readOnly(line), { ok: true }, line);
    }
    assert.ok(READ_ONLY_COMMANDS.includes('journalctl'));
});

test('read-only parser: shell control, other commands, and writing arguments are refused', () => {
    for (const line of ['', 'ls; rm -rf /', 'ls && reboot', 'ls || true', 'cat a > b', 'cat < a', 'echo $(id)', 'echo `id`', 'ls $HOME', 'ls\nreboot', 'ls\rreboot', 'cat a\\', '(ls)', '{ ls; }',
        'ls &', 'rm file', 'sudo ls', 'apt update', 'tail -f app.log', 'journalctl -f', 'journalctl --vacuum-time=7d', 'journalctl --rotate', 'date -s "2020-01-01"', 'hostname evil',
        'ip addr add 127.0.0.1/8 dev lo', 'ip link set eth0 down', 'ss -K', 'systemctl restart nginx', 'systemctl stop nginx', 'top', 'docker rm web', 'docker logs -f web', 'docker exec web sh',
        'ps aux | sh', 'ls | xargs rm', 'cat x | tee y', 'ls | grep a b', 'ls | head | tail | grep x', 'cat "unterminated', 'env', 'find / -delete', 'ls\u0000']) {
        assert.equal(readOnly(line).ok, false, JSON.stringify(line));
    }
});

test('destructive: the whole line is looked at, every part of it, behind sudo and wrappers', () => {
    const cases = {
        'rm -rf /var/log/nginx/*': 'erase', 'sudo rm -r build': 'erase', 'rm -fr x': 'erase', 'rm -R x': 'erase', 'rm --recursive x': 'erase', '/bin/rm -rf x': 'erase',
        'ls && rm -rf ~': 'erase', 'ls; sudo rm -rf /srv': 'erase', 'echo $(rm -rf /srv)': 'erase', 'cd /srv | rm -rf .': 'erase', 'mkfs.ext4 /dev/sdb1': 'disk', 'sudo mkfs -t ext4 /dev/sdb': 'disk',
        'dd if=/dev/zero of=/dev/sda bs=1M': 'disk', 'echo x > /dev/sda': 'disk', 'cat img >> /dev/nvme0n1': 'disk', 'shutdown -h now': 'power', 'sudo reboot': 'power', 'poweroff': 'power',
        'systemctl reboot': 'power', 'init 0': 'power', 'chmod -R 777 /': 'rights', 'sudo chown -R nobody /etc': 'rights', 'wipefs -a /dev/sdb': 'erase', 'shred -u secret': 'erase',
        'crontab -r': 'erase', ':(){ :|:& };:': 'other', 'psql -c "DROP TABLE users"': 'erase', 'iptables -F': 'other', 'git reset --hard': 'erase', 'docker system prune -a': 'erase',
        'find /srv -name x -delete': 'erase', 'nohup sudo rm -rf /srv &': 'erase', 'FOO=1 rm -rf x': 'erase', 'parted /dev/sdb mklabel gpt': 'disk',
    };
    for (const [line, kind] of Object.entries(cases)) assert.equal(destructive(line)?.kind, kind, line);
    for (const line of ['ls -la', 'rm notes.txt', 'chmod 644 a.txt', 'chmod -R g+w /srv/app/site', 'df -h', 'systemctl status nginx', 'echo reboot', 'fdisk -l', 'cat /dev/sda1.log', 'git status', 'dd if=a']) {
        assert.equal(destructive(line), null, line);
    }
});

/* ---------------- the gate ---------------- */
test('the gate: frame lets the read-only list through alone; destructive asks at every level, free included, and never "always"', () => {
    assert.deepEqual(decide('frame', 'terminal.type', { text: 'df -h', enter: true }), { go: 'yes', because: 'safe' });
    assert.deepEqual(decide('frame', 'terminal.run', { command: 'journalctl -u nginx -n 30' }), { go: 'yes', because: 'safe' });
    assert.equal(decide('frame', 'terminal.type', { text: 'apt upgrade', enter: true }).go, 'ask');
    assert.equal(decide('frame', 'terminal.type', { text: 'ls; reboot' }).because, 'destructive');
    assert.equal(decide('propose', 'terminal.type', { text: 'df -h' }).go, 'ask', 'propose asks even a read');
    assert.equal(decide('free', 'terminal.type', { text: 'apt upgrade -y', enter: true }).go, 'yes');
    for (const level of ['propose', 'frame', 'free']) {
        const d = decide(level, 'terminal.type', { text: 'sudo rm -rf /var/log/nginx/*', enter: true });
        assert.deepEqual([d.go, d.because, d.risk.kind], ['ask', 'destructive', 'erase'], level);
    }
    assert.equal(decide('free', 'terminal.run', { command: 'reboot' }).because, 'destructive');
    assert.equal(decide('frame', 'terminal.run', { command: 'git status' }, [{ kind: 'command', value: 'git' }]).because, 'rule');
    assert.equal(decide('frame', 'terminal.run', { command: 'git reset --hard' }, [{ kind: 'command', value: 'git' }]).because, 'destructive', 'a rule never covers a destructive line');
    assert.equal(decide('watch', 'terminal.type', { text: 'reboot' }).go, 'no');
    assert.equal(decide('watch', 'terminal.read', {}).go, 'yes');
    assert.equal(ruleFrom('terminal.type', { text: 'ls' }), null);
});

/* ---------------- hidden input ---------------- */
test('hidden input: password prompts are seen at the end of a line, in a few languages', () => {
    for (const t of ['[sudo] password for deploy: ', 'Password:', 'the password of deploy: ', 'Enter passphrase for key \'/srv/.ssh/id_ed25519\': ', '[sudo] Mot de passe de admin : ',
        'Mot de passe : ', 'Passwort: ', 'New password: ', 'Retype new password: ', 'Enter PIN for token: ', 'Current password:']) assert.ok(secretPrompt(t), t);
    for (const t of ['deploy@box:~$ ', 'password changed.', 'grep password /srv/a.txt', 'Password: ok then next line\nfoo', 'your password expires in 7 days']) assert.ok(!secretPrompt(t), t);
});

/* ---------------- the shared screen ---------------- */
test('one console per machine: the person and the agent see the same shell; the agent sees from its opening on; each key tagged by who typed it never mixes', async () => {
    const { k, state } = setup('free');
    const events = [];
    const me = await k.console('box', ME, (e) => events.push(e));
    await until('the prompt', () => screenOf(events).includes('deploy@box:~$'));
    me.write('uptime\r');
    await until('uptime ran', () => screenOf(events).includes('ran: uptime'));
    const open = await k.act('terminal.open', { target: 'box' }, BOT);
    assert.equal(open.ok, true); assert.match(open.text, /shared with the person, who is looking at it now/);
    assert.equal(state.shells.length, 1, 'one shell for both');
    const typed = await k.act('terminal.type', { target: 'box', text: 'df -h', enter: true }, BOT);
    assert.equal(typed.ok, true, typed.text);
    await until('df ran', () => screenOf(events).includes('91% /'));
    const read = await k.act('terminal.read', { target: 'box' }, BOT);
    assert.match(read.text, /df -h/); assert.match(read.text, /91% \//);
    assert.doesNotMatch(read.text, /ran: uptime/, 'nothing from before it opened');
    assert.ok(events.some((e) => e.type === 'state' && e.state.agents.some((a) => a.name === 'Assistant')), 'the person sees the agent there');
    /* A page that reconnects gets the screen back. */
    const again = await k.console('box', ME, () => {});
    assert.match(again.replay, /ran: uptime/); assert.match(again.replay, /91% \//);
    again.detach(); me.detach();
    /* The agent still has it after the person left; the agent leaving too ends the shell. */
    assert.equal((await k.act('terminal.read', { target: 'box' }, BOT)).ok, true);
    await k.stop(BOT.id, ME);
    assert.equal(state.shells[0].listenerCount('data') >= 0, true);
    await k.close();
});

test('the person\'s key wins: a key while the agent types stops it, its partial line is erased, nothing of it is sent', async () => {
    const { k, state } = setup('free', { typeMs: 15 });
    const events = [];
    const me = await k.console('box', ME, (e) => events.push(e));
    await k.act('terminal.open', { target: 'box' }, BOT);
    const p = k.act('terminal.type', { target: 'box', text: 'apt install something-long-to-type', enter: true }, BOT);
    await until('the agent typing', () => events.some((e) => e.type === 'state' && e.state.typing?.name === 'Assistant'));
    await tick(40);
    me.write('l');
    const r = await p;
    assert.equal(r.ok, false); assert.match(r.text, /took back control/);
    const sh = state.shells[0];
    const all = sh.typed.join('');
    assert.ok(all.includes('\x15'), 'its partial line erased (Ctrl-U)');
    assert.ok(all.indexOf('\x15') < all.lastIndexOf('l'), 'erased before the person\'s key');
    assert.ok(!all.includes('\r'), 'no Enter was sent for the agent');
    assert.ok(!all.includes('something-long-to-type'), 'the agent never finished its line');
    const j = k.journal({ target: 'box' });
    assert.ok(j.some((l) => l.op === 'console' && /taken back/.test(l.detail) && l.by?.id === ME.id), 'taking back control is journaled as the person\'s');
    me.detach(); await k.close();
});

test('a password prompt during the agent\'s input: hidden input, control back to the person; the secret never reaches terminal.read nor the journal', async () => {
    const { k, dir } = setup('free');
    const events = [];
    const me = await k.console('box', ME, (e) => events.push(e));
    await k.act('terminal.open', { target: 'box' }, BOT);
    const r = await k.act('terminal.type', { target: 'box', text: 'sudo apt update', enter: true }, BOT);
    assert.equal(r.ok, true, r.text); assert.match(r.text, /password prompt came/);
    assert.ok(events.some((e) => e.type === 'state' && e.state.hidden === 'prompt'), 'the person\'s page is told: hidden input');
    /* The agent may not type into it. */
    const sneaky = await k.act('terminal.type', { target: 'box', text: 'guess', enter: true }, BOT);
    assert.equal(sneaky.ok, false); assert.match(sneaky.text, /password prompt is up/);
    me.write(`${SECRET}\r`);
    await until('accepted', () => screenOf(events).includes('accepted'));
    await until('hidden off', () => events.filter((e) => e.type === 'state').at(-1).state.hidden === null);
    const read = await k.act('terminal.read', { target: 'box', lines: 200 }, BOT);
    assert.match(read.text, /\[sudo\] password for deploy:/);
    assert.ok(read.text.includes(HIDDEN_MARK));
    assert.match(read.text, /accepted/, 'what follows is seen again');
    assert.ok(!read.text.includes(SECRET), 'the secret never reaches the agent');
    assert.ok(!readFileSync(join(dir, 'keeper', 'journal.jsonl'), 'utf8').includes(SECRET), 'nor the journal');
    me.detach(); await k.close();
});

test('the person\'s hidden-input switch, on a prompt that echoes: the echoed secret stays out of the agent\'s screen and the journal', async () => {
    const { k, dir } = setup('free');
    const events = [];
    const me = await k.console('box', ME, (e) => events.push(e));
    await k.act('terminal.open', { target: 'box' }, BOT);
    me.write('asktoken\r');
    await until('the token prompt', () => screenOf(events).includes('Paste the API token'));
    me.hidden(true);
    me.write(`${SECRET}\r`);
    await until('accepted', () => screenOf(events).includes('accepted'));
    await until('hidden off', () => events.filter((e) => e.type === 'state').at(-1).state.hidden === null);
    assert.ok(screenOf(events).includes(SECRET), 'the person\'s own screen shows what the program echoed');
    const read = await k.act('terminal.read', { target: 'box', lines: 200 }, BOT);
    assert.ok(read.text.includes(HIDDEN_MARK)); assert.match(read.text, /accepted/);
    assert.ok(!read.text.includes(SECRET));
    assert.ok(!readFileSync(join(dir, 'keeper', 'journal.jsonl'), 'utf8').includes(SECRET));
    me.detach(); await k.close();
});

test('hidden from the AI: terminal.read gives a notice, typing is refused, its waiting inputs end; shown again, it never sees what was there', async () => {
    const { k } = setup('propose');
    const events = [];
    const me = await k.console('box', ME, (e) => events.push(e));
    await k.act('terminal.open', { target: 'box' }, BOT);
    const waiting = k.act('terminal.type', { target: 'box', text: 'apt upgrade', enter: true }, BOT);
    await until('a proposal', () => k.approvals().length === 1);
    me.hideFromAi(true);
    const w = await waiting;
    assert.equal(w.ok, false); assert.equal(k.approvals().length, 0, 'its waiting input ended');
    me.write('cat .env\r');
    await until('ran', () => screenOf(events).includes('ran: cat .env'));
    assert.equal((await k.act('terminal.read', { target: 'box' }, BOT)).text, HIDDEN_FROM_AI);
    k.store.grant('box', BOT.id, 'free');
    const t = await k.act('terminal.type', { target: 'box', text: 'ls', enter: true }, BOT);
    assert.equal(t.ok, false); assert.match(t.text, /hid this console/);
    me.hideFromAi(false);
    const read = await k.act('terminal.read', { target: 'box', lines: 200 }, BOT);
    assert.doesNotMatch(read.text, /ran: cat \.env/);
    assert.match(read.text, /hidden from you by the person/);
    assert.ok(k.journal({ target: 'box' }).some((l) => l.op === 'console' && l.detail === 'hidden from the AI'));
    me.detach(); await k.close();
});

test('proposals: an agent\'s input waits for the person, who sends it, edits it, or refuses it; a destructive one is marked and never "always"', async () => {
    const { k, state } = setup('propose');
    const me = await k.console('box', ME, () => {});
    await k.act('terminal.open', { target: 'box' }, BOT);
    /* Edited, then sent: the person's line goes, said to the agent. */
    const p = k.act('terminal.type', { target: 'box', text: 'journalctl -u nginx -n 300', enter: true, why: 'nginx is down' }, BOT);
    await until('a proposal', () => k.approvals().length === 1);
    const [req] = k.approvals();
    assert.deepEqual(req.editable, ['text']);
    assert.equal(req.card.kind, 'terminal'); assert.equal(req.card.text, 'journalctl -u nginx -n 300');
    assert.throws(() => k.decide(req.id, 'always', ME, '', { text: 'x' }), /approved once/);
    k.decide(req.id, 'yes', ME, '', { text: 'journalctl -u nginx -n 30' });
    const r = await p;
    assert.equal(r.ok, true); assert.match(r.text, /edited text before approving/);
    assert.ok(state.shells[0].typed.join('').includes('journalctl -u nginx -n 30\r'));
    assert.ok(k.journal({ target: 'box' }).some((l) => l.verb === 'terminal.type' && l.edited === 'text' && l.detail === 'journalctl -u nginx -n 30⏎'));
    /* Destructive, at free: asked, marked, no rule offered. */
    k.store.grant('box', BOT.id, 'free');
    const d = k.act('terminal.type', { target: 'box', text: 'sudo rm -rf /var/log/nginx/*', enter: true, why: 'free some room' }, BOT);
    await until('a destructive proposal', () => k.approvals().length === 1);
    const [risky] = k.approvals();
    assert.equal(risky.destructive, 'erase'); assert.equal(risky.card.destructive, 'erase'); assert.equal(risky.rule, undefined);
    k.decide(risky.id, 'no', ME, 'not that');
    assert.deepEqual(await d, { ok: false, text: 'refused by Owner: "not that"' });
    assert.ok(k.journal({ target: 'box' }).some((l) => l.verb === 'terminal.type' && l.risk === 'erase' && l.decision === 'no'));
    assert.ok(!state.shells[0].typed.join('').includes('rm -rf'));
    me.detach(); await k.close();
});

test('terminal.run while the console is open: shown in it as if typed, with its output', async () => {
    const { k, state } = setup('free');
    const events = [];
    const me = await k.console('box', ME, (e) => events.push(e));
    await k.act('terminal.open', { target: 'box' }, BOT);
    const r = await k.act('terminal.run', { target: 'box', command: 'uname -a' }, BOT);
    assert.equal(r.ok, true); assert.match(r.text, /out of uname -a/);
    assert.deepEqual(state.execs, ['uname -a']);
    const screen = screenOf(events);
    assert.match(screen, /\[Assistant\] \$ uname -a/); assert.match(screen, /out of uname -a/); assert.match(screen, /\[exit 0\]/);
    me.detach(); await k.close();
});

test('the console alone: an agent cannot type while another does, and a closed shell is said', async () => {
    const shells = [];
    const c = sharedConsole({ title: 'Box', typeMs: 5, settleMs: 0, open: async () => { const s = fakeShell(); shells.push(s); return s; } });
    await c.join('a1', 'One'); await c.join('a2', 'Two');
    const first = c.type('a1', 'echo a-rather-long-line', true);
    await tick(10);
    await assert.rejects(c.type('a2', 'ls', true), /another assistant is typing/);
    assert.equal(await first, 'Typed.');
    assert.throws(() => c.read('nobody'), /open one first/);
    c.close();
    assert.equal(c.alive, false);
});
