# Contributing to Actana Control

Thanks for taking the time. This guide covers what you need to get a change
merged: how to run the thing, what CI will hold you to, and the handful of
architectural rules that a reviewer will send a PR back over.

## The shape of the project

Actana Control is two programs that talk over one WebSocket:

- The **Panel** (`packages/panel`) — the self-hosted web service you deploy.
  It owns the Core registry and terminates every core-link. It holds no task,
  session, or project state.
- The **Core** (`packages/core`) — the daemon installed on each machine
  you want to run harnesses on. It owns everything task-shaped: PTYs, SQLite, the
  event log, the project registry.
- `packages/sdk` — the core-link wire protocol: the frame schema both sides
  agree on, and the only definition of it in the repository. It lives with the
  client that speaks it, and the Core imports its frames from here too
  ([ADR 0025](docs/adr/0025-the-protocol-ships-with-the-client.md)).
- `packages/cli` — the whole `actana` command: the blob registry that names the
  Cores a machine can reach and the nouns built on the SDK, plus the verbs that
  install and operate a Core on this machine. One program under one name; the
  Core package is the daemon and nothing else
  ([ADR 0032](docs/adr/0032-one-actana-cli.md)).
- `packages/shared` — the other types both sides agree on: the mutation and
  query contracts, the registration-blob codec, the event log, the harness
  registry. Private, and it stays private.

A **Core** is one machine in the fleet; a **Harness** is the agentic CLI it
runs. If that vocabulary is new, read [`CONTEXT.md`](CONTEXT.md) before you write code — it is the
project's glossary, and reviewers use its terms.

### The stack

- TanStack Start (file-based React routes + server file routes for `/api/*`)
- Vite 7 + Tailwind v4
- SQLite (`better-sqlite3`) + Drizzle ORM
- `node-pty` + `@xterm/xterm` + `@xterm/addon-fit`
- Server-Sent Events for live updates (no socket.io / Redis)

### Where the code lives

```
control/
├── packages/
│   ├── cli/                The whole `actana` command — client and Core manager
│   │   ├── bin/actana.mjs  what npm links as `actana`
│   │   └── src/
│   │       ├── actana-cli.ts       noun dispatch
│   │       ├── blob-registry.ts    ~/.config/actana/cores/<name>.txt, mode 0600
│   │       └── core-command.ts     the `core` noun
│   ├── core/               Standalone Node daemon — the Core, and nothing else
│   │   └── src/
│   │       ├── core-entry.ts           daemon entry
│   │       ├── core-first-run.ts       mints this Core's identity on an empty volume
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
│   ├── sdk/                The Core client and the core-link frames it speaks
│   └── shared/             mutation/query contracts, registration-blob codec
├── docs/adr/               Architecture decisions
├── designs/                Original HTML+JSX prototype (source of truth)
├── deploy/                 The two images and the one reference compose
├── INSTALL.md              Installing a Core
└── DEPLOY.md               Deploying the Panel
```

## Setup

You need **Node 24** (`.nvmrc` pins it; `preinstall` refuses anything else) and
**pnpm 11.1.2**.

```bash
git clone https://github.com/actana/control
cd control
pnpm install
pnpm build          # Core bundle first, then the Panel — that order matters
pnpm dev            # Panel dev server
```

The native dependencies (`better-sqlite3`, `node-pty`) are compiled during
install, against the standard Node ABI — there is no second runtime to rebuild
for. `pnpm dev`, `pnpm test` and `pnpm db:*` each ensure `better-sqlite3`
matches the current Node before they run; if it goes stale after a Node
upgrade, `pnpm native:node:rebuild`.

To exercise a real Panel↔Core pair without provisioning a machine, bring up
the reference deployment — the published Panel and Core images on one network:

```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml exec core actana pair new
```

## Before you open a PR

