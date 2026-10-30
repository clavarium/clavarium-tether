/* WHAT A MESSAGE SAYS, written once. The agent writes a body in Markdown; it
 * leaves as two parts of one message: plain text (for any mail reader) and HTML
 * (for the ones that show formatting). Only a small, safe subset is read --
 * paragraphs, line breaks, headings, lists, quotes, code, bold, italic, links --
 * and every character the agent wrote is escaped first, so no HTML of its own
 * reaches the message. Also here: the subject of a reply or a forward, the quoted
 * original under it, and the mailbox's signature. No dependency. */
import { no } from '../server/verbs.mjs';

export const listOf = (v) => String(v ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"]+$/i;

/* Inline marks, on one piece of text with no code span in it. */
function inlineHtml(s) {
    let t = esc(s);
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => (SAFE_URL.test(url.replace(/&amp;/g, '&')) ? `<a href="${url}">${label}</a>` : m));
    t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"()]+[^\s<>"().,;:!?])/g, (m, pre, url) => `${pre}<a href="${url}">${url}</a>`);
    t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)([^_\n]+?)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
    return t;
}
function inlineText(s) {
    let t = String(s);
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => (label === url || label === url.replace(/^mailto:/i, '') ? label : `${label} (${url})`));
    t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '$1').replace(/__(?=\S)([^_\n]+?)__/g, '$1');
    t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?![*\w])/g, '$1$2').replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?![_\w])/g, '$1$2');
    return t;
}
/* Code spans are taken out first: nothing inside one is a mark. */
function inline(s, html) {
    return String(s).split(/(`[^`\n]+`)/).map((piece) => {
        if (/^`[^`\n]+`$/.test(piece)) return html ? `<code>${esc(piece.slice(1, -1))}</code>` : piece.slice(1, -1);
        return html ? inlineHtml(piece) : inlineText(piece);
    }).join('');
}

