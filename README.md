<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.png">
    <img src="docs/assets/logo-light.png" alt="Actana Control" width="380">
  </picture>
</p>

<p align="center">
  <a href="docs/README.md">Docs</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="https://github.com/actana/control/releases">Releases</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/actana/control?style=flat-square&labelColor=101723&color=279ed6&cacheSeconds=3600"></a>
  <a href="https://github.com/actana/control/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/actana/control?style=flat-square&labelColor=101723&color=279ed6&cacheSeconds=3600"></a>
  <a href="https://github.com/actana/control/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/actana/control/ci.yml?branch=main&style=flat-square&labelColor=101723&color=279ed6&cacheSeconds=3600"></a>
  <a href="https://github.com/actana/control/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/actana/control?style=flat-square&labelColor=101723&color=279ed6&cacheSeconds=3600"></a>
  <a href="https://hub.docker.com/r/actana/panel"><img alt="Docker pulls" src="https://img.shields.io/docker/pulls/actana/panel?style=flat-square&labelColor=101723&color=279ed6&cacheSeconds=3600"></a>
</p>

Actana Control is a self-hosted control plane for agentic coding. One web
**Panel** drives any number of **Cores** — machines running vendor coding CLIs
(Claude Code, Codex, Cursor CLI, OpenCode) in PTY sessions against your git
repos.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-fleet-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/panel-fleet-light.png">
    <img src="docs/assets/panel-fleet-light.png" alt="The Actana Control Panel showing the Fleet view — every Core's sessions in one list" width="900">
  </picture>
</p>

<!-- Demo recording goes here once it exists. Deliberately empty until then. -->

## Quickstart

**Docker Compose** — a Panel and a Core on one network, which is the whole
product in one command:

```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs core   # the registration blob
```

Open `http://localhost:7420`, create the Operator, and paste that blob into
"Add Core".

**Installer** — turn a Linux or macOS (arm64) machine into a Core, as your own
user, without sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
```

**Which one?** Compose if you want the whole thing on one host to try it;
the installer if you want a Core on a machine that already has your code — your
laptop, a workstation, a build box — paired to a Panel you deploy separately.

Full paths: [DEPLOY.md](DEPLOY.md) for the Panel, [INSTALL.md](INSTALL.md) for a Core.

## Features

- **One Panel, many machines.** The Panel holds no project or session state; it
  terminates a link to each Core and renders the union. Add a machine, and its
  work shows up in the same view.
- **Real terminals, not a transcript.** Every session is a PTY on the Core,
  streamed to the browser over one multiplexed WebSocket per tab. Type into it.
- **Your code never moves.** A Core runs on the machine that already has the
  repo. Nothing is uploaded, mirrored, or checked out anywhere else.
- **Status you can scan.** Sessions split into needs-input / running / finished,
  with per-project counts, so a machine asking a question is visible without
  opening it.
- **Harnesses install themselves.** `actana setup` offers the missing CLIs;
  `actana harnesses install <id>` adds one later.
- **Deploy it like a service.** Two published images, one reference compose
  file, a plain HTTP port behind your own proxy — no in-app updater, no
  certificate management. See [ADR 0010](docs/adr/0010-panel-becomes-a-self-hosted-web-service.md).

## Supported harnesses

A **Harness** is the vendor CLI a session drives. This table is the
compatibility promise — it tracks `HARNESS_REGISTRY` in `@actana/shared`.

| Harness | Command | Status | Auto-approve flag |
| --- | --- | --- | --- |
| Claude Code | `claude` | Supported | `--dangerously-skip-permissions` |
| Codex | `codex` | Supported | `--yolo` |
| Cursor CLI | `cursor-agent` | Supported | `--force` |
| OpenCode | `opencode` | Supported | — (none offered) |

Each Core needs the CLIs it runs, installed under its own user — see
[Harness CLIs](INSTALL.md#harness-clis).

## How it works

The Panel is a web service you deploy once. Each Core is a daemon on a machine
that has your code; it owns the projects, the sessions, the SQLite database and
the PTYs, and it is the only process that writes its own state ([ADR 0004](docs/adr/0004-core-owns-write-path.md)).
The two speak over a **core-link**: a WebSocket the Panel dials, authenticated
by mutual TLS with material the Core mints at first run and hands over in its
registration blob ([ADR 0002](docs/adr/0002-core-link-auth-and-transport.md)).

What you expose: one HTTP port for the Panel, reachable by your browser, and on
each Core one port (default `8443`) reachable *from the Panel's machine* — the
Panel dials the Core, never the reverse, so that port needs no route from the
public internet. In the reference compose the two share a network and nothing
is published at all.

```mermaid
flowchart LR
  B["Browser<br/>(one tab)"] -- panel-link (WSS) --> P["<b>Panel</b><br/>web service"]
  P -- core-link (mTLS) --> C1["<b>Core</b> — laptop"]
  P -- core-link (mTLS) --> C2["<b>Core</b> — workstation"]
  C1 --> H1["PTY → Harness → repo"]
  C2 --> H2["PTY → Harness → repo"]
