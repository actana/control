# The 0.5.0 Core model: no Projects, one workspace, a Shared folder, Tasks on the Panel

> **Status: PROPOSED.** It becomes ACCEPTED when this record is merged. It **supersedes** ADR 0022 and parts of
> ADR 0016 (D6, D12), 0027 (D1) and **amends** parts of ADR 0016 (D19), 0027 (D2, D6), 0028 and 0030, as the table
> below says. Older records are amended by dated or appended notes; none is rewritten or renumbered.
>
> **Amended 2026-09-30 by [#567](https://github.com/actana/control/issues/567)** with D14–D21, the Panel's Postgres
> decisions, which further **amend** ADR 0010, ADR 0011 and ADR 0016 (D20, D25). The decisions are the owner's, in
> their comment on #567 and their comment on [#556](https://github.com/actana/control/issues/556), both dated
> 2026-09-30. Nothing in D1–D13 is changed.

> **On the number.** This record takes **0041**, the next free number after
> [`0040-pi-project-trust-answered-by-extension.md`](0040-pi-project-trust-answered-by-extension.md).
> It does not repeat the 0018 collision described in [`README.md`](README.md).

## Context

[#552](https://github.com/actana/control/issues/552) tracks the 0.5.0 release
and [#554](https://github.com/actana/control/issues/554) is this record: the
model that every later ticket in the train builds on, written before any code
changes. Until 0.4.x a Core hosts **Projects**, each holding **Tasks**, each
Task backed by a **Session**; the Panel keeps a presentation row for every
Project; the filesystem under a Project is the model; and `core` has passwordless
sudo. 0.5.0 replaces that shape. There is no port from 0.4.x: Cores are
installed fresh on 0.5.0 (#552).

## Decisions

**D1 — There are no Projects.** A Core is a workspace plus Sessions. The
workspace is `~`, the home of the `core` user.

**D2 — A Session always starts in the workspace.** There is no custom path. To
focus a Session on a folder, say so in the prompt.

**D3 — Session is the name everywhere.** The row that the code, the DB and the
wire call *Task* becomes **Session**, and `taskId` becomes `sessionId`.

**D4 — Task is the Panel-side work item.** The word is freed by D3 and now names
the unit of work that lives on the Panel (D8), not a row on a Core.

**D5 — `~/shared` always exists.** It is the **Shared folder** of the Core.

**D6 — Without S3 the Shared folder is a local folder.** With a Panel it is
mounted from S3 using short-lived keys, one folder per Core.

**D7 — All reports and communication go through the Shared folder.**

**D8 — The layers above a Core live in the controller, not on the Core.**
Tasks, comments, agents, the REST API, MCP, API keys and webhooks live in the
Panel (Postgres).

**D9 — The Panel uses only the public SDK.** Any other controller, for example
Studio, can therefore do the same.

**D10 — `core` has no sudo.** Root is used only by the container's own startup.

**D11 — The Core daemon runs as its own user, with its state outside `~`.**

**D12 — Deleting a Core removes the Core, its Shared folder and its S3 folder.**

**D13 — Unpairing a Core from a Panel removes only the S3 link.** `~/shared`
stays and keeps its contents.

## What this supersedes

Each older record is marked with a pointer to this one. Its text is not
rewritten.

| Earlier decision | Effect | Because |
|---|---|---|
| [ADR 0022](0022-a-core-owned-project-has-a-panel-side-presentation-row.md), in full, with its two amendments (ADR 0030 and #382) | **Superseded** | D1: with no Projects there is no Project for the Panel to keep a presentation row for. |
| [ADR 0027](0027-the-filesystem-is-the-model.md) **D1** ("a Project's files are the directory. There is no index") | **Superseded** | D1: the files are no longer a Project's. What the Shared folder does about change detection is #561's to decide, not this record's. |
| ADR 0027 **D2** (the address `(projectId, relative path)`) and **D6** (`/v1/projects/:projectId/files/list`) | **Amended** | D1, by the same reasoning as ADR 0028 below: the Files API is re-rooted at the workspace (#557). The rest of 0027 is not changed by this record. |
| [ADR 0028](0028-file-bytes-cross-https-not-the-core-link.md), the parts that address a Project | **Amended** | D1: the Files API is re-rooted at the workspace (#557). The rest of 0028 is not changed by this record. |
| [ADR 0030](0030-the-panel-is-a-dumb-pipe-for-file-bytes.md) **D5** ("a file view is not presentation") and every place it says Project | **Amended** | D1, and 0022 above. D5 argues from 0022's `project_presentation` row, which no longer exists. |
| [ADR 0016](0016-the-0-1-0-shape.md) **D12**, the sentence keeping `NOPASSWD` sudo for `core` | **Superseded** | D10. |
| ADR 0016 **D12**, the headline "The Core runs as `core`, uid 1000, gid 1000, always" | **Superseded** | D11: the daemon runs as its own user. Sessions still run as `core` with the pinned ids. |
| ADR 0016 **D19** (the identity, config and SQLite in `core-home:/home/core`) | **Amended** | D11: the daemon's state lives outside `~`. Where it lives is open (#559, #558). |
| ADR 0016 **D6**'s `sudo` package, the sudo reasoning under D12 (the `user:` override paragraph) and conflict C7 | **Superseded** | D10. |
| `CONTEXT.md` rule "Nothing task-shaped lives on the Panel" | **Replaced** | D4 and D8. |
| `CONTEXT.md` avoided terms "uploads" and "project storage" | **Removed** | The issue names these two. They sat under **Project files**, and D1 removes the Project. |
| `CONTEXT.md` avoided terms "the volume" and "attachments" | **Removed** | The issue does not name these. They went with the same **Project files** entry. |
| `CONTEXT.md` rule "A Project's path is a VM path" | **Reworded** | D1. It is kept as "A path is a VM path". |

`CONTEXT.md` changes with it. It removes **Project**, and its Project-scoped
entries follow from D1: **Project presentation**, **Project files** and
**Pinned Project**. It defines Core,
workspace, Session, Harness, Shared folder, Task, Agent and Report.

## Definitions this record fixes

- **Agent** is a Harness with its settings on a Core (#569).
- **Report** is what goes through the Shared folder (D7). Its contract is
  actana/client#8, and the Panel turns result files into Task status and
  comments (#570).

Neither definition says more than the tickets say. The rest is open, below.

## Open

These are not decided here. Each is the named ticket's to settle.

- **The shape of an Agent's settings**, and how a Task is dispatched to one
  (#569, #570).
- **The Report contract** through the Shared folder: file names, layout and
  fields (actana/client#8).
- **The wire form of the rename** in D3, and what happens to core-link frames
  and the protocol version (#556). *Decided on 2026-09-30: a hard cut, D21.*
- **The new Files API address and its delete and create-folder routes** (#557).
- **The Shared folder's change feed** and the mount mechanism (#561, #562).
- **How the Panel's Files tab reaches Shared-folder bytes**, and so whether the
  Panel remains a "dumb pipe" (ADR 0030) for them (#565).
- **Where Remembered session settings live** (ADR 0017) now that the Project row
  they were stored against is gone. No ticket in #552 says.
- **Which directory holds the daemon's state**, outside `~` (#559).
- **How the daemon starts Sessions as `core` and writes into `core`'s home.** D11 runs the daemon as its own user
  and D10 allows root only at container startup, so after startup the daemon has no root. Nothing in #552 says how
  it then starts a Session's PTY as `core` (D2) or writes into the workspace (D1). #559 owns it.
- **How an Agent relates to Remembered session settings.** Both are a Harness with settings. Only #569 defines
  Agent.

## Amended by #567: the Panel's database is Postgres

Decided by the owner on 2026-09-30 ([#567](https://github.com/actana/control/issues/567), and
[#556](https://github.com/actana/control/issues/556) for D21). D8 already says the layers above a Core live in the
Panel (Postgres); these clauses say what that means for the Panel's own database. They are appended, so no earlier
number moves. This record only writes the decisions down. The code, the deploy files and the packages change in the
later pull requests of #567, and until they land the Panel still runs on SQLite.

**D14 — The Panel's state lives in Postgres only.** Every Panel table moves, including the Projects family, which
#560 then deletes on Postgres. No SQLite is left in the Panel's state. "Done" for #567 is that the Panel runs on
Postgres only.

**D15 — `owner_id` references `operator.id`.** It keeps ADR 0011's single Operator. Ownership is enforced in Panel
code: every user-facing table has an `owner_id`, and every query filters on the owner (#567).

**D16 — Postgres is bundled, and the Panel refuses to start without it.** The compose file carries a Postgres
service. Its image is pinned by digest and is at least 7 days old. An operator may point the Panel at their own
server with the optional `AC_PANEL_DATABASE_URL`. The Panel refuses to start without a database. **A backup is a dump
plus the secrets key**, because `core_secrets` is sealed (ADR 0011).

**D17 — Migrations are drizzle-kit SQL migrations from a clean baseline, run at boot.** The legacy SQL migration files
are dropped.

**D18 — Time columns keep epoch milliseconds, as `bigint`.** They match the wire. The Panel does not move to
`timestamptz`.

**D19 — The driver is `pg`. Unit tests use PGlite. One CI job runs against a real Postgres.**

**D20 — `better-sqlite3` leaves the Panel.** The Panel's provider-usage readers of other apps' SQLite files move to
`node:sqlite`.

**D21 — The wire rename in D3 is a hard cut, with no alias (#556).** Frames, events, the DB and the SDK and CLI say
`sessionId` only. There is no `taskId` alias anywhere, including `session start --json`. The protocol version is
bumped, and a 0.5.0 Core and SDK do not talk to 0.4.x. 0.5.0 Cores are installed fresh. The SDK side is
actana/client#10.

**No backward compatibility.** A 0.5.0 Panel starts on an **empty** Postgres. **0.4.x Panel data is not migrated.**
There is no import of the SQLite file.

### What D14–D21 do to older records

Each older record gets a dated note pointing here. No text is rewritten.

| Earlier decision | Effect | Because |
|---|---|---|
| [ADR 0010](0010-panel-becomes-a-self-hosted-web-service.md), the last shape bullet: "`node-pty` and `better-sqlite3` need no Electron-ABI rebuilds" | **Amended** | D20. The Panel no longer has `better-sqlite3`. The bullet's point stands for `node-pty`, which is the Core's. |
| ADR 0010, "one deployable" and the single Docker image | **Amended** | D16. The Panel is still one service and one image, but a normal install now runs a Postgres service beside it. A bare Node process needs a reachable Postgres too. |
| [ADR 0011](0011-operator-identity-and-panel-auth.md), "the auto-generated key file stored in the data volume next to the database" | **Amended** | D14, D16. The database is Postgres, not a file in the data volume. The key file, and `AC_SECRETS_KEY`, are unchanged, and the key is now a separate thing to back up. |
| ADR 0011, one Operator per Panel, tenancy out of scope | **Not changed** | D15 builds on it. `owner_id` references the one Operator. |
| [ADR 0016](0016-the-0-1-0-shape.md) **D20** (distroless runtime, digest-pinned) | **Amended** | D16. The digest-pin rule now also covers the Postgres image. The Panel image itself is not changed by this record. |
| ADR 0016 **D25** (build and runtime both on Debian 13, with a `better-sqlite3` compiled in the build stage as the evidence) | **Amended** | D20. That example no longer applies, because the Panel has no compiled `better-sqlite3`. The alignment on Debian 13 is not changed by this record. |

### Open questions

These are not decided here. Each is for the pull request that needs it, and is settled by amending this record.

- **Row-level security.** The owner asked for ownership "enforced in Panel code". Whether Postgres row-level security
  is also wanted, and whether `owner_id` is also a database foreign key, was asked on #567 and not answered.
- **Which tables count as user-facing**, and so carry an `owner_id`. The #567 comment proposes cores, groups,
  projects, presentation, tasks, terminal logs and token usage. The owner did not confirm the list.
- **The exact `pg` version and the Postgres image tag and digest.** The #567 comment names `pg` 8.23.0. Each must be
  a release at least 7 days old and pinned exactly at the time the pull request adds it.
- **The name of the Postgres service and its volume, how the dump is taken and restored**, and whether the Panel
  image carries any Postgres client tool (D20 in ADR 0016 leaves nothing but Node in it).
- **How the boot migration behaves** when two Panel processes start at once, and when the database holds migrations
  newer than the Panel. The real-Postgres CI job exists for pool and lock behaviour, but the behaviour is not chosen.
- **The Panel image's healthcheck** while the database is down (ADR 0016 D23), given that the Panel refuses to start
  without it.
- **What "refuse to start" does about a database that is up later**: exit and let the restart policy retry, or
  retry in process.

## Consequences

- **#555 and #556 change the code to match** and #560 the Panel. Until they land,
  the code, the DB and the wire still say Project and Task, and `CONTEXT.md`
  says what they will say.
- **Every later ticket in #552 cites this record** for the model.
- **A ticket that needs a decision changed amends this record rather than settling it in a comment.** This rule is
  from `docs/adr/README.md` and ADR 0024. It is new to this record and was not decided in #552 or #554.
- **#567 is built in seven pull requests, and this record is the first.** Each later one builds on D14–D21.
