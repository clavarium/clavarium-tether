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

Every acting verb takes `why` (`--why`): one line a person reads before
deciding. Declared, not done yet: `browser.tabs`, `open`, `shot`, `html`,
`console`, `eval`, `click`, `type`, `key`, `scroll`, `drag` (the keeper
answers "not available yet"; no MCP tool is offered for them).

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