Run what CI runs:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm scan:secrets
```

Heavier suites, worth running when you have touched their seam:

| Command | Covers |
| --- | --- |
| `pnpm panel:e2e` | the Panel service seam against a real Core |
| `pnpm panel:image:smoke` | the Panel image boots, sets up, and survives container recreation |
| `pnpm core:image:smoke` | the Core image boots unprivileged and a Panel pairs with it (needs `pnpm core:tarball` first) |
| `pnpm core:tarball:smoke` | the release tarball unpacks and runs |
| `pnpm core:setup:e2e` | the `curl \| bash` one-liner and the lifecycle verbs against systemd (Linux) |

CI runs all of these plus the installer e2e across Ubuntu and Debian at x64 on
every PR, and at arm64 on a release. See [`docs/ci-cd.md`](docs/ci-cd.md)
for what runs when.

## The rules a reviewer will hold you to

These are load-bearing, not style preferences. Each is explained in
[`CONTEXT.md`](CONTEXT.md) and most have an ADR behind them.

- **Nothing task-shaped lives on the Panel.** The Panel stores Cores and one
  `lastEventId` per Core. Tasks, sessions, terminal logs, hook events, and
  project paths live on the Core that owns them.
- **Only the Panel dials Cores.** Browsers cannot hold client certificates, so
  every core-link terminates inside the Panel. The Panel UI reaches Cores
  through its panel link, never directly.
- **Singular UI across Cores.** The same components render every Core's data.
  A Core on the Panel's own host gets no special path.
- **The Panel and its Cores are version-locked.** A protocol mismatch renders
  as "needs update", never a degraded mode. The one exception is an additive
  capability announced on `ready` whose absence yields today's behaviour
  exactly (ADR 0024 D11).
- **One core-link per Core client, multiplexed.** No per-task channels. A Core
  serves many clients at once and a new connection evicts nobody (ADR 0024 D1).
- **Many Readers, one writer, per Session.** Any client may watch a Session;
  only the one holding its Session lock may mutate it.

If your change contradicts an ADR in [`docs/adr/`](docs/adr/), say so in the PR
rather than working around it. Reopening a decision is fine; doing it silently
is not.

## Architectural decisions

Anything that changes a wire contract, moves state across the Panel/Core
boundary, or adds a dependency to the Core bundle wants an ADR. Add a file
to [`docs/adr/`](docs/adr/) using the next number, following the existing
format (Context / Decision / Consequences). Open it in the same PR as the code.

Amending an existing ADR: **append a clause, never renumber one.** Numbers are
cited from workflow comments, scripts and tickets, so shifting them silently
invalidates every reference at once. [`docs/adr/README.md`](docs/adr/README.md)
records the two number collisions that already exist and why neither is being
tidied up.

## Where your PR goes: the open train, not `main`

**Open your pull request against the open `beta/x.y.z` branch.** `main` accepts
exactly one kind of change — the promotion of a whole train — and there is no
exception for hotfixes, documentation, or reverts
([ADR 0023](docs/adr/0023-release-trains-and-digest-promotion.md) D1).

The open train sometimes carries a **sub-beta** suffix — `beta/0.4.5-f1`,
`beta/0.4.5-f2` — when a fix has to be taken while the train is frozen for
approval (D46). That is still the open train; target it the same way. It is a
variation of `beta/0.4.5`, not a new version: nothing in the tree changes name,
it merges back into `beta/0.4.5` when it is done, and the release is `v0.4.5`
with no suffix either way.

GitHub will not help you here: it bases every new pull request on the default
branch, which is still `main`. So the first one you open targets the wrong
thing, a required check called `Train rules` fails, and a bot comments telling
you to retarget. **Use the "Edit" button beside the PR title to change the base
— you do not need to close it or re-push.**

`main` stays the default deliberately, even though this is the papercut making
it the train would fix: `main` is what
`raw.githubusercontent.com/actana/control/main/install.sh` serves, what a clone
checks out, and what the README renders from. All three mean "released code",
and inverting that to save a retarget click is the wrong trade.

To find the open train:

```bash
git ls-remote --heads origin 'refs/heads/beta/*'
```

There is only ever one. If you find two, a hotfix is in flight — see
[`docs/ci-cd.md`](docs/ci-cd.md#hotfix-trains).

**A train can publish.** Beside the `beta-x.y.z` images every merge republishes,
a person can dispatch `beta-release.yml` to cut a beta — a prerelease at
`x.y.z-beta` with the three Core tarballs, their checksums, the CLI and the
matching image tags, so the train is installable rather than only pullable ([ADR
0036](docs/adr/0036-the-beta-release-channel.md)). Merging your pull request does
not cut one; asking does.

```bash
gh workflow run beta-release.yml --repo actana/control --ref beta/x.y.z -f train=beta/x.y.z
```

**The train is named twice and both are required** — `--ref` decides which copy
of the workflow runs, `-f train=` is the input, and the run refuses unless they
agree. [`docs/ci-cd.md` §Cutting a beta](docs/ci-cd.md#cutting-a-beta) is the
full procedure and says why.

### The freeze window

**From the moment a train is frozen for approval until it promotes, nothing
merges anywhere.** Not your PR, not a one-line docs fix, not a revert.

This is not bureaucracy: every merge into a train republishes the `beta-x.y.z`
image, and promotion asserts that the image a person tested was built from the
exact commit being promoted. A merge landing during acceptance invalidates the
testing somebody is in the middle of doing, and the promotion then refuses with
*"the train moved; re-approve"*.

The window is bounded by how long promotion takes — minutes, plus however long
the reviewer's checklist takes. It is announced when it starts. If your PR is
approved and green during a freeze, it merges as soon as the new train opens;
nothing is lost, and you do not need to do anything.

### Your PR gets an image, unless it is from a fork

Every push to a non-draft pull request from this repository publishes an image
a reviewer can *run* rather than read — `pr-<number><YYYYMM>` in
[`actana/panel-dev`](https://hub.docker.com/r/actana/panel-dev) and
`actana/core-dev`. The `Panel image` and `Core image` checks say which tag they
pushed.

**Pull requests from forks build the image and publish nothing, and that is by
design — not a bug to file.** GitHub does not expose repository secrets to a
workflow run triggered by a fork, and the alternative (`pull_request_target`)
would hand contributor-authored code a credential that can push `:latest` and
rewrite both public image pages. It is rejected outright. So the pull request
image is a **maintainer convenience, not a contributor one**: your fork's PR
gets the full gate, a green image check, and no published image.

Draft pull requests and documentation-only diffs also publish nothing — those
checks go green immediately rather than being skipped, because a *skipped*
required check would leave your PR blocked forever.

## Branch naming

Branch off the open train. Names must match `<type>/<kebab-case-description>`:

```
feat/fleet-view-core-badges
fix/core-link-reconnect-cursor
docs/deploy-behind-traefik
```

Allowed types: `feat` `feature` `fix` `bugfix` `hotfix` `release` `chore`
`docs` `refactor` `perf` `test` `ci` `revert`. Lowercase only, hyphen-separated,
no leading/trailing/doubled separators.

CI checks this (the `Conventions` job in `ci.yml`). To be told before you push instead
of after, enable the local hooks once per clone:

```bash
git config core.hooksPath .husky
```

Husky is not a dependency — these run under plain git. The `commit-msg` hook
checks your message with commitlint if it is available and steps aside with a
hint if it is not; [`docs/ci-cd.md`](docs/ci-cd.md#running-ci-locally) has the
install line (it goes through a temp directory — npm cannot parse this
workspace's root `package.json`).

## Commits and PRs

Commit messages and **PR titles** follow
[Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <subject>`. The types are the same list as the branch types.
`commitlint.config.mjs` is the source of truth, and CI enforces it on both.

