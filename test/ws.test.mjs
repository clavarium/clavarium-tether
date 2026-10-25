/* THE SMALL WEBSOCKET SERVER: it reads a masked client frame and writes an
 * unmasked server frame, without a library. A fake socket (an EventEmitter that
 * captures what is written) stands in for the TCP socket, so the handshake and
 * the framing run their real code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { wsUpgrade } from '../host/ws.mjs';

/* A client (masked) text frame for one string, one chunk. */
function clientFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
}
/* Read a server (unmasked) text frame's payload. */
function serverPayload(buf) {
    let len = buf[1] & 0x7f; let off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = buf.readUInt32BE(6); off = 10; }
    return buf.subarray(off, off + len).toString('utf8');
}

function fakeSocket() {
    const s = new EventEmitter();
    s.written = [];
    s.write = (b) => { s.written.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); return true; };
    s.end = () => s.emit('close');
    s.destroy = () => s.emit('close');
    return s;
}

test('ws: the handshake accepts a key, then a masked frame arrives decoded', async () => {
    const s = fakeSocket();
    const req = { headers: { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
    const got = [];
    const channel = wsUpgrade(req, s, Buffer.alloc(0));
    channel.onMessage((m) => got.push(m));
    /* RFC 6455's worked example: this key yields this accept. */
    assert.match(s.written[0].toString(), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    s.emit('data', clientFrame(JSON.stringify({ t: 'hello', token: 'abc' })));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, [{ t: 'hello', token: 'abc' }]);
});

test('ws: a frame split across two chunks is reassembled', async () => {
    const s = fakeSocket();
    const channel = wsUpgrade({ headers: { upgrade: 'websocket', 'sec-websocket-key': 'x' } }, s, Buffer.alloc(0));
    const got = [];
    channel.onMessage((m) => got.push(m));
    const frame = clientFrame(JSON.stringify({ t: 'ping' }));
    s.emit('data', frame.subarray(0, 3));
    s.emit('data', frame.subarray(3));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, [{ t: 'ping' }]);
});

test('ws: send writes an unmasked frame the far end can read back', () => {
    const s = fakeSocket();
    const channel = wsUpgrade({ headers: { upgrade: 'websocket', 'sec-websocket-key': 'x' } }, s, Buffer.alloc(0));
    s.written.length = 0;
    channel.send({ t: 'call', id: '1', verb: 'shot' });
    const frame = s.written[0];
    assert.equal(frame[0], 0x81, 'FIN + text');
    assert.equal(frame[1] & 0x80, 0, 'a server never masks');
    assert.deepEqual(JSON.parse(serverPayload(frame)), { t: 'call', id: '1', verb: 'shot' });
});

test('ws: a non-websocket request is refused', () => {
    const s = fakeSocket();
    let destroyed = false; s.destroy = () => { destroyed = true; };
    const channel = wsUpgrade({ headers: {} }, s, Buffer.alloc(0));
    assert.equal(channel, null);
    assert.equal(destroyed, true);
});
