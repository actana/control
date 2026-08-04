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
- `packages/shared` — the types and wire contracts both sides agree on.

A **Core** is one machine in the fleet; a **Harness** is the agentic CLI it
runs. If that vocabulary is new, read [`CONTEXT.md`](CONTEXT.md) before you write code — it is the
project's glossary, and reviewers use its terms.

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

The Panel's native dependency (`better-sqlite3`) is compiled during install. If
it goes stale after a Node upgrade, `pnpm native:node:rebuild`.

To exercise a real Panel↔Core pair without provisioning a machine, bring up
the reference deployment — the published Panel and Core images on one network:

```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs core   # the registration blob
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
every PR, and at arm64 on a release tag. See [`docs/ci-cd.md`](docs/ci-cd.md)
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
  as "needs update", never a degraded or feature-detected mode.
- **One core-link per Core, multiplexed.** No per-task channels.

If your change contradicts an ADR in [`docs/adr/`](docs/adr/), say so in the PR
rather than working around it. Reopening a decision is fine; doing it silently
is not.

## Architectural decisions

Anything that changes a wire contract, moves state across the Panel/Core
boundary, or adds a dependency to the Core bundle wants an ADR. Add a file
to [`docs/adr/`](docs/adr/) using the next number, following the existing
format (Context / Decision / Consequences). Open it in the same PR as the code.

## Branch naming

Branch off `main`. Names must match `<type>/<kebab-case-description>`:

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
is what lands on `main` and what the changelog is built from. Write it as the
commit you want, not as a description of your branch.

Subjects may open with a ticket id (`E10 — black-box Panel service e2e`); the
lint does not force a lowercase first letter. Subject limit is 120 characters,
body lines 100.

Footers (`Refs #39`, `Co-authored-by:`, `BREAKING CHANGE:`) go last, separated
from the body by a blank line. Only those known tokens start a footer, so a
body sentence that wraps onto `that: it is absent under Podman…` stays prose —
see the `trailer-leading-blank` note in `commitlint.config.mjs`.

- Keep PRs to one reviewable idea.
- Fill in the PR template. The "how was this tested?" section is the one
  reviewers actually read.
- Link an issue with a closing keyword (`Closes #123`).
- PRs from forks run the full CI matrix, but without repository secrets, so
  container publishing steps are skipped. That is expected, not a failure.
- `git config commit.template .gitmessage` gives you the format in your editor.

## Filing issues

Use the issue templates — they route to the right form and apply the
`needs-triage` label, which is what the maintainers' triage pass looks for.
A maintainer will move it to `needs-info`, `ready-for-agent`, `ready-for-human`,
or `wontfix`. Those five labels are the whole vocabulary; see
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

Do not file security problems as issues — see [`SECURITY.md`](SECURITY.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE). This project is a
derivative work of Mission Control by AgentSystem Labs; see [`NOTICE`](NOTICE).
