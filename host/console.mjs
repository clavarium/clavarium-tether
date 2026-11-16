/* ONE SHARED CONSOLE PER MACHINE: a single shell that a person (live, from their page) and the agents
 * given the machine look at together. The connector opens the shell (`open`); this keeps it, and says
 * who may see and type what.
 *
 *   THE PERSON streams it whole: every byte out, every key in. Their keys are never kept, never
 *   journaled, never shown to an agent except as the shell itself echoes them on screen.
 *   THEIR KEY ALWAYS WINS: a key of theirs while an agent is typing stops the agent at once -- the
 *   agent's partial line is erased (Ctrl-U), nothing of it is sent -- then their key goes.
 *
 *   AN AGENT (terminal.open / read / type) sees the screen from the moment it opened, as text, minus:
 *     - HIDDEN INPUT: a password prompt seen on screen ("[sudo] password for", "Password:",
 *       "passphrase", in a few languages) or the person's own "hidden input" switch: from then until
 *       the person presses Enter (or Ctrl-C), nothing of the screen reaches the agent; it reads
 *       "[hidden input]" in its place. An agent typing when the prompt comes is stopped, and may not
 *       type while it is up: the person types the secret, never the agent.
 *     - HIDDEN FROM THE AI: the person's switch; meanwhile terminal.read gives a notice, typing is
 *       refused, and what the screen shows is never added to what the agent reads later.
 *   An agent types character by character (`typeMs`), so the person sees it come and can take back
 *   control; one agent types at a time.
 *
 *   AN AGENT'S terminal.run (a command of its own, outside the shell) is SHOWN in the console as if
 *   typed, with its output (showRun), so the person sees every command.
 *
 * Secrets: what is shown while input is hidden is kept only in the person's replay (raw, in memory,
 * for a page that reconnects), never in the agent's screen, never journaled (the keeper journals the
 * agent's own inputs, and the console's events -- control taken back, input hidden -- without content).
 */
import { StringDecoder } from 'node:string_decoder';
import { Refused } from '../server/verbs.mjs';

export const SCREEN_MAX = 256 * 1024;
export const RAW_MAX = 256 * 1024;
export const HIDDEN_MARK = '[hidden input]';
export const HIDDEN_FROM_AI = 'The person hid this console from you for now: nothing of it is shown, and you cannot type in it. Wait, or ask them in the chat.';
const AI_HIDDEN_MARK = '[hidden from you by the person]';
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export const plain = (text) => String(text ?? '').replace(ANSI, '');

/* A password prompt at the end of the current line (ANSI already taken out). */
const PROMPTS = [
    /\[sudo\][^\n]*:\s*$/i,
    /(^|[\s'"(])(password|passwort|mot de passe|contraseña|senha|passphrase|pass phrase|pin)\b[^:\n]{0,60}:\s*$/i,
    /enter (the )?(passphrase|password|pin)[^\n]*$/i,
    /^\s*(new|retype|current)[^:\n]{0,30}password[^:\n]{0,30}:\s*$/i,
];
export function secretPrompt(lineTail) {
    const tail = String(lineTail ?? '').replace(/\r/g, '');
    return PROMPTS.some((re) => re.test(tail));
}

const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms).unref?.(); });

/* `open()` -> Promise<a shell stream>: write(text), on('data'), on('close'), setWindow?(rows, cols), end?()/close?().
   `typeMs`: the pause between an agent's characters; `settleMs`: how long after an agent's Enter a password
   prompt is waited for, to say so in its answer. */
