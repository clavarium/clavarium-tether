/* IMPROV WI-FI OVER A SERIAL LINE (improv-wifi.com, serial version 1): how a device
 * that was just flashed is given its Wi-Fi by the same page, over the same cable.
 *
 * A packet: "IMPROV", version 1, type, length, data, checksum (the sum of every byte
 * before it). The device answers an RPC with a result (strings, each with its length),
 * tells its state, or an error. Command 0xC0 is not Improv's: our devices take with it
 * the address of the application to join, a room and a one-use pairing code.
 *
 * Pure functions: the browser module (device-flash.js) moves the bytes.
 */
export const TYPE = Object.freeze({ STATE: 1, ERROR: 2, RPC: 3, RESULT: 4 });
export const STATE = Object.freeze({ READY: 2, PROVISIONING: 3, PROVISIONED: 4 });
export const ERROR = Object.freeze({ NONE: 0, INVALID: 1, UNKNOWN: 2, CONNECT: 3, PAIRING: 0x80, OTHER: 0xff });
export const CMD = Object.freeze({ WIFI: 1, STATE: 2, INFO: 3, SCAN: 4, APP: 0xc0 });
const MAGIC = [73, 77, 80, 82, 79, 86];   // "IMPROV"
const enc = new TextEncoder();
const dec = new TextDecoder();

export function packet(type, data) {
    const out = new Uint8Array(10 + data.length);
    out.set(MAGIC, 0);
    out[6] = 1; out[7] = type; out[8] = data.length;
    out.set(data, 9);
    let sum = 0;
    for (let i = 0; i < 9 + data.length; i++) sum = (sum + out[i]) & 0xff;
    out[9 + data.length] = sum;
    return out;
}

/* An RPC command with its strings. */
export function command(cmd, strings = []) {
    const parts = strings.map((s) => enc.encode(String(s)));
    for (const p of parts) if (p.length > 255) throw new RangeError('a string longer than 255 bytes');
    const body = [];
    for (const p of parts) body.push(p.length, ...p);
    if (body.length > 253) throw new RangeError('the command is too long');
    return packet(TYPE.RPC, Uint8Array.from([cmd, body.length, ...body]));
}

/* Reads packets out of a byte stream that also carries the device's log lines.
   push(bytes) -> the complete packets found: { type, data } (and { bad: true } for a wrong checksum). */
export function reader() {
    let buf = [];
    return {
        push(bytes) {
            for (const b of bytes) buf.push(b);
            const found = [];
            for (;;) {
                let at = -1;
                for (let i = 0; i + 6 <= buf.length; i++) if (MAGIC.every((m, k) => buf[i + k] === m)) { at = i; break; }
                if (at < 0) { buf = buf.slice(Math.max(0, buf.length - 5)); break; }
                if (buf.length < at + 9) { buf = buf.slice(at); break; }
                const len = buf[at + 8];
                if (buf.length < at + 10 + len) { buf = buf.slice(at); break; }
                let sum = 0;
                for (let i = at; i < at + 9 + len; i++) sum = (sum + buf[i]) & 0xff;
                const type = buf[at + 7];
                const data = Uint8Array.from(buf.slice(at + 9, at + 9 + len));
                found.push(sum === buf[at + 9 + len] && buf[at + 6] === 1 ? { type, data } : { bad: true });
                buf = buf.slice(at + 10 + len);
            }
            return found;
        },
    };
}

/* A result's command and strings. */
export function result(data) {
    const cmd = data[0];
    const len = data[1] ?? 0;
    const strings = [];
    for (let at = 2; at < 2 + len && at < data.length;) {
        const l = data[at];
        strings.push(dec.decode(data.subarray(at + 1, at + 1 + l)));
        at += 1 + l;
    }
    return { cmd, strings };
}
