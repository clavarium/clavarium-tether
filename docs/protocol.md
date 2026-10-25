# The protocol

Tether is four small things: a command and an MCP server for agents, a keeper
that holds the targets and their secrets, and a screen for people.

## Words

- **Target**: one access given to an agent. Its kind: `computer` (a machine,
  through a small program installed there), `ssh` (a machine the keeper reaches
  by SSH), `browser` (tabs given by an extension), `files` (an online folder).
- **Connector**: the code that reaches one kind of target. Three are built:
  `local` (the keeper's own machine, for tests and `tether serve`), `ssh`
  (a machine the keeper reaches as an ordinary SSH client — see below) and
  `browser` (tabs a person grants through the Tether extension — see below).
- **Level**: what an agent may do on a target without asking.

## Rights

| Level | Without asking | Otherwise |
|---|---|---|
| `watch` | read verbs only | everything else refused |
| `propose` | read verbs | each acting verb is asked of a person |
| `frame` | read verbs, and acting verbs an allow rule covers | the rest is asked |
| `free` | everything | (journal only) |

Read verbs: `terminal.read`, `files.list`, `files.read`, `files.search`,
`browser.tabs`, `browser.shot`, `browser.html`, `browser.console`.

An **allow rule** is `{kind, value}`:

| Kind | Covers |
|---|---|
| `command` | `terminal.run` of a command whose first words are these |
| `path` | `files.write`, `files.move` (both ends), `files.delete` at or under this path |
| `verb` | one verb (`terminal.open`) |
| `site` | `browser.open` of this host or one under it |

A command holding shell control (`; & | $ \` < > ( ) { }` or a backslash) is
never covered by a rule. Paths are `~/...` from the target's folder, or
`/...`; `..` is resolved, and a path that climbs above its start is refused.

## An approval

A call that needs a person becomes a request, held by the keeper:

    { id, agent: {id, name}, target: {id, title}, verb, detail, why, level, rule?, at, until }

`detail` is the exact thing done (the command, the path; a file's size, never
its content). `rule` is what **Always** would add, when one fits (none for
typing in a terminal). The request ends once, with the first of:

| Decision | What happens |
|---|---|
| `yes` | the call runs |
| `always` | the rule is added, the call runs; a target at `propose` moves to `frame` (rules count from there) |
| `no` | refused; the agent reads "refused by NAME" and the person's word if any |
| `timeout` | nobody answered before `until` (the host's limit, 10 minutes by default) |
| `stopped` | a person stopped that agent, or everybody |

## Stop

One call cuts every target of an agent, or of everybody (`*`): requests
waiting end as `stopped`, the connector closes that agent's terminals and
running commands, and every call after (reads included) is refused until a
person resumes.

## The store: the keeper's alone

| File | What it holds |
|---|---|
| `state.json` | targets, who was given each at which level with which rules, who is stopped; rewritten whole (by a rename) |
| `journal.jsonl` | one line per call and per change of rights, appended, never rewritten |

A target holds no secret: its `config` is what is not secret; a secret is
named in `secrets` (`{password: "name"}`) and asked of the host when a
connector needs it. A config key that looks like a secret is refused.

A journal line: `{at, op?, agent, target, verb, detail, why, decision,
because?, by?, word?, ok, error?, size?, exit?, ms?, rule?, level?}`.
`decision` is `auto` (with `because`: `read`, `rule` or `free`), `yes`,
`always`, `no`, `timeout`, `stopped`, or `refused` (the level). `op` is
`level`, `allow`, `unallow`, `stop` or `resume` for a person's change. Only
these fields are written, so no output, content or config ever reaches it,
and every secret the keeper handed out is replaced by `[secret]`.

## An agent's folder

| File | Written by | What it holds |
|---|---|---|
| `asks.jsonl` | the agent | `{id, at, op, args}`, one per call |
| `answers.jsonl` | the keeper | `{ask, at, held: true, until, request}` while a person decides, then `{ask, at, ok, text, data?}` |

The folder is `--dir`, else `$TETHER_DIR`, else the nearest `.tether` from
where the command stands. The keeper knows who asks by the folder. An ask
waits 20 seconds for the keeper to take it; once held, until `until` and 30
seconds more. An ask older than a minute when the keeper first sees it is
answered "too late" and never done; one held by a keeper that restarted is
answered "not answered" and never done.

Exit codes of the command: 0 done, 1 refused, 2 no folder, 3 nobody keeps the
targets, 4 not answered in time, 64 not understood.

## The verbs

| Command | MCP tool | Verb |
|---|---|---|
| `tether` / `tether targets` | `targets` | `targets` |
| `tether open TARGET` | `terminal-open` | `terminal.open` |
| `tether read TARGET [--lines N]` | `terminal-read` | `terminal.read` |
| `tether type TARGET "keys" [--enter]` | `terminal-type` | `terminal.type` |
| `tether run TARGET "cmd" [--timeout S]` | `terminal-run` | `terminal.run` |
| `tether files TARGET list [PATH]` | `files-list` | `files.list` |
| `tether files TARGET read PATH` | `files-read` | `files.read` |
| `tether files TARGET search "text" [--in PATH]` | `files-search` | `files.search` |
| `tether files TARGET write PATH --text T \| --from FILE` | `files-write` | `files.write` |
| `tether files TARGET move FROM TO` | `files-move` | `files.move` |
| `tether files TARGET delete PATH` | `files-delete` | `files.delete` |

And the browser (a `browser` target, through the extension — see "Reach a
browser"):

| Command | MCP tool | Verb |
|---|---|---|
| `tether browser TARGET tabs` | `browser-tabs` | `browser.tabs` |
| `tether browser TARGET open URL [--tab N]` | `browser-open` | `browser.open` |
| `tether browser TARGET shot [--tab N]` | `browser-shot` | `browser.shot` |
| `tether browser TARGET html [--tab N] [--selector S] [--readable]` | `browser-html` | `browser.html` |
| `tether browser TARGET console [--tab N] [--lines N]` | `browser-console` | `browser.console` |
| `tether browser TARGET eval "script" [--tab N]` | `browser-eval` | `browser.eval` |
| `tether browser TARGET click [SELECTOR \| --x N --y N] [--tab N]` | `browser-click` | `browser.click` |
| `tether browser TARGET type "text" [--selector S] [--tab N]` | `browser-type` | `browser.type` |
| `tether browser TARGET key KEY [--selector S] [--tab N]` | `browser-key` | `browser.key` |
| `tether browser TARGET scroll [--dx N] [--dy N] [--selector S] [--tab N]` | `browser-scroll` | `browser.scroll` |
| `tether browser TARGET drag FROM TO [--tab N]` | `browser-drag` | `browser.drag` |

Every acting verb takes `why` (`--why`): one line a person reads before
deciding. `--tab` picks which granted tab to act on (its id from
`browser tabs`); with none, the agent's active granted tab. A verb on a tab the
person did not grant is refused.

## Reach a server over SSH

A target of kind `ssh` is a machine that already runs an SSH server. The keeper
connects to it as an ordinary SSH client (through the `ssh2` library, pure JS —
no system `ssh`, nothing installed on the far machine). It serves the same
`terminal.*` and `files.*` verbs as `local`: commands and an interactive shell
over SSH channels, files over SFTP.

The target's `config` holds `host`, `port` (22 by default), `user`, an optional
`pin` (the server's host key, to check its identity) and an optional `root` (a
remote folder `files.*` may not leave). The private key is **named** in
`secrets` — `{key: "name"}`, and `{passphrase: "name"}` if it is encrypted —
never written in the target. At connect time the keeper fetches the key from the
host's secret store, hands it straight to `ssh2`, and keeps it in the one
connection it holds per target (reused across calls, reopened if it drops). The
key is never returned to the agent, never journalled, never logged; the keeper
masks any secret it handed out, as the local connector's environment does.

`pin` checks the server is the one expected: an `SHA256:…` fingerprint, a
known-hosts line, or the base64 host key. A server whose key does not match is
refused before anything runs. With no `pin`, the server's identity is not
checked. With a `root`, every `files.*` path resolves inside it (symlinks that
point out are refused, as with `local`); `~` is that folder. With no `root`,
paths resolve from the login home on the far machine.

The `ssh` connector is wired into the keeper by default (it holds nothing until
a target asks it to connect, and loads `ssh2` lazily); a host that does not want
it passes `connectors: { ssh: null }`.

## Reach a browser

A target of kind `browser` is a set of tabs a person grants to an agent through
the **Tether extension** (Chrome and Firefox, one codebase built with WXT;
`extension/`). The keeper does not reach out — the extension connects OUT to the
keeper over a WebSocket, so nothing is installed as a server, no port is opened
for the browser to find, and the browser may sit behind any firewall. V1 uses no
`chrome.debugger`: the verbs use `scripting.executeScript` in the page's own
world, `tabs.captureVisibleTab` and synthetic DOM events only.

**The endpoint.** The keeper serves the WebSocket at `/browser` on its own
server (`tether serve --browser`, or a host wiring the connector into its serve
server). Browsers refuse port 4190 (`ERR_UNSAFE_PORT`), so for browser use the
keeper runs on a browser-safe port: `tether serve --browser --port 8787`, which
the extension defaults to (`ws://127.0.0.1:8787/browser`; `wss://` in real use,
`ws://` only for 127.0.0.1). The person may change the URL in the popup.

**Pairing.** An extension with no token connects and sends `{t:"pair", code}`
showing a short code in its popup. A person reads that code and types it in the
keeper page (the `pair {code}` op); the keeper mints a long-lived token, hands it
back as `{t:"paired", token}`, and the extension keeps it in extension storage.
On every later connection the extension sends `{t:"hello", token}` and is
welcomed. The token is never logged, never journalled, and never reaches an
agent; it lives only in the connector's token store and the extension's storage.

**The messages** (JSON, each way):

| From | Message | Meaning |
|---|---|---|
| extension | `{t:"hello", token?}` | on connect; with a token, authenticate |
| extension | `{t:"pair", code}` | offer the code shown in the popup |
| keeper | `{t:"pair-needed"}` / `{t:"welcome"}` / `{t:"paired", token}` | pairing state |
| extension | `{t:"tabs", tabs:[{id,url,title,site}]}` | the granted tabs (only those), pushed on change |
| keeper | `{t:"call", id, verb, args}` | run one browser verb (`verb` without the `browser.` prefix) |
| extension | `{t:"result", id, ok, text, size}` / `{ok:false, error}` | its answer |
| either | `{t:"ping"}` / `{t:"pong"}` | heartbeat (every ~20 s); a missed pong reconnects |

**Tab scoping.** A person grants a tab in the popup (per tab on/off) or allows a
whole site. The extension pushes only the granted tabs; the connector keeps that
set and **refuses a verb that names a non-granted tab before sending it** — the
same refusal the extension makes on its side, as a second lock. `browser.open`
with no tab opens a new tab, which the extension grants as it opens it.
`browser.tabs` is answered by the keeper from the pushed list without a round
trip. `browser.shot` returns a `data:image/png;base64,…` URL.

**Rights and the indicator.** The level (watch / propose / frame / free) and a
person's approval are applied by the keeper BEFORE it calls the connector,
exactly as for ssh and local. The **default per-site level is Propose**: every
action is asked, with sites allowed one by one. While the agent acts in a tab the
extension shows a **visible indicator** — a badge on the toolbar icon and a red
border around the page — so the person always sees when a tab is being driven.

**Wiring.** `host/connectors/browser.mjs` exports `browser({ tokens? })`; the
connector is an ordinary connector (`run(verb, target, args, ctx)`) plus
`accept(channel)` (hand it a socket wrapped as `{send, onMessage, onClose,
close}`), `pair(code)`, `status()` and `onChange(fn)`. `tether serve --browser`
wires it in, upgrades `/browser` to a WebSocket (`host/ws.mjs`, a tiny RFC 6455
server, no dependency) and adds the `pair` page op. A host does the same in its
own serve server and pairing UI.

## The application's side

    import { keeper } from 'clavarium-tether/host';
    const k = keeper(storeDir, {
        sides: () => [{ dir, who }],              // each agent's folder, and who it is
        ask: (request) => Promise<decision>,      // show it (a card, a notification); optional
        secrets: (name) => Promise<string>,       // from the host's secret store
        connectors: { name: connector },          // `local: true` adds the local one
        timeout: 10 * 60_000,
    });
    setInterval(() => k.pump(), 500);           // take what the agents asked
    k.approvals(agent?);                        // the requests waiting
    k.decide(id, 'yes' | 'no' | 'always', by, word);
    k.stop(agent?, by); k.resume(agent?, by);
    k.journal({ agent, target, since, limit });
    k.act(op, args, person);                    // the page's ops, below: Promise<{ ok, text, data }>
    k.onChange(fn);                             // something the page shows changed
    k.close();                                  // connectors down

`ask` may resolve to `"yes"`, `"no"`, `"always"` or `{decision, by, word}`;
the page deciding (`decide`) ends the same request, whichever comes first.

A person's ops through `act`: `state {agent?, limit?}` (all a page needs at
once), `agents`, `targets`, `approvals`, `journal`, `stops`, `decide {id,
decision, word?}`, `level {target, agent, level|null}`, `allow` and `unallow
{target, agent, rule}`, `stop {agent?}`, `resume {agent?}`, `put-target`,
`remove-target`.

A connector: `{ run(verb, target, args, ctx) → Promise<{text, size, exit?}>,
close(agent) }`; `ctx.secret(key)` gives the value of the secret the target
names `key`, from the host. A `Refused` thrown is told to the agent as is.

And the screen: `mount(element, { call, words, lang, agent })` from
`clavarium-tether/ui`, with `ui/ui.css` and `ui/texts/*.json`. `agent` shows
one agent (a page per conversation); without it, a choice of all. It gives
back `refresh()` and `destroy()`.

## Plug in a screen engine

A `screen` target lets an agent see a machine's screen and move its mouse and
keyboard. Tether settles the verbs and their rights, but writes no engine for
them: a host plugs one in. Without one, a `screen` target says its connector is
off, like any kind with no connector.

The engine is an ordinary connector under the name `screen`:

    keeper(storeDir, { connectors: { screen: myEngine }, /* ... */ });

It answers these verbs (rights, approval, journal and stop already wrap every
call, so the engine only does the work):

| verb | args | does |
|---|---|---|
| `screen.shot` | — | returns the screen; `{ text, size }` — `text` a `data:` image URL, or a note with it saved |
| `screen.move` | `x`, `y` | moves the pointer |
| `screen.click` | `x?`, `y?`, `button?` | clicks |
| `screen.drag` | `from`, `to` | drags (points like `"12,40"`) |
| `screen.scroll` | `dx?`, `dy?` | scrolls |
| `screen.type` | `text` | types text |
| `screen.key` | `key` | a key or chord (`"Enter"`, `"ctrl+c"`) |

`screen.shot` reads; the rest act and are proposed for approval (and a person's
"Always" allows that whole verb on the target). The engine reaches the machine
however it likes; the simple, firewall-friendly way is **RFB (VNC) over a
WebSocket**: put `websockify`/noVNC in front of a standard VNC server
(TigerVNC, x11vnc, wayvnc), or use a VNC server with native WebSocket
(KasmVNC), and have the engine speak RFB to it. The password or key stays a
Tether secret the target names (`ctx.secret('password')`); it never reaches the
agent. A `Refused` thrown is told to the agent as is.

    const myEngine = {
        async run(verb, target, args, ctx) {
            // connect once to target.config.url (e.g. a ws:// of websockify),
            // using await ctx.secret('password'); then:
            //   screen.shot  -> { text: `data:image/png;base64,...`, size }
            //   screen.move/click/drag/scroll/type/key -> do it, { text: 'Done.', size: 0 }
        },
        close(agent) { /* drop that agent's connection */ },
    };

Nothing else changes: the target is given to a conversation, its level set, its
calls approved and journalled, and Stop cuts it, like every other target.
