/* WHAT A WAITING CALL IS, AS FACTS A PAGE CAN SHOW. A person approves an act from a
 * card -- who, when, where, what -- not from a verb name: so each request carries
 * `card`, plain fields taken from the call's arguments (never a file's bytes, a body
 * kept short), and, where the connector can tell, what the act is about (the mail
 * answered, the invitation). The page words it in its own language.
 *
 *   { kind: 'mail' | 'calendar' | 'contacts' | 'terminal' | 'files' | 'browser' | 'screen' | 'device' | 'other',
 *     action: 'send' | 'reply' | 'forward' | 'create' | 'respond' | ...,  ...fields }
 */
const BODY_MAX = 600;
const list = (v) => String(v ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const short = (v, n = BODY_MAX) => { const s = String(v ?? '').replace(/\r\n?/g, '\n').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const kb = (b64) => Math.max(1, Math.round((String(b64 ?? '').replace(/\s+/g, '').length * 3 / 4) / 1024));
const filesOf = (a) => (Array.isArray(a.attachments) ? a.attachments.map((f) => ({ name: String(f?.name || 'attachment'), kb: kb(f?.bytes) }))
    : a.attach ? [{ name: String(a.attachName || 'attachment'), kb: kb(a.attach) }] : []);
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));

export function cardOf(verb, a = {}, target = {}) {
    const [area, act] = String(verb).split('.');
    const self = String(target?.config?.user ?? '').trim().toLowerCase() || undefined;
    switch (area) {
        case 'mail': {
            const base = { kind: 'mail', action: act, self };
            if (act === 'send' || act === 'reply' || act === 'forward') {
                return drop({ ...base, to: list(a.to), cc: list(a.cc), bcc: list(a.bcc), subject: a.subject, body: short(a.body), files: filesOf(a),
                    all: a.all === true || undefined, keep: a.keep, draft: a.draft === true || undefined, at: a.at, uid: a.uid });
            }
            return drop({ ...base, uid: a.uid, mailbox: a.mailbox, flag: a.flag, text: a.text });
        }
        case 'calendar': {
            const base = { kind: 'calendar', action: act, self };
            if (act === 'create' || act === 'update') {
                return drop({ ...base, id: a.id, title: a.title, start: a.start, end: a.end, where: a.where, with: list(a.with), online: a.online,
                    notes: a.notes === undefined ? undefined : short(a.notes, 300), categories: Array.isArray(a.categories) ? a.categories : undefined });
            }
            if (act === 'respond') return drop({ ...base, id: a.id, answer: a.answer, comment: a.comment });
            if (act === 'attach') return drop({ ...base, id: a.id, files: filesOf(a), share: a.share === true || undefined });
            return drop({ ...base, id: a.id, which: a.which, name: a.name, to: a.to, color: a.color, who: list(a.who) });
        }
        case 'contacts': return drop({ kind: 'contacts', action: act, id: a.id, name: a.name, email: a.email, phone: a.phone, photo: a.attach ? true : undefined });
        case 'terminal': return drop({ kind: 'terminal', action: act, command: a.command, text: a.text });
        case 'files': return drop({ kind: 'files', action: act, path: a.path, from: a.from, to: a.to, bytes: a.text !== undefined ? Buffer.byteLength(String(a.text)) : undefined });
        case 'browser': return drop({ kind: 'browser', action: act, url: a.url, selector: a.selector, text: a.text, key: a.key });
        case 'voicebox': return drop({ kind: 'voicebox', action: act, level: a.level, text: a.text, version: a.version, kb: a.image ? kb(a.image) : undefined });
        case 'device': return drop({ kind: 'device', action: act, firmware: a.firmware, kb: a.image ? kb(a.image) : undefined, name: a.name, wifi: a.wifi === false ? false : undefined, pair: a.pair === true || undefined, app: a.app?.url, room: a.room ?? a.app?.room });
        case 'screen': return drop({ kind: 'screen', action: act, text: a.text, key: a.key });
        default: return { kind: 'other', action: String(verb) };
    }
}
