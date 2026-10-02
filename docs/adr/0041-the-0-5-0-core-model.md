# The 0.5.0 Core model: no Projects, one workspace, a Shared folder, Tasks on the Panel

> **Status: PROPOSED.** It becomes ACCEPTED when this record is merged. It **supersedes** ADR 0022 and parts of
> ADR 0016 (D6, D12), 0027 (D1) and **amends** parts of ADR 0016 (D19), 0027 (D2, D6), 0028 and 0030, as the table
> below says. Older records are amended by dated or appended notes; none is rewritten or renumbered.
>
> **Amended 2026-09-30 by [#567](https://github.com/actana/control/issues/567)** with D14–D21, the Panel's Postgres
> decisions, which further **amend** ADR 0010, ADR 0011 and ADR 0016 (D20, D25). The decisions are the owner's, in
> their comment on #567 and their comment on [#556](https://github.com/actana/control/issues/556), both dated
> 2026-09-30. D22 was added by [#595](https://github.com/actana/control/pull/595), and D23 by [#605](https://github.com/actana/control/pull/605). Nothing in D1–D13 is changed.
>
> **Amended 2026-10-01 by [#559](https://github.com/actana/control/issues/559)** with D24–D26, the container Core's two
> users. They settle the two Open items on the state directory and on how Sessions start, and say what D10 and D11
> mean in the container. The owner's decisions are on #559, dated 2026-09-30 and 2026-10-01. Nothing in D1–D23 is
> changed; D10 and D11 each gain a pointer.
>
> **Amended by [#555](https://github.com/actana/control/issues/555)** with D27–D29 ("Landed by #555"), which only
> record what the Core's code does; nothing in D1–D26 is changed.
>
> **Amended by [#557](https://github.com/actana/control/issues/557)** with D30–D32 ("Landed by #557"), which record what
> the Files API does; D29 is superseded by D30, and nothing in D1–D28 is changed.
>
> **Amended by [#580](https://github.com/actana/control/issues/580) (T-404, 2026-10-02):** D30's alias of
> `/v1/projects/:id/files[/list]` is removed, and so is the Panel's `/api/cores/:id/projects/:id/files` route. Both are
> refused as unknown routes (D27): a `404`, with nothing read, listed or written.
>
> **Amended 2026-10-01 by [#562](https://github.com/actana/control/issues/562)** with D33 ("Landed by #562"). It
> **amends D25**: the Shared folder's sync runs as the daemon user `actana`, not as `core`, by the owner's ruling of
> 2026-10-01 (option A). Nothing else in D1–D32 is changed.
>
> **Amended 2026-10-02 by the release audit of [#552](https://github.com/actana/control/issues/552)** with D34–D42
> ("Landed by" #565, #569, #570, #563 and client#8, #564, #566, #572–#574 and #567). The audit found that tickets of
> the train settled in merged code questions this record still lists as open, so this amendment writes down what the
> merged code does and nothing else; it decides nothing new. It settles the Open items on the Files tab, the shape of
> an Agent and how a Task is dispatched, and the Report contract, and it marks D14 and D20 as now true of the Panel's code and
> dependency lists (D41 says what that leaves out). On where Remembered session settings live it only records what the code does
> (D42); that question stays open for the owner. It says where the code and an earlier clause
> disagree: D12 (D38) and the "dumb pipe" of ADR 0030 (D34). Nothing in D1–D33 is changed; D12, D14 and D20 each gain a pointer.

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

**D10 — `core` has no sudo.** Root is used only by the container's own startup. *What that startup is, and who the
other users are: D24.*

**D11 — The Core daemon runs as its own user, with its state outside `~`.** *Which user, which directory and what the
daemon holds: D24.*

**D12 — Deleting a Core removes the Core, its Shared folder and its S3 folder.** *What the Panel's delete does, and where that differs from this: D38.*

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
| ADR 0016 **D19** (the identity, config and SQLite in `core-home:/home/core`) | **Amended** | D11: the daemon's state lives outside `~`, in `/var/lib/actana` on its own volume (D24). |
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

- **Agent** is a Harness with its settings on a Core (#569). *Its shape: D35.*
- **Report** is what goes through the Shared folder (D7). Its contract is
  actana/client#8, and the Panel turns result files into Task status and
  comments (#570).

Neither definition says more than the tickets say. The rest is open, below.

## Open

These are not decided here. Each is the named ticket's to settle.

- **The shape of an Agent's settings**, and how a Task is dispatched to one
  (#569, #570). *Settled in merged code on 2026-10-01 and 2026-10-02: D35 (Agent) and D36 (dispatch).*
- **The Report contract** through the Shared folder: file names, layout and
  fields (actana/client#8). *Settled by client PR 41 and #563 (PR 621): D37. It fixes names, paths and an end marker, and no fields.*
- **The wire form of the rename** in D3, and what happens to core-link frames
  and the protocol version (#556). *Decided on 2026-09-30: a hard cut, D21.*
- **The new Files API address and its delete and create-folder routes** (#557). *Decided by #557: D30–D32.*
- **The Shared folder's change feed** and the mount mechanism (#561, #562).
- **How the Panel's Files tab reaches Shared-folder bytes**, and so whether the
  Panel remains a "dumb pipe" (ADR 0030) for them (#565). *Settled by #565 (PR 637, PR 640): D34. For these bytes it is not a dumb pipe.*
- **Where Remembered session settings live** (ADR 0017) now that the Project row
  they were stored against is gone. No ticket in #552 says. *Answered in code, not by a ruling: PR 622 (#560) keeps them in the browser: D42. The owner has not confirmed it.*
- **Which directory holds the daemon's state**, outside `~` (#559). *Decided on 2026-10-01: `/var/lib/actana`, D24.*
- **How the daemon starts Sessions as `core` and writes into `core`'s home.** D11 runs the daemon as its own user
  and D10 allows root only at container startup, so after startup the daemon has no root. Nothing in #552 says how
  it then starts a Session's PTY as `core` (D2) or writes into the workspace (D1). #559 owns it. *Decided on
  2026-09-30: two capabilities on the daemon, D25. The Files API is not part of it: it moves with #557.*
- **How an Agent relates to Remembered session settings.** Both are a Harness with settings. Only #569 defines
  Agent. *Still open after #569 (D35): no merged code connects the two (D42).*

## Amended by #567: the Panel's database is Postgres

Decided by the owner on 2026-09-30 ([#567](https://github.com/actana/control/issues/567), and
[#556](https://github.com/actana/control/issues/556) for D21). D8 already says the layers above a Core live in the
Panel (Postgres); these clauses say what that means for the Panel's own database. They are appended, so no earlier
number moves. D14–D20 come from #567. D21 comes from #556. D22 comes from #595. D23 comes from #605. This record only writes the decisions down. The code, the deploy files and the packages change in the
later pull requests of #567, and until they land the Panel still runs on SQLite.

**D14 — The Panel's state lives in Postgres only.** Every Panel table moves, including the Projects family, which
#560 then deletes on Postgres. No SQLite is left in the Panel's state. "Done" for #567 is that the Panel runs on
Postgres only. *Now true: D41.*

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

**D19 — The driver is `pg`. Unit tests use PGlite. One CI job runs against a real Postgres.** Any new or bumped
package (`pg`, PGlite, drizzle-kit) is a release at least 7 days old and pinned exactly. That rule is the owner's
workspace dependency policy (the Actana workspace `SECURITY.md`, rule 1: a release-age cooldown of at least 7 days for
any install). It is not written in this repository's own `SECURITY.md`. The owner's #567 comment sets the 7 days for
the Postgres image itself (D16).

**D20 — `better-sqlite3` leaves the Panel.** The Panel's provider-usage readers of other apps' SQLite files move to
`node:sqlite`. *Now true: D41.*

**D21 — The wire rename in D3 is a hard cut, with no alias (#556).** Frames, events, the DB and the SDK and CLI say
`sessionId` only. There is no `taskId` alias anywhere, including `session start --json`. The protocol version is
bumped, and a 0.5.0 Core and SDK do not talk to 0.4.x. 0.5.0 Cores are installed fresh. The SDK side is
actana/client#10.

**D22 — How the boot migration behaves (settled in [#595](https://github.com/actana/control/pull/595), PR 3 of #567).**
D17 did not say, so these rules come from that pull request and its review, not from the owner's comments. The owner
may change them by amending this record. (a) **Concurrent boots:** every Panel runs its pending migrations in one
transaction that first takes a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`, one fixed key). A
second Panel starting at once waits, then finds the first's rows and applies nothing. The lock goes with the
transaction, so a Panel that dies mid-migration releases it. (b) **A database that does not match the Panel:** the Panel
refuses to start, exits 1 and says why, when the database records a migration it does not ship (a newer Panel's, or a
downgrade), when a shipped migration's recorded hash differs (edited after it ran), or when an unapplied migration
sorts before one already applied. Migrations are matched by hash, never by the newest timestamp alone, so a migration
generated early and merged late is an error, not silently skipped. (c) **Done** (`packages/panel/src/db/pg-migrate.ts`: `SET LOCAL lock_timeout = '30s'` on the migration
transaction and a "waiting for the migration lock" log line before the wait), so a new Panel does not hang silently
behind a holder. (d) The migrations table is drizzle's own
(`drizzle.__drizzle_migrations`), so a role behind an external `AC_PANEL_DATABASE_URL` needs `CREATE` on the database.

**D23 — `owner_id` is a database foreign key to `operator.id` (settled 2026-10-01 in [#605](https://github.com/actana/control/pull/605), PR 3b of #567).**
The owner's decision on #567 ([comment of 2026-09-30](https://github.com/actana/control/issues/567#issuecomment-5918432919))
says "`owner_id` references `operator.id`". D15 repeated those words and the "Open questions" below recorded the
foreign key as not answered. The orchestrator's ruling, on the review of #605, is that "references" is read as a
foreign key: every owner-scoped table has `owner_id` as a `NOT NULL` column with a `REFERENCES operator (id)` constraint,
and the ownership guard (`packages/panel/src/db/__tests__/owner-guard.test.ts`) fails a table without one. The owner may
change this by amending this record. Row-level security stays out (D15), and the list of user-facing tables stays open.

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
  is also wanted was asked on #567 and not answered. Whether `owner_id` is also a database foreign key is settled
  in D23.
- **Which tables count as user-facing**, and so carry an `owner_id`. The #567 comment proposes cores, groups,
  projects, presentation, tasks, terminal logs and token usage. The owner did not confirm the list.
- **The exact `pg` version and the Postgres image tag and digest.** The #567 comment names `pg` 8.23.0. The pull
  request that adds each picks it under D16 and D19.
- **The name of the Postgres service and its volume, how the dump is taken and restored**, and whether the Panel
  image carries any Postgres client tool (D20 in ADR 0016 leaves nothing but Node in it).
- **How the boot migration behaves** when two Panel processes start at once, and when the database holds migrations
  newer than the Panel: settled in D22. The real-Postgres CI job still exists for pool and lock behaviour.
- **The Panel image's healthcheck** while the database is down (ADR 0016 D23), given that the Panel refuses to start
  without it.
- **What "refuse to start" does about a database that is up later**: exit and let the restart policy retry, or
  retry in process.

## Amended by #559: the Core container has two users

Decided by the owner on 2026-09-30 and 2026-10-01 ([#559](https://github.com/actana/control/issues/559)). They say
what D10 and D11 mean in the Core container image. They are appended, so no earlier number moves. The code and the
deploy files land in the five pull requests of #559: the state paths (#596), the one Core identity and `asCore`
(#597), the daemon's file work in `core`'s home (#602), the image, entrypoint and compose (#611, merged), and the
CLI and these docs.

**D24 — Two users, and the daemon's state in `/var/lib/actana`.** The container has two users. `actana` is the
daemon: a system user, uid and gid 1001. It owns `/var/lib/actana` (mode 0700, its own volume `core-state`), which
holds the pairing identity and pairings, the SQLite database, the update-check caches and, later, the Shared-folder
key (#561, #562). `core` is the Sessions' user: uid and gid 1000, the home `/home/core` (the `core-home` volume), the
work in `~`, `~/shared` and each Harness's own login. A Session, being `core`, cannot read `/var/lib/actana`. There is
no sudo and no setuid binary (D10). The only process that is ever root is the entrypoint script, before its `exec`;
tini is PID 1 as `actana` (uid 1001) with the same two ambient capabilities. Hooks a Session could not deliver are
noted in a drop box, `/run/actana/hook-misses.log`, which a Session can append to and the daemon reads as untrusted
input; nothing a Session can write goes in the state directory. On metal (`actana setup`) the daemon and the Sessions
stay one user, the operator, and this decision does not apply (the owner's D2 on #559). The state directory is built
by one helper (`packages/shared/src/actana-container-contract.ts`), so a later feature does not put its file under `~`.

**D25 — The daemon holds two capabilities and starts every Session as `core` through one wrapper.** The daemon keeps
`CAP_SETUID` and `CAP_SETGID` as its only capabilities, ambient, and no others. It starts every Session, every
`core exec` and every Harness process through `asCore`: `setpriv` with the uid and gid of `core`, supplementary groups
cleared, inheritable and ambient capabilities cleared and `no_new_privs` set. node-pty's own `uid` and `gid`
options are not used, because they keep the capabilities on the child. A Session therefore has no capabilities and
cannot gain any. Its bounding set stays the same two, which is inert with `no_new_privs` and no file capabilities (the
owner's D1). What the daemon does in `core`'s home (hook files, the skill folders, the registry blob, a cwd check, a
directory listing, a new folder, and the Harness CLI lookup `resolveCommand`) it asks a short-lived helper to do,
which runs through `asCore`. The writes and listings refuse any path that leaves the home; `resolveCommand` is a
deliberate unconfined read of PATH (the CLIs live in `~/.local/bin` and `/usr/local/bin`), so it is not confined to
the home. The Files API is not moved by #559: it moves to run as `core` together with #557 (the owner's D5). The
Shared folder is a userland sync, not a FUSE mount inside the Core, so the daemon keeps exactly two capabilities; who
runs it is amended by D33 (it was first written here as `core`).

**D26 — In the container, `docker exec` needs `-u`, and `actana pair` and `actana status` refuse anyone but
`actana`.** The container starts as root only for the entrypoint's step before the drop, so `docker compose exec`
without `-u` lands as root. That root has no capability to override file permissions, so it can read neither
`/var/lib/actana` nor `/home/core` (the owner's D3). The documented ways in are `docker compose exec -u core core
bash -l`, for work as a Session would do it (`-l` so `~/.local/bin` is on PATH; the image PATH is only
`/opt/actana/bin` and system directories), and `docker compose exec -u actana core actana pair new`, for the
daemon's own files. `actana pair` (`new`, `ls`, `revoke`) and `actana status` read the pairing material and store
from disk, which is only the daemon's user's to read, and a channel a Session could reach would let a Session mint
pairing codes. So in container mode they check the effective uid and, as anyone but `actana`, print one sentence
naming the exact command, exit non-zero and change nothing. Outside the container nothing is checked. The inside of
the container has no way to ask the daemon over a socket on purpose (the owner's D7).

## Landed by #555: what the Core does now

[#555](https://github.com/actana/control/issues/555) removes Projects from the Core. These are the rules it chose where
D1 and D2 did not say. The owner may change them by amending this record.

**D27 — A Core refuses what it no longer takes.** A `spawn` that carries a `cwd`, a `projectId` or any field outside a
fixed list is answered `spawnError` naming the field, and nothing is spawned. A list frame (`sessionRowsList`,
`archivedSessionRowsList`, `sessionsList`) or a `sessionsMutate` `create` that carries a field it no longer takes is
answered `error`, naming it. A frame the Core no longer handles (`projectsList`, `projectsMutate`) is answered
`error` with `unhandled frame type`. It is a refusal and not a silent ignore, so a 0.4.x client learns why, instead of
starting a Session somewhere other than where it asked. Since `@actana/sdk` 0.6.0-next.2 (protocol 0.19.0, 2026-10-01) the
codec no longer parses the two retired frames, so the Core names them from the refused text and still carries the caller's
`reqId`; any other frame the codec refuses is answered `invalid frame`. An SDK older than that still sends these fields and
cannot start a Session on a 0.5.0 Core.

**D28 — A database from before 0.5.0 is refused, not adopted.** The Core's database holds `sessions` and `event_log`
and nothing else. A boot that finds any other table, or a column of `sessions` it does not define, throws and says to
install fresh, before any DDL runs, and leaves the file as it found it. There is no migration (#552).

**D29 — The Files API serves the workspace under any id until #557.** *Superseded by D30: #557 re-addressed it.*
Its URL and the `outside-project-root` code are the published SDK's. The Core keeps answering them and no longer looks
an id up: every id reaches `~`, with one write lease for the Core. `project-not-found` is no longer sent. #557 re-addresses the surface.

## Landed by #557: the Files API at the home

[#557](https://github.com/actana/control/issues/557) re-addresses the Files API. D25 and the owner's D5 already said
it runs as `core`; these are the rules it chose where they did not say. The owner may change them by amending this
record.

**D30 — The Files API is `/v1/files?path=`, relative to `~` and confined to it.** Read, list, write (a single file, or
a tar unpacked with its tree), **delete** (a path ending in `/` deletes a folder and everything in it; a folder
without the slash, a slash on a file and the home itself are refused), **create folder** and **move** (a rename is a
move in the same folder; nothing is overwritten) all take a path relative to the home. An absolute path, a `..`
segment and a symlink that leaves the home are refused, on every operation, with the codes the published SDK lists
(`absolute-path`, `dot-dot-segment`, `outside-project-root`). mTLS and the Bearer check are unchanged. A link is read
through, but deleted, replaced and moved **as a link**: what it points at is never touched. All writes take the
Core's one write lease. `/v1/projects/:id/files` and `/v1/projects/:id/files/list` were an alias onto the same
handlers for the published SDK until #580 (T-404) removed them: they answer `404` like any unknown route (D27).

**D31 — Every Files operation runs as `core`, in a short-lived helper.** The daemon checks the Bearer, the route, the
method and the write lease, then starts `core-files-op.cjs` through `asCore` (D25) with one request line and the HTTP
body on its stdin; its stdout is the answer, a head line and then the body, relayed as it arrives. The daemon opens no
path in `~` for the Files API, so in the container it needs nothing it does not already hold, and the files a
transfer creates are `core`'s. A client that hangs up has the helper killed through `killAsCore`. Without a second
user (metal) the same code runs in the daemon. Confinement lives in the helper and runs as `core`, so it can do no more
than a Session can.

**D32 — The Files API keeps the SDK's refusal codes.** Delete, create folder and move add no code: they use
`bad-request`, `not-found`, `malformed-path` and `transfer-in-progress`, because the code list is the published SDK's
and is actana/client#10's to extend. The code for a path outside the home stays `outside-project-root`.

## Landed by #562: the Shared folder's sync runs as `actana`

[#562](https://github.com/actana/control/issues/562) puts the Shared folder in S3. The owner ruled on 2026-10-01
(option A) who runs the sync, which D25 had said. The owner may change it by amending this record.

**D33 — The Shared folder's sync runs as `actana`, so in the container no key is ever readable by `core`. This amends D25.** D25 said
the Shared folder is a userland sync run as `core`. It is run by the daemon user `actana` instead, because the
controller pushes the Core a short-lived S3 key (1 hour, limited to the Core's own prefix), and issue 562 requires that
no key on the Core is readable by `core`. The daemon stores the key in `/var/lib/actana` (D24; the file mode 0600, the
directory 0700, owned by `actana`) and replaces it on every push. There is no long-lived key on the Core and no key in
any config, environment or argument `core` can read. Still no FUSE and no new capability: the daemon keeps exactly
`CAP_SETUID` and `CAP_SETGID`. The sync talks S3 itself, with no AWS SDK and no rclone. Everything it reads or writes in
`core`'s home goes through the Files helper started by `asCore` (D31), with the confinement D25 and D30 already
enforce; the daemon never opens a path in `~`. The sync does not follow a symlink. When the key has expired (no
controller for more than an hour) the sync stops uploading and recovers on the next push. Unpair copies what is in S3
into the local folder and then stops syncing, so the folder keeps its contents. Deleting the S3 prefix of a deleted
Core is the controller's (#564). **The limit:** this holds where the daemon and `core` are two users, the container. On a single-user install
(`actana setup` on metal) they are one uid, a Session can read the key file in the daemon's data directory, and no decision
here can change that. The Core does not paper over it: it reports the folder as key-isolated (`ready.shared.keyIsolated`) only
when the users differ, and logs `shared-sync.key-not-isolated` when it takes a key otherwise. The owner's ruling that the sync
runs as `actana` where there are two users is unchanged. The change feed of D5 and D6 is unchanged: what the sync writes into `~/shared` is
seen by the watcher of #561 and becomes a `shared:changed` event like any other write.

## Landed by #565: how the Files tab reaches Shared-folder bytes

[#565](https://github.com/actana/control/issues/565) puts a Drive for the Shared folder on the Core page (PR 637, 1 of 2,
merged 2026-10-02; its Storage settings half is D39). PR 640 later changed its upload limit. The owner may change these
by amending this record.

**D34 — The Panel's server reads and writes Shared-folder bytes itself, in S3, with a key it holds; the browser never holds
one. This settles the Open item on the Files tab, and says the Panel is not a dumb pipe for these bytes.** The tab calls
Panel routes under `/api/cores/:id/shared/files` (list, details, media, download-url, search, summary, mkdir, upload,
rename, move, delete), each checked against the session's owner. The server opens the SDK's `CoreShared` in its S3 mode
(`createS3CoreShared`, `@actana/sdk/shared`) for that one Core, with the key the SDK issuer gives for that Core's folder only
(D38, D39: the master key stays on the Panel, and the key's life is the one D33 gives). The tab therefore works while the
Core is offline or paused. A download is the SDK's `signedUrl` for one object, valid 5 minutes (`DOWNLOAD_URL_SECONDS`),
and it is the only credential-bearing thing a browser receives; a preview is the Panel's own `/media` route, which returns
the bytes it read from S3. An upload is read into the Panel's memory, refused with 413 past the limit (checked against the
declared length and again as the body streams), and then put to S3 with the SDK, so the Panel holds one file at a time per
request. The Panel validates the path itself (no `..`, no absolute path, not the root for rename, move or delete) before
any key is issued. **The upload limit is stored (PR 640):** each request reads it from Storage settings (D39, default
512 MiB); the 100 MB constant `DEFAULT_UPLOAD_LIMIT_BYTES` applies only when no limit is stored (storage not set up yet). Task attachments
use the same stored limit. **Where this meets earlier clauses:** ADR 0030's "dumb pipe" (the Panel streams the Core's
workspace file bytes through with nothing buffered and no path validated) was about the Core's Files API (D30); the Panel's
route for it was removed by #580 (see the note on ADR 0030), and it is not true of the Shared folder, where the Panel buffers uploads, validates paths and reads S3 on its own.
D6 says the Shared folder is mounted from S3 with short-lived keys; the Panel does not mount it, it reaches the same
prefix as a client of S3, with its own key and not the Core's (D33).

## Landed by #569 and #570: Agents, and how a Task is dispatched

[#569](https://github.com/actana/control/issues/569) (PR 625, merged 2026-10-01) defines the Agent in Postgres.
[#570](https://github.com/actana/control/issues/570) (PR 629, merged 2026-10-01, and PR 640, merged 2026-10-02)
dispatches Tasks and reads their results. The owner may change these by amending this record.

**D35 — An Agent is a named harness plus a model and flags, on one Core, with no command in it. This settles the Open item
on the shape of an Agent's settings.** The `agents` table holds `id`, `owner_id` (to `operator.id`, D15 and D23), `core_id`,
`name`, `harness`, `model`, `flags`, `is_default` and the times. The harness is one of `claude-code`, `codex`, `cursor-cli`,
`opencode` or `pi`. The service accepts exactly `coreId`, `name`, `harness`, `model` and `flags`, and refuses any other
field. There is no command, argument, script or environment column, and no provider key can be stored. `model` must match a
plain model-id pattern; `name` is one line of up to 60 characters; `flags` are ids from a closed set (today only
`skip-permissions`, offered only for a harness that has an auto-mode flag), and the Core maps an id to the harness's own
flag at dispatch. A name is unique per Core. An Agent is created, and resolved, only if the Core reports its harness
`available` (the Panel asks again each time, with the `agentsAvailabilityList` frame). `listAgentsForCore` makes one default
Agent per available harness, once, and a partial unique index allows one default per harness per Core.

**D36 — A Task is dispatched by one conditional claim and a Session; its result is read from the Shared folder. This
settles the Open item on how a Task is dispatched.** Per Task, the Panel: (1) claims it with one
`UPDATE … WHERE status = 'assigned'` to `in_progress`, adding 1 to `attempt_count`, so of two racing dispatchers exactly one
wins; (2) resolves the Agent, asking its Core again; (3) on a re-run renames the older results to `attempt-<n>-<name>`;
(4) starts a Session with `CoreSession.start` (the public SDK, D9) over the Panel's own link; (5) writes one system comment
naming the Session. The prompt holds the Task, its comments and the result instructions: write `~/shared/tasks/<id>/success.md`,
`fail.md` or `partial-<n>.md`, last line `ACT-REPORT-END`. The Panel adds no standard block, because the Core appends its own
(D37). The watcher turns a finished result file newer than the dispatch time into one agent comment and one status move through
the Tasks service, so its rules for legal moves still apply. An agent that exits with no result, or a Task that runs out of
time, gets a `fail.md` written by the Panel and then fails the same way; a failed start moves the Task to `failed` with the
reason as `last_error`. **Which Shared mode the watcher uses changed between the two PRs.** PR 629 shipped the through-the-Core
mode in practice (a result is seen only while the Core is up) because no storage was configured yet. PR 640 makes the S3 mode the
default whenever storage is configured, with the same per-Core key as D34 asked again on each read, so a result is seen while the
Core is paused; the through-the-Core mode is the fallback when storage is not configured and for a Core that has no Shared folder.
**Two report paths reach one Session.** The Core's block (D37) names the Session's own `shared/sessions/<id>/report-1.md`; the
Task prompt names `tasks/<id>/…`. The Panel reads only the second. Nothing in the code reconciles the two, and the harness is told both.

## Landed by client#8 and #563: the report contract

Client [#8](https://github.com/actana/client/issues/8) (client PR 41, merge commit `ef8b3ff`) defines the report;
[#563](https://github.com/actana/control/issues/563) (PR 621, merged 2026-10-01) is the Core's half. The owner may change
these by amending this record.

**D37 — A report is a file in the Shared folder that ends with `ACT-REPORT-END`, and the Core appends a versioned block to a
Session's starting prompt only. This settles the Open item on the Report contract, and it fixes names and an end marker, not fields.**
A plain Session turn writes `sessions/<session-id>/report-<turn>.md`; a Task writes `tasks/<task-id>/success.md`, `fail.md` or
`partial-<n>.md`, with `attempt-<n>.log` for an attempt's log and `attempt-<n>-<name>` for an older result after a re-run. All
are relative to the Shared folder (`~/shared` on the Core). A report is finished when its last non-blank line is exactly
`ACT-REPORT-END`. The contract defines no fields inside a report. The client's `session wait` settles on that file through the
Shared watcher, not on a screen or a status. The Core's block (`prompt-standard-block.ts`, version 1) is one line saying the workspace is `~`, that
`~/shared` is shared and syncs within seconds, where this turn's report goes, its last line, and never to use sudo. It is appended once to a
starting prompt, as turn 1 (`appendPromptBlock`; a prompt that already holds a block of any version is returned unchanged), and a Session
started with no prompt gets none. When the Core reports the prompt delivered it records the block version on that Session row
(`sessions.prompt_block_version`, a fresh-install column). A follow-up `session send` is a raw write on the Core and gets no block there;
the client CLI appends the same block itself with the next turn's path, and a wording change bumps the version on both sides.
The Panel copies the Task paths and the marker into `shared/task-report.ts`, pinned by a test, because the CLI is not its dependency.
The end marker, the block's wording and the Core-side turn handling were the Core's choices where client#8 said only "a fixed last line".

## Landed by #564: pairing ends with the Shared folder

[#564](https://github.com/actana/control/issues/564) (PR 634, 1 of N, merged 2026-10-01). The owner may change these by amending
this record.

**D38 — The Panel holds the storage config and the master key; a pairing made from the Panel is not finished until the Shared
folder is attached; a delete empties only that Core's S3 prefix.** The config lives in `storage_config`, the master key sealed like
`core_secrets` (ADR 0011), write-only, with one reader: the SDK issuer's closure; no route, log line, error or frame carries it. A Core registered from the Panel stays
`pending` in `core_shared_folders` until `sharedAttach` succeeds. The pairing wizard's last step tests the folder (own folder
reachable, another Core's not), then finishes; finishing without storage is a 409 and the Core is sent nothing. The Panel pushes each
Core a fresh key over the core-link before the current one ends (at the SDK's refresh point, 15 minutes early), retries after 5 seconds, 15 seconds, 60 seconds and then every 300 seconds, the last delay repeating for as long as the push keeps failing (`RETRY_DELAYS_MS`), and shows the error on the Core. **Unpair** (`DELETE /api/cores/:id`) sends `sharedDetach`: the Core keeps `~/shared`,
the row is forgotten and the S3 prefix is left, which is D13. **Delete** (`POST /api/cores/:id/delete`, with the exact `<prefix>/<core id>/`
typed back) removes the Core row and empties only that prefix, and only after the Core answered `detached` or `not-attached`, or its key ran out;
otherwise it is a 409 and nothing is removed, since a Core still syncing would delete its own `~/shared` once the objects were gone.
**Where this differs from D12**, which says a delete removes the Core, its Shared folder and its S3 folder: the Panel empties the S3 folder and,
by design, does not empty the machine's `~/shared`. **The attach table:** `shared-folders-attach-table.test.ts` runs 64 rows against a model of the
Core's sync (a key push runs a deleting pass, a detach only copies S3 into the folder, a fresh attach never deletes). The rows differ by Core row
(exists, or mounted on an earlier deleted Core's folder), still attached, key valid or expired, S3 folder present or deleted, local folder with
contents or empty, and reachable or not; the Panel sees only reachability and how the Core answers, so they collapse into four actions: not connected
(32 rows, send nothing, stay `pending`), attach (16), detach then attach (8), and left as it is (8: still attached with an expired key, sent no key,
stays `pending` with the reason). In every row neither side deletes or empties data because the other is missing or empty. The way out of the last
action needs a Core that can detach without a key, which is a Core change not made here.

## Landed by #566: Storage settings and backends

[#566](https://github.com/actana/control/issues/566) part 2 (PR 636, merged 2026-10-02), on the config model of D38. The owner may change
these by amending this record.

**D39 — Settings › Storage configures one of four backends through the SDK's four issuers.** The backends are `seaweedfs` (the default),
`sts`, `supabase` and `r2`, each with the SDK issuer of that name (`@actana/sdk` 0.6.0-next.4). The master key is write-only: no route returns it
and the page shows only that one is set and when it was rotated. A Save that types a key while one is stored is refused and points at Rotate, which
replaces the key and re-issues every Core's key. A change of backend without new master material is refused, since a sealed key cannot move between
backends. Test connection issues a one-hour key and proves another Core's folder is unreachable, the same probe as pairing. The page lists each Core's folder size and key expiry from the
server, and holds the upload size limit (default 512 MiB) that D34 reads. The key's life is the SDK's (one hour, refresh 15 minutes early), shown, not stored.
**The `sts` and `supabase` tabs say they are not usable yet against a real service**, because one Endpoint field cannot be both the STS AssumeRole URL
(or the Supabase project URL) and the S3 API host; `seaweedfs` and `r2` are the ones that work. The form shows OIDC fields that screen 08 does not draw,
so the SeaweedFS issuer can be configured.

## Landed by #572, #573 and #574: API keys, the public API, MCP and webhooks

[#572](https://github.com/actana/control/issues/572) (PR 626, 632 and 641), [#573](https://github.com/actana/control/issues/573) (PR 633 and 641)
and [#574](https://github.com/actana/control/issues/574) (PR 628 and 641), all merged 2026-10-01 or 2026-10-02. They fill in what D8 lists as living in the Panel. The owner may change
these by amending this record.

**D40 — A key authenticates as its owner on an allow-listed set of routes; the public API, the MCP server and signed webhooks all sit on it.**
**API keys** (`api_keys`, `api_key_cores`, PR 626): `ak_<owner id>_<43 characters>`, the plaintext shown once, the row holding its sha256 and a display
prefix, compared with `timingSafeEqual`, revocable, scoped to all of the owner's Cores or chosen ones. A `Bearer ak_…` that is unknown, malformed or revoked is
a 401 and never falls back to the session cookie; a key on a route outside `API_KEY_ROUTES` is a 403; a call outside the key's Core scope is a 403. A key
creates and revokes no keys (session only). **The public API** (PR 632) is `/api/v1`: Cores, Agents, Tasks and comments, described by `openapi/v1.json`, every call
running as the key's owner; a key may ask a Task for the statuses `assigned` and `draft` only; `/api/tasks` stays session-only. **MCP** (PR 633) is `POST /mcp`, stateless
Streamable HTTP, written directly with no MCP library, key only, with nine tools (`list_cores`, `list_agents`, `get_tasks`, `get_task`, `create_task`, `assign_task`,
`comment_task`, `list_shared`, `get_shared`), each calling the same handler as `/api/v1`; the two Shared tools check scope, then owner, then the path, and read through the
through-the-Core mode of `CoreShared` (not S3, unlike D34) with size caps. **Webhooks** (PR 628) are https only, signed with HMAC-SHA256 (`X-Webhook-Signature`,
`-Timestamp`, `-Delivery`), for `task.created`, `task.updated`, `task.status_changed`, `task.deleted`, `comment.created` and `ping`, written to an outbox in the
same transaction as the change, delivered with private, loopback, link-local and similar addresses refused, the checked address pinned and redirects not
followed, retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours and then marked failed, and pruned after 14 days. A webhook may be limited to chosen Cores. The Settings › API &
integrations screen (PR 641) creates keys (plaintext once), restricts and revokes them, copies the MCP command, and creates, pings and deletes webhooks; webhook routes refuse an
API-key principal. It differs from screen 09: the key prefix is `ak_`, not `actk_`, and there is no "last used" because the schema has no such column.

## Landed by #567: Postgres only

[#567](https://github.com/actana/control/issues/567), PR 639 (merged 2026-10-02) and PR 643 (merged 2026-10-02).

**D41 — D14 and D20 are now true.** PR 639 moved the `missioncontrol.db` tables (`sessions`, `terminal_logs`, `home_terminals`, `app_settings`, `token_usage`,
`token_usage_rollup`, `token_usage_session_offsets`, `event_log`) to Postgres and deleted `db/client.ts`, the schema bootstrap and the legacy SQL migrations, so no Panel
state is in a SQLite file. `pg-schema.ts` holds no Projects table. PR 643 moved the three provider-usage readers (Cursor's `state.vscdb`, OpenCode Go's `opencode.db`,
Windsurf's `state.vscdb`) to `node:sqlite`, read-only with a 250 ms busy timeout, and removed `better-sqlite3` and its types from the dependency lists of the Panel's and the root's `package.json`. The root manifest still names it in the
`native:node:rebuild` script and in the build allow-list (`package.json:53`, `:95`).
**What this does not say:** the Panel's image is not shown to be free of it. The deploy installs the Core, so the Core's compiled copy may still sit in the image's tree, and the build stage still compiles it. The image smoke proves only that `better-sqlite3` cannot be resolved from the Panel (its own log line says the files "may remain under the Core's copy"), and whether the deploy should stop installing the Core is undecided. Also, `better-sqlite3` is still used by the Core and is declared as a `devDependency` of `packages/shared` (PR 643 added the declaration), which D20
(about the Panel) allows; `packages/panel/src/server/repositories/_sql.ts` still imports a type from `drizzle-orm/sqlite-core`, for a helper nothing uses. **Where the record and the
pull requests disagree on the count:** the intro to D14–D23 and the Consequences say #567 is seven pull requests; PR 639 calls itself "5 of 7" and PR 643 "6 of 6".

## Where Remembered session settings live: D42

**D42 — Remembered session settings are in the browser's `localStorage`, per Core, and no ruling put them there.** PR 622 (#560 PR 2, merged 2026-10-01) stores
`rememberHarnessSettings` and `savedHarness` under the key `mc:core-remember:<core id>` (`packages/panel/src/lib/core-remember.ts`). That is neither the Core, where ADR 0017 kept
them against the Project row so that every Panel saw the same choice, nor Postgres. The PR says itself that ADR 0041 left the home open and that it chose `localStorage` because the
Panel database was out of its boundary; no owner comment settles it, and the choice is a pull request's, not this record's. The file's own header says the same: "until a later ticket
picks a durable home". Two things follow from the code, not from a decision: the setting is per browser and not per account, and what it holds is the harness and the flag
that remembers it, which is not everything ADR 0017 lists (its default grid view is not in this file). The Open item stays open for the owner, and so does how an Agent (D35)
relates to it: nothing merged connects them.

## Consequences

- **#555 and #556 change the code to match** and #560 the Panel. They have landed: the Core, the Panel, the CLI and
  the SDK say Session and have no Projects, and `CONTEXT.md` says so.
- **Every later ticket in #552 cites this record** for the model.
- **A ticket that needs a decision changed amends this record rather than settling it in a comment.** This rule is
  from `docs/adr/README.md` and ADR 0024. It is new to this record and was not decided in #552 or #554.
- **#567 was planned as seven pull requests, and this record was the first.** Seven merged: #593 (this record),
  #594, #595, #605 ("3b of 7"), #616, #639 and #643 (the last, titled "6 of 6"). Each one built on D14–D21.
