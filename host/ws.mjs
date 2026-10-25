/* A SMALL WEBSOCKET SERVER, enough for the Tether browser extension and no
 * more. The keeper already depends on nothing but `ssh2`; a whole WebSocket
 * library for one self-made client on 127.0.0.1 would be out of proportion, so
 * the few frames we need are read and written here (RFC 6455).
 *
 * It speaks only to our own extension. It handles text messages (reassembling
 * fragments), ping/pong and close; it never sends masked frames (a server must
 * not) and expects client frames to be masked (a client must). A message over
 * MESSAGE_MAX closes the socket: the extension never sends one that big, so one
 * that does is not ours.
 *
 *   wsUpgrade(req, socket, head) -> channel | null   (null: not a WebSocket)
 *
 * A channel is what host/connectors/browser.mjs speaks:
 *   channel.send(obj)   channel.onMessage(fn)   channel.onClose(fn)   channel.close()
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MESSAGE_MAX = 32 * 1024 * 1024;

const accept = (key) => createHash('sha1').update(key + GUID).digest('base64');

/* One outgoing frame, unmasked, opcode given, payload a Buffer. */
function frame(opcode, payload = Buffer.alloc(0)) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    header[0] = 0x80 | opcode; // FIN + opcode
    return Buffer.concat([header, payload]);
}

export function wsUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) { try { socket.destroy(); } catch { /* gone */ } return null; }
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
    );

    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const frags = [];
    let fragOpcode = 0;
    let closed = false;
    const onMessage = new Set();
    const onClose = new Set();

    const close = (code = 1000) => {
        if (closed) return; closed = true;
        try { const p = Buffer.alloc(2); p.writeUInt16BE(code, 0); socket.write(frame(0x8, p)); } catch { /* gone */ }
        try { socket.end(); } catch { /* gone */ }
    };
    const dead = () => { if (closed) return; closed = true; for (const fn of onClose) { try { fn(); } catch { /* its fault */ } } };

    const deliver = (text) => { let obj; try { obj = JSON.parse(text); } catch { return; } for (const fn of onMessage) { try { fn(obj); } catch { /* its fault */ } } };

    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const b0 = buf[0]; const b1 = buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
            else if (len === 127) { if (buf.length < off + 8) return; const hi = buf.readUInt32BE(off); len = buf.readUInt32BE(off + 4); off += 8; if (hi !== 0 || len > MESSAGE_MAX) return close(1009); }
            if (!masked) return close(1002); // a client must mask
            if (buf.length < off + 4 + len) return; // wait for the rest
            const mask = buf.subarray(off, off + 4); off += 4;
            const payload = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
            off += len;
            buf = buf.subarray(off);

            if (opcode === 0x8) return close(1000);       // close
            if (opcode === 0x9) { try { socket.write(frame(0xA, payload)); } catch { /* gone */ } continue; } // ping -> pong
            if (opcode === 0xA) continue;                 // pong, ignore
            // text (0x1) / binary (0x2) / continuation (0x0)
            if (opcode === 0x0) frags.push(payload);
            else { frags.length = 0; frags.push(payload); fragOpcode = opcode; }
            let total = 0; for (const f of frags) total += f.length;
            if (total > MESSAGE_MAX) return close(1009);
            if (fin) { const whole = Buffer.concat(frags); frags.length = 0; if (fragOpcode === 0x1) deliver(whole.toString('utf8')); }
        }
    });
    socket.on('close', dead);
    socket.on('end', dead);
    socket.on('error', dead);

    return {
        send(obj) { if (closed) return; try { socket.write(frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'))); } catch { /* gone */ } },
        onMessage(fn) { onMessage.add(fn); return () => onMessage.delete(fn); },
        onClose(fn) { onClose.add(fn); return () => onClose.delete(fn); },
        close,
    };
}
