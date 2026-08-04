# Actana Control

Self-hosted control surface for managing agentic coding work (Claude Code / Codex / Cursor CLI) across many machines.

Two pieces:

- The **Panel** — one web service you open in a browser. It serves the UI, holds
  your operator login, and terminates a link to every Core.
- A **Core** — a daemon on a machine that actually has your code. It owns
  the projects, the sessions, the SQLite database, and the PTYs (`node-pty`), and
  it is the only process that writes its own state.

The Panel bundles no Core and runs no harnesses of its own: install a Core on
each machine you want to work on — including your own laptop — and pair it
(ADR 0010).

## Why this exists

Cursor and Codex bury your projects in a collapsable left rail. Actana Control flips it: every project gets a card on a single home view, with at-a-glance counts of how many harnesses are running, awaiting input, or done. Click into a project, see its tasks split by status, toggle three of them on at once and three real terminals split horizontally on the right. External CLI tools can POST status back to the app over a localhost API.

## Features

- Actana Control grid with pinned / grouped / ungrouped sections, density toggle, and search
- Project add/edit/remove (remove only unlinks — never touches files)
- Project grouping with colored dots
- Project detail view: tasks split into Needs-input / Running / Done columns
- Multi-select tasks → split-pane terminals (cap of 4)
- New-harness launcher for Claude Code / Codex / Cursor CLI / plain shell
- External REST API + Server-Sent Events for live UI updates
- Bearer-token auth for the writable endpoints
- Terminals in the browser over one multiplexed WebSocket per tab
- Dark + light themes matching the prototype's design tokens

## Stack

- TanStack Start (file-based React routes + server file routes for `/api/*`)
- Vite 7 + Tailwind v4 + Geist / Geist Mono
- SQLite (`better-sqlite3`) + Drizzle ORM
- `node-pty` + `@xterm/xterm` + `@xterm/addon-fit`
- Server-Sent Events for live updates (no socket.io / Redis)

## Repo layout

