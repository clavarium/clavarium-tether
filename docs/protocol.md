# The protocol

Tether is four small things: a command and an MCP server for agents, a keeper
that holds the targets and their secrets, and a screen for people.

## Words

- **Target**: one access given to an agent. Its kind: `computer` (a machine,
  through a small program installed there), `ssh` (a machine the keeper reaches
  by SSH), `browser` (tabs given by an extension), `files` (an online folder).
- **Connector**: the code that reaches one kind of target. Four are built:
  `local` (the keeper's own machine, for tests and `tether serve`), `ssh`
  (a machine the keeper reaches as an ordinary SSH client), and two online-folder
  connectors of kind `files` — `webdav` (Nextcloud and any WebDAV server) and
  `graph` (SharePoint/OneDrive through Microsoft Graph) — all below.
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

## Reach an online folder (WebDAV and Microsoft Graph)

A target of kind `files` is an online folder on a server the person already
runs or owns. The keeper is an ordinary file-sync client over HTTPS (through
Node's own `fetch`; no extra dependency) — nothing is installed anywhere, and
the agent never connects. Two connectors serve the `files.*` verbs:
`files.list`, `files.read`, `files.search`, `files.write`, `files.move`,
`files.delete`, with the same output and read caps as `local`/`ssh`, and the
same path rules — `~/...` from the target's root, `..` resolved, a path that
leaves the root refused.

### `webdav` — Nextcloud and any WebDAV server

The target's `config` holds `url` (the WebDAV collection this target is anchored
at, e.g. `https://cloud.example.com/remote.php/dav/files/alice`), an optional
`user` for Basic auth, and an optional `root` (a sub-folder `files.*` may not
leave; `/` by default, which is the collection itself). The password is **named**
in `secrets` — `{password: "name"}` — never written in the target; it is a
Nextcloud **app password** (app token) or any Basic-auth password.

| Verb | HTTP |
|---|---|
| `files.list` | `PROPFIND` depth 1 |
| `files.read` | `GET` (over the read cap → refused) |
| `files.search` | a bounded walk of `PROPFIND`s, matching names (not content) |
| `files.write` | `MKCOL` for missing parent collections, then `PUT` |
| `files.move` | `MOVE` with `Overwrite: F` (a name already taken → refused) |
| `files.delete` | `DELETE` (a non-empty folder → refused, as `local`/`ssh`) |

### `graph` — SharePoint and OneDrive

The target's `config` holds `drive` (the drive id of a OneDrive or a SharePoint
document library — resolving a site name to a drive id is the host's job), an
optional `root`, and an optional `api` (the Graph base,
`https://graph.microsoft.com/v1.0` by default). The verbs run against the
drive's `/drives/{id}/root:/path` endpoints: list children, `GET …/content`,
`PUT …/content` (creating missing parent folders first), `PATCH` the
`parentReference` to move, `DELETE`, and `…/search(q=…)` for search.

**The token.** V1 takes a **bearer token the host keeps fresh**: the keeper
fetches it per call through `ctx.secret("token")` and the host refreshes it
(Graph tokens last about an hour; Tether never sees the refresh). As an
alternative, a target that names a client `secret` and sets `tenant`/`clientId`
in `config` has the connector run the OAuth 2.0 **client-credentials** flow
itself and cache the token until it is about to expire. Either way the secret
is named in `secrets` (`{token: "name"}` or `{secret: "name"}`), never written
in the target, and never reaches the agent, the journal or any log.

**What V1 does.** Simple uploads up to 4 MB (and `files.write` is already capped
at 1 MB of text by the verb layer). **What it leaves for later:** large-file
upload sessions, and delta/change tracking. A folder's whole contents are not
deleted by surprise — a non-empty folder is refused, as on the other kinds.

Both connectors are stateless (`webdav` holds nothing; `graph` caches only a
token it fetched) and are wired into the keeper by default; a host that does not
want one passes `connectors: { webdav: null }` or `{ graph: null }`.
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

Tether ships the **envelope** — the `screen` connector — and the host supplies
the **engine** it wraps. The envelope (`host/connectors/screen.mjs`) does the
Tether-side work: one session per target and agent, the target's URL and secret,
the verb mapping, the key map, finite coordinates, a per-session rate limit, and
keeping the token out of every answer. The engine does the capture and the
injection; Tether writes none of it, and never imports one.

    import { screen } from 'clavarium-tether/host/connectors/screen.mjs';
    keeper(storeDir, { connectors: { screen: screen({ engine: createScreen }) }, /* ... */ });

`engine` is a **factory**: calling it returns one session. The envelope expects
the shape

    createScreen() -> {
      connect({ url, token, user?, key?, node?, signal? }),
      shot() -> { dataUrl, width, height },
      move(x, y), click(x, y, button?), drag(from, to), scroll(dx, dy),
      type(text), key(vk, code?), keyDown(vk), keyUp(vk), close()
    }

Pass no engine (`screen({})`) and the target stays visible but every call says
the connector has no engine, like any kind with no connector.

The envelope answers these verbs (rights, approval, journal and stop already
wrap every call):

| verb | args | engine call |
|---|---|---|
| `screen.shot` | — | `shot()`; returns `{ text: dataUrl, size }` |
| `screen.move` | `x`, `y` | `move(x, y)` |
| `screen.click` | `x?`, `y?`, `button?` | `click(x, y, button)`; no coords → the last pointer; button `left`/`middle`/`right` (or `0`/`1`/`2`) |
| `screen.drag` | `from`, `to` | `drag(from, to)`; points like `"12,40"` |
| `screen.scroll` | `dx?`, `dy?` | `scroll(dx, dy)` |
| `screen.type` | `text` | `type(text)` |
| `screen.key` | `key` | a key or chord (see below) |

`screen.shot` reads; the rest act and are proposed for approval (and a person's
"Always" allows that whole verb on the target). The acting verbs are rate-limited
per session (≤ 30 a second), so a run-away agent cannot flood the far machine.

**The key map.** `screen.key` takes a key name or a chord and maps it to Windows
virtual-key codes. The envelope knows a modest table — `Enter`, `Escape`, `Tab`,
`Backspace`, `Delete`, the arrows (`Left`/`ArrowLeft` …), `Home`/`End`/`PageUp`/
`PageDown`/`Insert`, `Space`, the function keys `F1`–`F12`, and the modifiers
`Ctrl`, `Alt`, `Shift`, `Win` — and a single letter or digit maps to its own code.
A chord like `"ctrl+c"` holds its modifiers down with `keyDown`, strikes the main
key with `key`, then releases them with `keyUp`, in order. An unknown key name is
refused rather than guessed.

**The secret.** The URL is `target.config.url` (never from the agent's args); the
login secret is a Tether secret the target names — `ctx.secret('token')` (and/or
`ctx.secret('key')`), with an optional `config.user` and `config.node`. It is
handed straight to the engine's `connect`, kept in the session, and never
returned, journalled or logged; the keeper masks it a second time. A `Refused`
the engine throws is told to the agent as is.

The engine reaches the machine however it likes. One worked example is
MeshCentral's KVM over a WebSocket (the reference engine an operator wrote);
another firewall-friendly way is **RFB (VNC) over a WebSocket** — `websockify`/
noVNC in front of a standard VNC server (TigerVNC, x11vnc, wayvnc), or a VNC
server with native WebSocket (KasmVNC).

With `serve`, `--screen URL` declares one screen target. Its login token is read
from an environment variable named by `--screen-token-env`, never the command
line, and `--screen-engine MODULE` points at a module that exports the engine
factory (`createScreen`, or a default export). Without that module the target is
declared but its connector stays off until a host plugs an engine in.

Nothing else changes: the target is given to a conversation, its level set, its
calls approved and journalled, and Stop cuts it, like every other target.