```

Inside a project, sessions sit beside their live terminals:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-project-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/panel-project-light.png">
    <img src="docs/assets/panel-project-light.png" alt="A project's sessions split by status, with a live harness terminal alongside" width="900">
  </picture>
</p>

More in [CONTEXT.md](CONTEXT.md) and [docs/adr/](docs/adr/).

## Security & privacy

**What stays on your machines: everything.** Your repos never leave the Core
that holds them. Sessions, projects, task history and each Harness's own
credentials live in that Core's home directory. The Panel keeps no task-shaped
state of its own — only the Core registry with each Core's sealed pairing
credentials, your Operator login, and the presentation layer it owns (project
grouping, card images, your preferences).

**The auth model.** The browser reaches the Panel with an Operator session
cookie ([ADR 0011](docs/adr/0011-operator-identity-and-panel-auth.md)); the
Panel reaches each Core over mutual TLS, pinned to the CA that Core minted,
with credentials sealed at rest under a key you can hold outside the data
volume. The Panel speaks plain HTTP and expects your own proxy to terminate TLS
— it never grows certificate-management code.

**What phones home: one request a day, and nothing else.** Once every 24 hours
the Panel and each Core ask
`https://api.github.com/repos/actana/control/releases/latest` whether a newer
release exists, cache the answer, and — if there is one — say so in a
dismissible banner and in `actana status`. Nothing is downloaded and nothing is
applied. Set `ACTANA_UPDATE_CHECK=0` to turn it off.

The only other outbound request is `registry.npmjs.org`, asked for the newest
published version of each Harness CLI while you have the Providers settings
page open, so it can tell you one is outdated. **No telemetry, no analytics, no
crash reporting** — nothing describing you, your code, or your usage is sent
anywhere, ever.

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

## Documentation

[**docs/**](docs/README.md) is the index, organised by the task you actually
have — deploy a Panel, install a Core, configure it, back it up, contribute.

Start with [DEPLOY.md](DEPLOY.md) and [INSTALL.md](INSTALL.md); read
[CONTEXT.md](CONTEXT.md) before writing code, and [docs/adr/](docs/adr/) for why
the architecture is the way it is.

## Related Projects

| Project | How it differs |
| --- | --- |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Kanban-shaped planning over agent tasks, self-hostable. **Sunsetting** — Bloop shut down; community-maintained. |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | Many sessions in tmux + worktrees — a Core's job, as a local TUI rather than a control plane. AGPL-3.0. |
| [Happy](https://github.com/slopus/happy) | End-to-end-encrypted mobile/web remote control of Claude Code and Codex; a client + relay, not a control plane. |
| [Claude Code UI](https://github.com/siteboon/claudecodeui) | The closest single-node Panel analogue. AGPL-3.0. |
| [VibeTunnel](https://github.com/amantus-ai/vibetunnel) | The PTY-over-web layer on its own, without the fleet above it. |
| [cmux](https://github.com/manaflow-ai/cmux) | Concurrent-session legibility as a native macOS terminal. GPL-3.0, macOS-only. |
| [Emdash](https://github.com/generalaction/emdash) | Parallel CLIs in worktrees with a UI — minus the multi-machine dimension. |

What sets Actana apart is the fleet: one Panel over many machines, each owning
its own state. [ADR 0001](docs/adr/0001-detach-core-from-panel.md) is why the
Core was detached from the Panel in the first place.

## Contributing

Issues and PRs are welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md), and
read [CONTEXT.md](CONTEXT.md) first for the vocabulary reviewers use.
[SUPPORT.md](SUPPORT.md) says where questions, bugs and feature requests each
go; participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

> **Security problems never go in a public issue.** Report them through
> [private advisories](https://github.com/actana/control/security/advisories/new)
> — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). A derivative work of Mission Control by AgentSystem Labs — see
[NOTICE](NOTICE) for attribution.
