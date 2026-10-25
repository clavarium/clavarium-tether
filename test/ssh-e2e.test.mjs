/* ONE REAL END TO END, when this machine has an sshd to throw away.
 *
 * It starts an ordinary OpenSSH server in a temp dir, on a high loopback port,
 * with a freshly made host key and one client key — nothing system-wide, no
 * root — then drives the real ssh2 connector against it: a command with its
 * exit code, and a file written and read back over SFTP, with the server's
 * host key pinned so the real host-key check runs too. The server is stopped
 * by its pid and the temp dir removed.
 *
 * Where no sshd (or ssh-keygen) is found, the test skips itself and says so:
 * the fake-client tests in test/ssh.test.mjs are what the connector is held to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ssh } from '../host/connectors/ssh.mjs';

const sshdPath = ['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd'].find((p) => existsSync(p));
const keygen = (() => { try { return execFileSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const canRun = !!(sshdPath && keygen);

const waitFor = async (fn, ms = 4000, step = 50) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); } return false; };

test('ssh end to end against a throwaway sshd', { skip: canRun ? false : 'no sshd/ssh-keygen on this machine' }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-sshd-'));
    let sshd;
    try {
        execFileSync(keygen, ['-q', '-t', 'ed25519', '-f', join(dir, 'host'), '-N', '']);
        execFileSync(keygen, ['-q', '-t', 'ed25519', '-f', join(dir, 'client'), '-N', '']);
        writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'client.pub')));
        chmodSync(join(dir, 'authorized_keys'), 0o600);
        const user = userInfo().username;
        const port = 49000 + Math.floor(Math.random() * 15000);
        writeFileSync(join(dir, 'sshd_config'), [
            `Port ${port}`,
            'ListenAddress 127.0.0.1',
            `HostKey ${join(dir, 'host')}`,
            `PidFile ${join(dir, 'sshd.pid')}`,
            `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
            'UsePAM no',
            'StrictModes no',
            'PasswordAuthentication no',
            `AllowUsers ${user}`,
            'Subsystem sftp internal-sftp',
            '',
        ].join('\n'));

        const log = join(dir, 'sshd.log');
        sshd = spawn(sshdPath, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', (await import('node:fs')).openSync(log, 'w')] });
        const up = await waitFor(() => { try { return /Server listening on/.test(readFileSync(log, 'utf8')); } catch { return false; } });
        if (!up) { const why = (() => { try { return readFileSync(log, 'utf8').trim().split('\n')[0]; } catch { return 'no log'; } })(); return t.skip(`sshd did not start here: ${why}`); }

        /* The host key as a known-hosts-style pin: the base64 field of host.pub. */
        const pin = readFileSync(join(dir, 'host.pub'), 'utf8').trim();
        const privateKey = readFileSync(join(dir, 'client'), 'utf8');
        const root = join(dir, 'work');
        execFileSync('mkdir', ['-p', root]);

        const c = ssh();
        const target = { id: 'e2e', title: 'Throwaway', kind: 'ssh', connector: 'ssh', config: { host: '127.0.0.1', port, user, pin, root }, secrets: { key: 'k' } };
        const ctx = { agent: 'agent:e2e', secret: async (k) => (k === 'key' ? privateKey : '') };
        try {
            const run = await c.run('terminal.run', target, { command: 'echo hello-$((6*7)); exit 5' }, ctx);
            assert.match(run.text, /hello-42/);
            assert.equal(run.exit, 5);

            await c.run('files.write', target, { path: 'note.txt', text: 'over sftp' }, ctx);
            assert.equal((await c.run('files.read', target, { path: 'note.txt' }, ctx)).text, 'over sftp');
            assert.match((await c.run('files.list', target, { path: '.' }, ctx)).text, /note.txt/);
            assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'over sftp', 'the file really landed on disk');

            await assert.rejects(c.run('files.read', target, { path: '/etc/hostname' }, ctx), /outside the folder/);
        } finally { await c.shutdown(); }
    } finally {
        if (sshd?.pid) { try { process.kill(sshd.pid, 'SIGTERM'); } catch { /* already gone */ } await new Promise((r) => setTimeout(r, 100)); try { process.kill(sshd.pid, 'SIGKILL'); } catch { /* gone */ } }
        rmSync(dir, { recursive: true, force: true });
        assert.equal(readdirSync(tmpdir()).some((n) => n === dir.split('/').pop()), false, 'the temp dir is gone');
    }
});