```
feat(panel): badge Cores by reachability in Fleet view
fix(core): replay from lastEventId after a socket drop
```

We **squash-merge, using the PR title as the commit message** — so the PR title
is what lands on the train, rides the promotion to `main` unchanged, and is what
the changelog is built from. Write it as the commit you want, not as a
description of your branch.

CI lints **every commit in the pull request**, not just the title. A tidy title
over a branch of `wip` commits fails the `Conventions` job.

Subjects may open with a ticket id (`E10 — black-box Panel service e2e`); the
lint does not force a lowercase first letter. Subject limit is 120 characters,
body lines 132 — measure them before you commit, because a single unwrapped
body line is the most common way a commit here goes red.

Footers (`Refs #39`, `Co-authored-by:`, `BREAKING CHANGE:`) go last, separated
from the body by a blank line. Only those known tokens start a footer, so a
body sentence that wraps onto `that: it is absent under Podman…` stays prose —
see the `trailer-leading-blank` note in `commitlint.config.mjs`.

- Keep PRs to one reviewable idea.
- Fill in the PR template. The "how was this tested?" section is the one
  reviewers actually read.
- Link an issue with a closing keyword (`Closes #123`).
- Target the **open train**, not `main` — see
  [Where your PR goes](#where-your-pr-goes-the-open-train-not-main).
- PRs from forks run the full CI matrix, but without repository secrets, so no
  image is published. That is expected, not a failure.
- `git config commit.template .gitmessage` gives you the format in your editor.

## Filing issues

Use the issue templates — they route to the right form and apply the
`needs-triage` label, which is what the maintainers' triage pass looks for.
A maintainer will move it to `needs-info`, `ready-for-agent`, `ready-for-human`,
or `wontfix`. Those five labels are the whole vocabulary; see
[`.agents/triage-labels.md`](.agents/triage-labels.md).

Do not file security problems as issues — see [`SECURITY.md`](SECURITY.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE). This project is a
derivative work of Mission Control by AgentSystem Labs; see [`NOTICE`](NOTICE).