export function sharedConsole({ open, title = 'the machine', typeMs = 12, settleMs = 400 } = {}) {
    let stream = null; let opening = null;
    let raw = '';                       /* the person's replay: the screen's last bytes, whole */
    let ai = ''; let aiBase = 0;        /* what agents read; aiBase: characters dropped from its start */
    let lineTail = '';                  /* the current line, plain, for a prompt */
    let hidden = null;                  /* null | 'prompt' | 'person' */
    let ending = false;                 /* Enter pressed while hidden: hidden until the line's end comes back */
    let hideAi = false;
    let typing = null;                  /* { agent, name, typed, cancelled } while an agent types */
    const agents = new Map();           /* agent id -> { name, from } */
    const persons = new Set();          /* { who, fn } */
    const hooks = { note: () => {}, hideAi: () => {} };
    let size = null;

    const emit = (event) => { for (const p of [...persons]) { try { p.fn(event); } catch { /* its page */ } } };
    const stateOf = () => ({
        open: Boolean(stream),
        typing: typing ? { agent: typing.agent, name: typing.name } : null,
        hidden, hideAi,
        agents: [...agents].map(([id, a]) => ({ id, name: a.name })),
        persons: persons.size,
    });
    const said = () => emit({ type: 'state', state: stateOf() });
    const toAi = (text) => {
        ai += text;
        if (ai.length > SCREEN_MAX) { const cut = ai.length - SCREEN_MAX; ai = ai.slice(cut); aiBase += cut; }
    };

    function take(text) {
        if (!text) return;
        raw = (raw + text).slice(-RAW_MAX);
        emit({ type: 'data', data: text });
        /* Enter was pressed on a hidden input: what comes back up to the end of that line (an echo of the
           secret, from a program that echoes) stays hidden; what follows is seen again. */
        let seen = text;
        if (hidden && ending) {
            const at = text.indexOf('\n');
            if (at < 0) seen = '';
            else { seen = text.slice(at + 1); endHidden(); }
        }
        if (!hidden && !hideAi && seen) toAi(seen);
        const lines = (lineTail + plain(text)).split('\n');
        lineTail = lines[lines.length - 1].slice(-300);
        if (!hidden && secretPrompt(lineTail)) startHidden('prompt');
    }

    async function ensure() {
        if (stream) return stream;
        if (!opening) {
            opening = (async () => {
                const s = await open();
                const decoder = new StringDecoder('utf8');
                const decoderErr = new StringDecoder('utf8');
                s.on('data', (b) => take(typeof b === 'string' ? b : decoder.write(b)));
                s.stderr?.on?.('data', (b) => take(typeof b === 'string' ? b : decoderErr.write(b)));
                s.on('close', () => { if (stream === s) { stream = null; if (typing) cancelTyping('closed'); emit({ type: 'closed' }); said(); } });
                stream = s;
                if (size) { try { s.setWindow?.(size.rows, size.cols, 0, 0); } catch { /* kept as it is */ } }
                said();
                return s;
            })().finally(() => { opening = null; });
        }
        return opening;
    }

    function cancelTyping(why) {
        if (!typing || typing.cancelled) return;
        typing.cancelled = why;
        /* Its partial line erased: nothing of it is sent. */
        if (typing.typed > 0 && stream) { try { stream.write('\x15'); } catch { /* closed */ } }
    }

    function startHidden(by) {
        if (hidden) return;
        hidden = by;
        if (!hideAi) toAi(` ${HIDDEN_MARK}\n`);
        if (typing) cancelTyping('hidden');
        hooks.note(by === 'prompt' ? 'input hidden: a password prompt' : 'input hidden by the person');
        said();
    }
    function endHidden() {
        if (!hidden) return;
        hidden = null; ending = false;
        said();
    }

    function personInput(data, who) {
        const text = String(data ?? '');
        if (!text) return;
        if (typing && !typing.cancelled) { cancelTyping('person'); hooks.note('control taken back from the AI', who); }
        if (!stream) return;
        try { stream.write(text); } catch { /* closed */ }
        if (hidden && /[\r\n\u0003\u0004]/.test(text)) ending = true;
    }

    function setHideAi(on, who) {
        if (hideAi === Boolean(on)) return;
        hideAi = Boolean(on);
        if (hideAi) { toAi(`\n${AI_HIDDEN_MARK}\n`); if (typing) cancelTyping('hidden-ai'); }
        hooks.note(hideAi ? 'hidden from the AI' : 'shown to the AI again', who);
        try { hooks.hideAi(hideAi, who); } catch { /* the keeper's */ }
        said();
    }

    function close() {
        const s = stream; stream = null;
        if (typing) cancelTyping('closed');
        if (s) { try { s.end?.(); } catch { /* gone */ } try { s.close?.(); } catch { /* gone */ } }
        emit({ type: 'closed' });
        said();
    }
    const idle = () => { if (!agents.size && !persons.size) close(); };

    return {
        hooks,
        state: stateOf,
        get alive() { return Boolean(stream); },
        /* ---- an agent ---- */
        async join(agent, name) {
            await ensure();
            agents.set(agent, { name: name || agent, from: aiBase + ai.length });
            said();
        },
        joined: (agent) => agents.has(agent),
        leave(agent) {
            if (!agents.has(agent)) return;
            agents.delete(agent);
            if (typing?.agent === agent) cancelTyping('stopped');
            said();
            idle();
        },
        read(agent, lines = 40) {
            if (!agents.has(agent)) throw new Refused(`no terminal open on ${title}: open one first`);
            if (hideAi) return HIDDEN_FROM_AI;
            const from = Math.max(0, agents.get(agent).from - aiBase);
            const n = Math.max(1, Math.min(2000, lines));
            const text = plain(ai.slice(from)).replace(/\r/g, '').replace(/\n+$/, '').split('\n').slice(-n).join('\n');
            return hidden ? `${text}\n(A password prompt is up: the person types it; you see ${HIDDEN_MARK}.)` : text;
        },
        async type(agent, text, enter) {
            if (!agents.has(agent)) throw new Refused(`no terminal open on ${title}: open one first`);
            if (hideAi) throw new Refused(HIDDEN_FROM_AI);
            if (hidden) throw new Refused(`a password prompt is up on ${title}: the person types it, never you -- nothing was typed`);
            if (typing) throw new Refused(`${typing.agent === agent ? 'you are' : 'another assistant is'} typing on ${title} already -- nothing was typed`);
            const s = await ensure();
            const me = { agent, name: agents.get(agent).name, typed: 0, cancelled: null };
            typing = me; said();
            try {
                for (const ch of String(text ?? '')) {
                    if (me.cancelled) break;
                    s.write(ch); me.typed++;
                    if (typeMs > 0) await sleep(typeMs);
                }
                if (!me.cancelled && enter) s.write('\r');
            } finally { if (typing === me) typing = null; said(); }
            if (me.cancelled === 'person') throw new Refused('the person took back control while you typed: your line was erased, nothing was sent');
            if (me.cancelled === 'hidden') throw new Refused('a password prompt came while you typed: control went back to the person, who types it -- the rest of your line was not typed');
            if (me.cancelled === 'hidden-ai') throw new Refused(HIDDEN_FROM_AI);
            if (me.cancelled) throw new Refused(`the terminal on ${title} closed while you typed`);
            if (enter && settleMs > 0) await sleep(settleMs);
            if (hidden === 'prompt') return `Typed. A password prompt came on ${title}: control went back to the person, who types it; you will see ${HIDDEN_MARK} in its place.`;
            return 'Typed.';
        },
        /* An agent's command run apart (terminal.run): shown here as if typed, with what it printed. */
        showRun(agent, command, output, exit) {
            if (!stream) return;
            const name = agents.get(agent)?.name ?? 'AI';
            const body = String(output ?? '').replace(/\r?\n/g, '\r\n');
            take(`\r\n\u001b[34m[${name}] $ ${String(command).replace(/[\u0000-\u001f\u007f]/g, ' ')}\u001b[0m\r\n${body}${body && !body.endsWith('\n') ? '\r\n' : ''}\u001b[2m[exit ${exit}]\u001b[0m\r\n`);
        },
        /* ---- the person ---- */
        async attach(who, fn) {
            const entry = { who, fn };
            persons.add(entry);
            try { await ensure(); } catch (e) { persons.delete(entry); throw e; }
            said();
            return {
                replay: raw,
                state: stateOf,
                write: (data) => personInput(data, who),
                resize(cols, rows) {
                    if (!(Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && cols <= 500 && rows <= 300)) return;
                    size = { cols, rows };
                    try { stream?.setWindow?.(rows, cols, 0, 0); } catch { /* closed */ }
                },
                hidden(on) { if (on) startHidden('person'); else endHidden(); },
                hideFromAi: (on) => setHideAi(on, who),
                takeBack() { if (typing && !typing.cancelled) { cancelTyping('person'); hooks.note('control taken back from the AI', who); said(); } },
                interrupt: () => personInput('\u0003', who),
                detach() { if (persons.delete(entry)) { said(); idle(); } },
            };
        },
        close,
    };
}