```
control/
├── packages/
│   ├── core/               Standalone Node daemon — the Core
│   │   └── src/
│   │       ├── core-entry.ts           daemon entry
│   │       ├── actana-cli.ts           the `actana` CLI (setup, status, token)
│   │       ├── pty-manager.ts          PTY lifecycle
│   │       └── pty-core-link-server.ts core-link WebSocket server
│   ├── panel/              The Panel — service + browser UI
│   │   ├── bin/panel.mjs   the service entry (`actana-panel`)
│   │   └── src/
│   │       ├── routes/     TanStack Start file routes
│   │       ├── components/ ui/ primitives, views/ screens
│   │       ├── lib/
│   │       │   ├── panel-bridge.ts  the one surface components reach a Core through
│   │       │   └── api.ts           typed fetch client for the Panel's own routes
│   │       ├── server/
│   │       │   ├── panel-link/      the browser's multiplexed WebSocket
│   │       │   ├── core-link/       the service's link to each Core
│   │       │   └── controllers/     the `/api/*` surface
│   │       └── db/         Drizzle schema + client
│   └── shared/             core-link / panel-link frames, protocol types
├── docs/adr/               Architecture decisions
├── designs/                Original HTML+JSX prototype (source of truth)
├── deploy/                 Reference compose: Panel + TLS proxy
├── INSTALL.md              Installing a Core
├── DEPLOY.md               Deploying the Panel
├── SPEC.md                 Approved product spec
└── README.md
```

## Running it

Install a Core on each machine you want to work on — see [INSTALL.md](INSTALL.md)
— then run the Panel and pair them from its UI.

### The Panel, deployed

The Panel ships as a Docker image; the reference compose file in
[`deploy/`](deploy) puts it behind a TLS-terminating proxy with automatic
Let's Encrypt, and `localhost` needs no proxy at all:

```bash
docker run -d -p 127.0.0.1:7420:7420 -v actana-panel-data:/data \
  ghcr.io/actana/panel:latest
```

[DEPLOY.md](DEPLOY.md) covers the compose path, the bare `node` path,
configuration, backup, and upgrade.

### The Panel, from source

```bash
pnpm install
pnpm dev                # Vite dev server; open the URL it prints
```

Or serve a production build:

```bash
pnpm build              # builds the Core bundle + the Panel
pnpm start              # serves the Panel on http://localhost:7420
```

The Panel speaks plain HTTP and expects a reverse proxy (Traefik / Nginx /
Caddy) to terminate TLS in front of it; `localhost` is a secure context without
one. It never grows certificate-management code (ADR 0010).

| Env | Default | Meaning |
| --- | --- | --- |
| `AC_PANEL_PORT` / `PORT` | `7420` | Port to listen on |
| `AC_PANEL_HOST` / `HOST` | `0.0.0.0` | Interface to bind |
| `AC_PANEL_DATA_DIR` | platform data dir | Where `panel.db` and the secrets key live |
| `AC_SECRETS_KEY` | generated | 32-byte key sealing each Core's stored credentials. Lose it and every Core must be re-paired. |

### Updating

Pull a newer Panel image (or rebuild from source) and restart the service. There
is no in-app updater: the Panel is a service its operator deploys, not an app
that rewrites itself.

### Native modules

`better-sqlite3` and `node-pty` build against the standard Node ABI — there is no
second runtime to rebuild for. `pnpm dev`, `pnpm test`, and `pnpm db:*` ensure
`better-sqlite3` matches the current Node first.

## External API

Each **Core** binds an HTTP server on `127.0.0.1:<port>` of its own machine
for the harnesses it runs. Run `actana status` on that machine for its address and
token; `actana token regenerate` rotates them. The Panel never proxies this
surface — a harness's hooks POST to the Core that spawned it.

### Endpoints (writable — bearer token required)

| Method | Path                                   | Description                                  |
| ------ | -------------------------------------- | -------------------------------------------- |
| POST   | `/api/projects/:id/tasks`              | Create a task scoped to a project            |
| POST   | `/api/tasks/:id/status`                | Update a task's status / preview / line count |

### Example: mark a task done

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -X POST http://127.0.0.1:$PORT/api/tasks/$TASK_ID/status \
  -d '{"status":"done","preview":"All tests passing"}'
```

The UI updates within ~1 second over its SSE connection.

### The Panel's own routes

The Panel's `/api/*` surface is authenticated by the operator's session cookie,
which the browser attaches on its own (ADR 0011). Harnesses never call it — they
call the Core that spawned them, with the bearer token it put in their env.
`/api/events` (SSE) uses a short-lived ticket from `POST /api/events/ticket`
because `EventSource` cannot send custom headers.


| Method | Path                                   |
| ------ | -------------------------------------- |
| GET    | `/api/projects`                        |
| POST   | `/api/projects`                        |
| GET    | `/api/projects/:id`                    |
| PATCH  | `/api/projects/:id`                    |
| DELETE | `/api/projects/:id`                    |
| GET    | `/api/groups`                          |
| POST   | `/api/groups`                          |
| PATCH  | `/api/groups/:id`                      |
| DELETE | `/api/groups/:id`                      |
| GET    | `/api/projects/:id/tasks`              |
| GET    | `/api/tasks/:id`                       |
| PATCH  | `/api/tasks/:id`                       |
| POST   | `/api/tasks/:id/archive`               |
| POST   | `/api/tasks/:id/restore`               |
| GET    | `/api/archive`                         |
| GET    | `/api/events` (SSE)                    |
| GET    | `/api/settings`                        |
| POST   | `/api/settings` (regenerate token)     |

## Observability

The Panel service and each Core both log to stdout/stderr, so whoever
supervises the process owns the sink — `docker logs`, `journalctl --user -u
actana-core`, or the terminal you started it in. `actana status` on a Core
prints where its own daemon logs land.

## Skill file for external CLIs

A drop-in skill for Claude Code / Codex / Cursor CLI lives in `docs/skills/missioncontrol-notify.md`. Paste it into the CLI's instructions or memory so the harness knows to POST its lifecycle events back to Actana Control.

## Documentation

[**docs/**](docs/README.md) is the index. The short version:

| | |
| --- | --- |
| Deploy the Panel | [DEPLOY.md](DEPLOY.md) |
| Install a Core on a machine | [INSTALL.md](INSTALL.md) |
| A local Panel + Core pair, no provisioning | [deploy/dev/](deploy/dev/README.md) |
| The vocabulary and the invariants | [CONTEXT.md](CONTEXT.md) |
| Why the architecture is like this | [docs/adr/](docs/adr/) |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |
| What CI runs and publishes | [docs/ci-cd.md](docs/ci-cd.md) |

## Contributing

Issues and PRs are welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md).
Questions go to [Discussions](https://github.com/actana/control/discussions)
([SUPPORT.md](SUPPORT.md)); security problems go through
[private reporting](https://github.com/actana/control/security/advisories/new),
never a public issue ([SECURITY.md](SECURITY.md)). Participation is governed by
the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). This project is a derivative work of Mission Control by
AgentSystem Labs — see [NOTICE](NOTICE) for attribution.
