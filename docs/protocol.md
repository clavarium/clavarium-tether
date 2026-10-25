# The protocol

Tether is four small things: a command and an MCP server for agents, a keeper
that holds the targets and their secrets, and a screen for people.

## Words

- **Target**: one access given to an agent. Its kind: `computer` (a machine,
  through a small program installed there), `ssh` (a machine the keeper reaches
  by SSH), `browser` (tabs given by an extension), `files` (an online folder).
- **Connector**: the code that reaches one kind of target. V1 has `local`
  only: the keeper's own machine, for tests and `tether serve`.
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
