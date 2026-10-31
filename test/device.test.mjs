import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packet, command, reader, result, TYPE, CMD, STATE } from '../ui/improv.js';
import { device } from '../host/connectors/device.mjs';
import { keeper } from '../host/keeper.mjs';
import { cardOf } from '../server/cards.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tether-'));
const BOT = { id: 'agent:site', kind: 'agent', name: 'Assistant · site' };
const ME = { id: 'person:owner', kind: 'person', name: 'Owner' };
const tick = () => new Promise((r) => setImmediate(r));

test('Improv: a command is framed and summed as the device expects', () => {
    const p = command(CMD.WIFI, ['Maison', 'secret']);
    assert.equal(new TextDecoder().decode(p.subarray(0, 6)), 'IMPROV');
    assert.deepEqual([...p.subarray(6, 9)], [1, TYPE.RPC, 2 + 1 + 6 + 1 + 6]);
    assert.deepEqual([...p.subarray(9, 11)], [CMD.WIFI, 14]);
    const sum = [...p.subarray(0, p.length - 1)].reduce((a, b) => (a + b) & 0xff, 0);
    assert.equal(p.at(-1), sum);
    assert.throws(() => command(CMD.WIFI, ['x'.repeat(256)]), RangeError);
});

test('Improv: packets are found among log lines, in pieces, and a wrong sum is said', () => {
    const r = reader();
    const state = packet(TYPE.STATE, Uint8Array.of(STATE.PROVISIONED));
    const res = packet(TYPE.RESULT, Uint8Array.of(CMD.SCAN, 9, 4, ...new TextEncoder().encode('Home'), 3, 45, 53, 48));
    const log = new TextEncoder().encode('I (123) box: IMPRO not a packet\n');
    const all = Uint8Array.from([...log, ...state, ...log, ...res]);
    const found = [...r.push(all.subarray(0, 40)), ...r.push(all.subarray(40))];
    assert.equal(found.length, 2);
    assert.deepEqual(found[0], { type: TYPE.STATE, data: Uint8Array.of(STATE.PROVISIONED) });
    assert.deepEqual(result(found[1].data), { cmd: CMD.SCAN, strings: ['Home', '-50'] });
    const bad = packet(TYPE.STATE, Uint8Array.of(2)); bad[bad.length - 1] ^= 1;
    assert.deepEqual(r.push(bad), [{ bad: true }]);
});

test('a device job waits for a browser; its end is the agent\'s answer', async () => {
    const d = device();
    const t = { id: 'box', title: 'Voice box' };
    assert.throws(() => d.run('device.flash', t, { firmware: 'https://elsewhere.example/x.bin' }, {}), /address of this site/);
    assert.throws(() => d.run('device.flash', t, { firmware: '//elsewhere.example/x.bin' }, {}), /address of this site/);
    const p = d.run('device.flash', t, { firmware: '/api/boxes/firmware.bin', name: 'Salon', app: { url: 'https://clavarium.example.org', room: 'Salon', code: 'K7Q2-M9PX' } }, { agent: BOT.id });
    const [job] = d.jobs();
    assert.equal(job.module, 'device-flash.js');
    assert.equal(job.agent, BOT.id);
    assert.deepEqual(job.args, { firmware: '/api/boxes/firmware.bin', name: 'Salon', wifi: true, app: { url: 'https://clavarium.example.org', room: 'Salon', code: 'K7Q2-M9PX' } });
    assert.equal('end' in job, false);
    d.finish(job.id, true, 'flashed; joined the Wi-Fi Home');
    assert.equal((await p).text, 'flashed; joined the Wi-Fi Home');
    assert.equal(d.jobs().length, 0);
    assert.throws(() => d.finish(job.id, true, ''), /no such job/);
    const q = d.run('device.flash', t, { firmware: '/f.bin' }, {});
    d.finish(d.jobs()[0].id, false, 'no device was chosen');
    await assert.rejects(q, /no device was chosen/);
});

