# Clavarium Tether

An AI agent reaches outside its own machine, kept on a tether: a level per
target, a person's approval, a journal, and a stop.

A target is one access given to an agent: a computer, a machine reached by
SSH, browser tabs, an online folder. On each, the agent has a level:

| Level | The agent... |
|---|---|
| Watch | reads only |
| Propose | reads; each action waits for a person |
| Frame | reads, acts where a rule allows (`git status`, under `~/Projects`); the rest waits |
| Free | does everything; the journal says it all |

    tether                                 your targets, your level on each
    tether run web "sudo apt upgrade -y" --why "Installs 14 updates."
    tether files web read ~/site/index.html
    tether open web; tether type web "top" --enter; tether read web

A call that waits shows the person the exact command and the agent's one
line why: **Accept**, **Refuse**, or **Always** (a rule from the command,
and it is not asked again). Not answered in time, it is refused.

An MCP server gives the same verbs to an AI agent. A person sees the
requests, the levels and the journal on its screen (`ui/`), drawn by Tether
in the page of the application that runs it.

A sibling of [Clavarium Parley](https://github.com/clavarium/clavarium-parley),
[Clavarium Docket](https://github.com/clavarium/clavarium-docket) and
[Clavarium Binder](https://github.com/clavarium/clavarium-binder), built the
same way, universal (nothing in it is specific to Clavarium).

## What an agent cannot do

- **Hold a key.** Passwords and keys stay with the keeper (the application,
  or `tether serve`), from the application's secret store. The agent asks
  through its own folder; it never connects, and never sees a secret.
- **Approve.** Only a person does, on the screen or wherever the
  application asks them.
- **Hide.** Each call is a line of the journal: who, where, what exactly,
  the decision and by whom, when, the size of the result and its exit code.
  Never a secret, never a file's content.
- **Go on after Stop.** One button cuts every target of an agent: what
  waits is refused, terminals are closed, every call after is refused until
  a person resumes.

## Without an application

    tether serve --store ~/tether-data --side ./.tether=Assistant --local ~/Projects

keeps the targets and shows their page on `http://127.0.0.1:4190/`.
`--local FOLDER` gives the agents this machine (a shell, and that folder),
at level Propose; it is off unless asked for. Put the store where the agents
cannot write.

See [docs/protocol.md](docs/protocol.md). No dependency; Node 22 or later;
tmux for the local connector's terminals.

**Status:** first version (0.1), not yet published. The `local` connector
only: `computer`, `ssh`, `browser` and online folders come next.

License: MIT.