/* The blocks of a Markdown text: {kind, lines|items|level}. */
function blocks(md) {
    const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length;) {
        const l = lines[i];
        if (/^```/.test(l)) {
            const code = [];
            for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
            i++; out.push({ kind: 'code', lines: code }); continue;
        }
        if (!l.trim()) { i++; continue; }
        const h = /^(#{1,6})\s+(.*)$/.exec(l);
        if (h) { out.push({ kind: 'heading', level: h[1].length, lines: [h[2].replace(/\s+#+\s*$/, '')] }); i++; continue; }
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push({ kind: 'rule' }); i++; continue; }
        if (/^>\s?/.test(l)) {
            const q = [];
            for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
            out.push({ kind: 'quote', lines: q }); continue;
        }
        const bullet = /^\s{0,3}[-*+]\s+/; const number = /^\s{0,3}\d{1,9}[.)]\s+/;
        if (bullet.test(l) || number.test(l)) {
            const re = bullet.test(l) ? bullet : number;
            const items = [];
            for (; i < lines.length && lines[i].trim(); i++) {
                if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
                else if (items.length && /^\s+/.test(lines[i])) items[items.length - 1] += `\n${lines[i].trim()}`;
                else break;
            }
            out.push({ kind: re === bullet ? 'bullets' : 'numbers', items, start: Number(/\d+/.exec(l)?.[0] ?? 1) }); continue;
        }
        const para = [];
        for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i]) && !(para.length && (bullet.test(lines[i]) || number.test(lines[i]))); i++) para.push(lines[i]);
        if (!para.length) { para.push(l); i++; }
        out.push({ kind: 'para', lines: para });
    }
    return out;
}

/* Markdown to a small HTML document (inline styles only: mail readers drop <style>). */
export function markdownToHtml(md) {
    const body = blocks(md).map((b) => {
        switch (b.kind) {
            case 'code': return `<pre style="font-family:monospace;white-space:pre-wrap">${esc(b.lines.join('\n'))}</pre>`;
            case 'heading': return `<h${b.level}>${inline(b.lines[0], true)}</h${b.level}>`;
            case 'rule': return '<hr>';
            case 'quote': return `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${markdownToHtml(b.lines.join('\n'))}</blockquote>`;
            case 'bullets': return `<ul>${b.items.map((x) => `<li>${x.split('\n').map((p) => inline(p, true)).join('<br>')}</li>`).join('')}</ul>`;
            case 'numbers': return `<ol${b.start !== 1 ? ` start="${b.start}"` : ''}>${b.items.map((x) => `<li>${x.split('\n').map((p) => inline(p, true)).join('<br>')}</li>`).join('')}</ol>`;
            default: return `<p>${b.lines.map((p) => inline(p, true)).join('<br>\n')}</p>`;
        }
    }).join('\n');
    return body;
}

/* Markdown to plain text: the marks taken off, the shape kept (lists, quotes). */
export function markdownToText(md) {
    let n = 0;
    return blocks(md).map((b) => {
        switch (b.kind) {
            case 'code': return b.lines.join('\n');
            case 'heading': return inline(b.lines[0], false);
            case 'rule': return '----------';
            case 'quote': return markdownToText(b.lines.join('\n')).split('\n').map((x) => (x ? `> ${x}` : '>')).join('\n');
            case 'bullets': return b.items.map((x) => `- ${x.split('\n').map((p) => inline(p, false)).join('\n  ')}`).join('\n');
            case 'numbers': n = b.start; return b.items.map((x) => `${n++}. ${x.split('\n').map((p) => inline(p, false)).join('\n   ')}`).join('\n');
            default: return b.lines.map((p) => inline(p, false)).join('\n');
        }
    }).join('\n\n');
}

export const wrapHtml = (inner) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif">\n${inner}\n</body></html>`;

/* "Re: x" and "Fwd: x", never "Re: Re: x". */
export function replySubject(s) { const t = String(s ?? '').trim(); return /^(re|ré|aw|sv|antw)\s*:/i.test(t) ? t : `Re: ${t}`; }
export function forwardSubject(s) { const t = String(s ?? '').trim(); return /^(fwd?|tr|wg)\s*:/i.test(t) ? t : `Fwd: ${t}`; }

const WORDS = {
    en: { wrote: (when, who) => `On ${when}, ${who} wrote:`, fwd: '---------- Forwarded message ----------', from: 'From', date: 'Date', subject: 'Subject', to: 'To', cc: 'Cc' },
    fr: { wrote: (when, who) => `Le ${when}, ${who} a écrit :`, fwd: '---------- Message transféré ----------', from: 'De', date: 'Date', subject: 'Objet', to: 'À', cc: 'Cc' },
};
const words = (lang) => WORDS[lang] ?? WORDS.fr;

/* The original under a reply: "On ..., X wrote:" then its text, each line "> ". */
export function quoteReply(orig, lang) {
    const w = words(lang);
    const text = String(orig.text ?? '').replace(/\r\n?/g, '\n').trim();
    const head = w.wrote(orig.date || '', orig.from || '');
    return {
        text: `${head}\n${text.split('\n').map((x) => (x ? `> ${x}` : '>')).join('\n')}`,
        html: `<p>${esc(head)}</p>\n<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${esc(text).replace(/\n/g, '<br>\n')}</blockquote>`,
    };
}
/* The original under a forward: its headers, then its text, as it was. */
export function quoteForward(orig, lang) {
    const w = words(lang);
    const rows = [[w.from, orig.from], [w.date, orig.date], [w.subject, orig.subject], [w.to, orig.to], [w.cc, orig.cc]].filter(([, v]) => v);
    const text = String(orig.text ?? '').replace(/\r\n?/g, '\n').trim();
    return {
        text: `${w.fwd}\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${text}`,
        html: `<p>${esc(w.fwd)}<br>\n${rows.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>\n')}</p>\n<div>${esc(text).replace(/\n/g, '<br>\n')}</div>`,
    };
}

/* The parts of a message from what the agent wrote: `format` 'markdown' (the
 * default) gives text + HTML; 'text' keeps the body as written, text only. The
 * mailbox's signature (Markdown) follows unless `signature` is false; a quoted
 * original (reply or forward) comes last. */
export function compose({ body, format, signature, quote }) {
    const md = String(body ?? '');
    const sig = String(signature ?? '').trim();
    if (format === 'text') {
        const text = [md.trimEnd(), sig ? `-- \n${sig}` : '', quote?.text ?? ''].filter(Boolean).join('\n\n');
        return { text };
    }
    const text = [markdownToText(md), sig ? `-- \n${markdownToText(sig)}` : '', quote?.text ?? ''].filter(Boolean).join('\n\n');
    const html = wrapHtml([markdownToHtml(md), sig ? `<div>-- <br>\n${markdownToHtml(sig)}</div>` : '', quote?.html ?? ''].filter(Boolean).join('\n'));
    return { text, html };
}

/* Which of the original's files a forward keeps: "all" (the default), "none", or
   some of them by name or 1-based number, comma-separated. A name that matches
   none is refused: never a file dropped in silence. */
export function keptFiles(files, keep) {
    const k = String(keep ?? 'all').trim().toLowerCase();
    if (!k || k === 'all' || k === 'true' || k === 'yes') return files;
    if (k === 'none' || k === 'false' || k === 'no') return [];
    const picked = new Set();
    for (const w of listOf(keep)) {
        const n = /^\d+$/.test(w) ? Number(w) - 1 : files.findIndex((f) => f.name.toLowerCase().includes(w.toLowerCase()));
        if (!files[n]) no(`no attachment "${w}" in the original — it has: ${files.map((f) => f.name).join(', ') || 'none'}`);
        picked.add(n);
    }
    return files.filter((_, i) => picked.has(i));
}


/* When a scheduled message leaves: an ISO date-time; without an offset it is the
   person's own wall-clock (Europe/Paris). Refused in the past or over a year away. */
export const TZ = 'Europe/Paris';
export function sendAt(v, now = Date.now()) {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim();
    let d;
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) d = new Date(s);
    else {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
        if (!m) no('at must be a date-time like 2026-11-02T08:30');
        const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
        /* The zone's offset at that moment, found by reading the guess back. */
        const offsetAt = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t; };
        let t = wall - offsetAt(wall); t = wall - offsetAt(t);
        d = new Date(t);
    }
    if (Number.isNaN(d.getTime())) no('at must be a date-time like 2026-11-02T08:30');
    if (d.getTime() < now - 60_000) no('at is in the past -- give a time to come');
    if (d.getTime() > now + 366 * 86_400_000) no('at is more than a year away');
    return d;
}
/* A moment as the person reads it: "2 Nov 2026, 08:30" in their zone. */
export const wallClock = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
