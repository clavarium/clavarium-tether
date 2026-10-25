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

## Reach a server over SSH

A target of kind `ssh` is a machine that already runs an SSH server. The
keeper connects to it as an ordinary SSH client — like ansible or a deploy
job — through the `ssh2` library (pure JS; no system `ssh`, and **nothing is
installed on the far machine**). The agent gets the same verbs as on any
other target: `tether run`, `tether read`, `tether files …`, each through its
level and a person's approval.

The target says `host`, `port`, `user`, optionally a host-key `pin` to check
the server's identity and a `root` folder that files may not leave. The
private key is held by the keeper, from the application's secret store, and
named in the target — never the key itself; it never reaches the agent, the
journal or any log.

    tether serve --side ./.tether=Assistant \
      --ssh deploy@example.com --ssh-key ~/.ssh/deploy_ed25519 \
      --ssh-root /srv/app --ssh-pin SHA256:… --ssh-title "App server"

declares one SSH target without an application. `--ssh-key FILE` reads the key
from that file (its content is the secret; the path is not stored); the target
starts at level Propose. A host-key `--ssh-pin` refuses a server whose key does
not match.

## Reach an online folder

A target of kind `files` is an online folder on a server the person runs or
owns. The keeper talks to it as an ordinary file-sync client over HTTPS (no
extra dependency — Node's own `fetch`); **nothing is installed anywhere**, and
the agent never connects. The agent gets the `files.*` verbs — `tether files …
list / read / search / write / move / delete` — each through its level and a
person's approval. Two kinds of server are reached:

**Nextcloud (and any WebDAV).** The target says the WebDAV `url`, a Basic-auth
`user`, and optionally a `root` folder files may not leave. The password — a
Nextcloud **app password** is ideal — is held by the keeper, from the
application's secret store, and only named in the target.

    tether serve --side ./.tether=Assistant \
      --webdav https://cloud.example.com/remote.php/dav/files/alice \
      --webdav-user alice --webdav-pass-env NEXTCLOUD_APP_PASSWORD \
      --webdav-root /Projects --webdav-title "Cloud"

**SharePoint / OneDrive (Microsoft Graph).** The target says the `drive` id and
optionally a `root`. V1 takes a bearer token the host keeps fresh (named in the
target, read here from an environment variable); a client-credentials flow with
a client secret is also supported (see the protocol). Large-file upload sessions
are left for a later version.

    tether serve --side ./.tether=Assistant \
      --graph-drive <drive-id> --graph-token-env GRAPH_TOKEN \
      --graph-root /Shared --graph-title "Team drive"

`--webdav-pass-env` and `--graph-token-env` name an environment variable; the
secret is never passed on the command line, written to the store or journalled.
Both targets start at level Propose.

## Without an application

    tether serve --store ~/tether-data --side ./.tether=Assistant --local ~/Projects

keeps the targets and shows their page on `http://127.0.0.1:4190/`.
`--local FOLDER` gives the agents this machine (a shell, and that folder),
at level Propose; it is off unless asked for. Put the store where the agents
cannot write.

See [docs/protocol.md](docs/protocol.md). One dependency, `ssh2` (the SSH
connector); Node 22 or later; tmux for the local connector's terminals.

**Status:** first version (0.1), not yet published. The `local`, `ssh`,
`webdav` (Nextcloud/WebDAV) and `graph` (SharePoint/OneDrive) connectors are
built. A `screen` slot is ready for a host to plug an engine into (see docs).
The `computer` and `browser` connectors come next.

License: MIT.