test('the keeper: device.flash asks a person, then waits for the page to run it', async () => {
    const k = keeper(tmp(), { connectors: { device: device() }, ask: () => undefined });
    k.store.putTarget({ id: 'box', title: 'Voice box', kind: 'device', connector: 'device' });
    k.store.grant('box', BOT.id, 'propose');
    const p = k.act('device.flash', { target: 'box', firmware: '/api/boxes/firmware.bin', why: 'Flash the new box.' }, BOT);
    await tick();
    const [req] = k.approvals();
    assert.equal(req.verb, 'device.flash');
    assert.equal(req.card.kind, 'device');
    await k.act('decide', { id: req.id, decision: 'yes' }, ME);
    await tick();
    const state = (await k.act('state', {}, ME)).data;
    assert.equal(state.jobs.length, 1);
    await k.act('job-done', { id: state.jobs[0].id, ok: true, text: 'flashed' }, ME);
    assert.equal((await p).text, 'flashed');
    assert.equal((await k.act('state', {}, ME)).data.jobs.length, 0);
});

test('a device card says what is flashed and where it goes', () => {
    assert.deepEqual(cardOf('device.flash', { firmware: '/f.bin', name: 'Salon', app: { url: 'https://c.example.org', room: 'Salon', code: 'X' } }),
        { kind: 'device', action: 'flash', firmware: '/f.bin', name: 'Salon', app: 'https://c.example.org', room: 'Salon' });
});

test('an image handed over by the agent: kept for the job, given to the page, never in the list', async () => {
    const k = keeper(tmp(), { connectors: { device: device() }, ask: () => undefined });
    k.store.putTarget({ id: 'box', title: 'Voice box', kind: 'device', connector: 'device' });
    k.store.grant('box', BOT.id, 'free');
    const image = Buffer.from([0xe9, 3, 2, 1]).toString('base64');
    const p = k.act('device.flash', { target: 'box', image, name: 'Salon', room: 'Salon', pair: true }, BOT);
    await tick();
    const [job] = (await k.act('state', {}, ME)).data.jobs;
    assert.equal(job.args.image.bytes, 4);
    assert.equal(job.args.pair, true);
    assert.equal(job.args.room, 'Salon');
    assert.equal(JSON.stringify(job).includes(image), false);
    assert.equal((await k.act('job-file', { id: job.id }, ME)).data.image, image);
    await k.act('job-done', { id: job.id, ok: true, text: 'flashed' }, ME);
    assert.equal((await p).text, 'flashed');
    const none = await k.act('device.flash', { target: 'box', name: 'x' }, BOT);
    assert.equal(none.ok, false);
});

test('on Android, the flash goes through WebUSB: Chrome\'s own serial ports there are Bluetooth ones', async () => {
    const { android } = await import('../ui/device-flash.js');
    assert.equal(android({ userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/141.0 Safari/537.36' }), true);
    assert.equal(android({ userAgentData: { platform: 'Android' }, userAgent: '' }), true);
    assert.equal(android({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0 Safari/537.36' }), false);
});

test('a voice box: its volume and an alert, through the application\'s own connector', async () => {
    const done = [];
    const voicebox = { run: async (verb, t, a) => { done.push([verb, t.config.box, a.level ?? a.text]); return { text: 'done' }; } };
    const k = keeper(tmp(), { connectors: { voicebox }, ask: () => undefined });
    k.store.putTarget({ id: 'box-salon', title: 'Voice box Salon', kind: 'voicebox', connector: 'voicebox', config: { box: 'b-1' } });
    k.store.grant('box-salon', BOT.id, 'free');
    assert.equal((await k.act('voicebox.volume', { target: 'box-salon', level: 85 }, BOT)).text, 'done');
    assert.equal((await k.act('voicebox.volume', { target: 'box-salon', level: 140 }, BOT)).ok, false);
    await k.act('voicebox.alert', { target: 'box-salon', text: 'Dinner is ready' }, BOT);
    assert.deepEqual(done, [['voicebox.volume', 'b-1', 85], ['voicebox.alert', 'b-1', 'Dinner is ready']]);
});
