# Spec — Remote Core write path: bootable Harness SQLite + project/session creation from the Panel

**Status:** needs-triage
**Date:** 2026-07-28
**Origin:** Field report — a Linux Harness installed per ADR 0003 spams `event-log.open-failed` (better-sqlite3 native binding missing) on every live-event poll tick, and the Panel cannot create Projects or Sessions against the remote Core at all.

---

## 1. Summary

A remote Core today is **read-only and, on Linux, broken at boot**. Two independent defects stack:

- **Defect A (boot blocker):** the Harness daemon on a Linux VM cannot open its SQLite — the Electron-ABI better-sqlite3 binding for `linux-x64-145` is absent from the installed package — so every 500 ms live-event poll logs `event-log.open-failed` and the Core serves empty data forever.
- **Defect B (the point-killer):** even with a working SQLite, a remote Core exposes **no write path**. The core-link protocol has no project/session creation frames, the Harness-side mutation handlers that do exist are stubs, no stateful server runs on the VM to own the schema, and the Panel UI has no creation affordance routed at a remote Core (Add Project silently creates *locally*).

CONTEXT.md is unambiguous about the target: the Harness bundle "contains the agent CLIs, the PTY manager, **and the stateful server (SQLite, hooks API, project registry)**" and "nothing task-shaped lives on the Panel." The remote install currently ships only the PTY manager + read-only queries. This spec closes that gap.

---

## 2. Investigation — evidence and root causes

### Defect A — `event-log.open-failed` spam on the remote Harness

Observed on the VM (Ubuntu, install at `/opt/mission-control`):

```
[harness] event-log.open-failed {
  dbPath: '/root/.mission-control/data/missioncontrol.db',
  error: 'Error: Electron better-sqlite3 native binding not found at
    /opt/mission-control/resources/app.asar/node_modules/better-sqlite3/bin/linux-x64-145/better-sqlite3.node.
    Run pnpm native:electron:sqlite.'
}
```

Root-cause chain, each link verified:

1. **All three Harness-side stores resolve the binding the same way.** `electron/better-sqlite3-native-binding.ts` (mirrored in `src/db/better-sqlite3-native-binding.ts`) computes `bin/<platform>-<arch>-<process.versions.modules>/better-sqlite3.node` from `require.resolve("better-sqlite3/package.json")` — i.e. a path **inside `app.asar`** — and *throws* if `fs.existsSync` fails. Called by `electron/event-log-store.ts:73`, `electron/harness-query-store.ts:70`, `electron/project-roots.ts:43`. The Harness runs as the packaged Electron binary under `ELECTRON_RUN_AS_NODE=1` (`harness-install-entry.ts:137-155`), so `process.versions.electron` is set and `process.versions.modules === 145` (Electron 41).
2. **The installed Linux package does not contain that file.** Verified against this repo's local `dist-electron-out/`: the `linux-unpacked` asar contains only `bin/darwin-arm64-145/better-sqlite3.node` — the **macOS** binding — because `pnpm native:electron` (`scripts/ensure-electron-sqlite.mjs`) builds for the **host** platform of whatever machine runs it. The AppImage in that directory was cross-built on the Mac via `pnpm dist:linux`. Cross-building a Linux artifact on macOS therefore always ships a Harness that cannot open SQLite. (CI `release.yml` builds linux-x64 on `ubuntu-24.04`, where `native:electron` does produce `linux-x64-145` — so release artifacts are *probably* fine; unverified, see open questions.)
3. **The resolver never looks in `app.asar.unpacked`.** electron-builder unpacks all `.node` files (kept inside the asar *and* copied to `app.asar.unpacked` on macOS — verified in `/Applications/MissionControl.app`). If the two ever diverge (observed: local `linux-unpacked/resources/app.asar.unpacked/...bin/linux-x64-145/` exists while the asar lacks it), the resolver still fails on the asar path. The macOS Panel works only because the file happens to be present at the asar-internal path.
4. **The spam rate is the live-event poll.** `PtyCoreLinkServer` starts a 500 ms poll per connection (`pty-core-link-server.ts:163,237`) → `pushLiveEvents` → `readEventTail` → `ensureConnection()` → throw → `log.error("event-log.open-failed")` (`event-log-store.ts:91`). No throttling exists on the open-failed path (only the db-*missing* path is throttled).
5. **Nobody owns the schema on the VM.** On a harness-only VM no stateful server process runs (`harness-install-entry.ts` spawns only `harness-entry.ts`), so nothing creates `missioncontrol.db` or runs the drizzle migrations. The stores gate on `fs.existsSync(dbPath)` and degrade to empty; even with the binding fixed, the `projects`/`tasks` tables will not exist. (On the reporter's VM the DB file exists — likely created by their manual shell experiments — which is why the log shows `open-failed` rather than the throttled `db-missing`.)

### Defect B — no write path to a remote Core

Verified by code exploration (file:line references):

1. **Protocol:** `src/shared/core-link-frames.ts` has no `projectsMutate`/`projectsCreate`/`sessionsCreate` frame. The only mutation frame, `tasksMutate`, is explicitly a schema placeholder ("handlers land incrementally", `core-link-frames.ts:126-131`).
2. **Harness handlers are stubs:** `electron/pty-core-link-server.ts:430-441` — `tasksMutate` → `{ task: null }`, `sessionsList` → `[]`, `hooksOp` → `[]`. Only `spawn`, `projectsList`, `tasksList` are real (the read-only issue-07 work).
3. **No stateful server on the VM:** `harness-install-entry.ts` starts only the Harness (PTY + core-link). `MC_API_URL` is optional/null in remote mode (`harness-entry.ts:77`). ADR 0001's "extract the stateful server into the Harness" never landed for the remote case — the loopback app still runs the server as a sibling process (`electron/server-runner.mjs`) that remote VMs don't have.
4. **Panel routes all mutations to the local loopback server:** `src/lib/api.ts` uses a single relative base URL; `ProjectDialog` has no Core concept; the global Add-Project hotkey creates locally even when a remote Core is selected. Remote views (`FleetView.tsx`) render live `projectsList`/`tasksList` results with **no creation affordances**. The renderer cannot even spawn a PTY on a remote Core — `RemoteCoreDialer`'s client surface exposes only `tasksList`/`projectsList`/auth/events (`electron/remote-core-dialer.ts:36-44`), and `TerminalPane` spawn paths are loopback `electron.pty` or the legacy Docker sandbox, never a remote Core.

**Verdict:** remote Cores today are list-only by construction; Defect A makes them not-even-that on Linux. Both must be fixed for "Mission Control with remote cores" to be usable.

---

## 3. Goals

1. A Harness installed per ADR 0003 on a fresh Linux or macOS VM boots clean: opens (and if needed creates + migrates) its SQLite, no error spam, serves `projectsList`/`tasksList` against a real schema.
2. The packaged artifact works **regardless of which OS built it** — cross-building Linux from macOS must not ship a broken Harness.
3. An operator can create a Project on a selected remote Core from the Panel UI (path validated by the Harness, per CONTEXT.md "a Project's path is a VM path").
4. An operator can create a Task + start a Session (PTY) on a remote Core from the Panel UI, with events flowing back over the existing event log / replay machinery.
5. The Panel's per-Core navigation (issue 07) gains creation affordances; nothing task-shaped is persisted on the Panel.

## 4. Non-goals

- Multi-user / multi-Panel writes to one Core (single operator fleet stays the model).
- Hooks ops (`hooksOp` handler) — still stubbed; separate ticket.
- Migrating the local loopback Core onto the new mutation frames (it can keep using the local HTTP API; the frames exist for remote Cores).
- Changing the registration blob / mTLS design (ADR 0002/0003 stand).

## 5. Proposed design (direction, to be grilled in tickets)

### 5.1 Fix the binding for real (Defect A)

- **Cross-target native prebuilds:** extend `scripts/ensure-electron-sqlite.mjs` (or add `native:electron:sqlite:targets`) so that when packaging for a non-host platform/arch (`dist:linux`, `dist:all`), it additionally fetches the Electron-runtime prebuild for each target via `prebuild-install -r electron -t <electronVersion> --platform <p> --arch <a>` (pure download — no toolchain needed — better-sqlite3 publishes Electron prebuilds) and stages it at `bin/<p>-<a>-<electronAbi>/better-sqlite3.node`. Wire into `dist:*` scripts and the release workflow so a macOS-built Linux AppImage carries `linux-x64-145`. Fall back to a hard build error (not a silently-broken artifact) when a target prebuild is unavailable.
- **Resolver robustness:** in `better-sqlite3-native-binding.ts` (both copies), also probe the `app.asar.unpacked` sibling path before throwing, and make the error message name the expected ABI/platform so future field reports are self-diagnosing.
- **Spam throttling:** throttle `event-log.open-failed` (and the sibling `*.open-failed` logs) the same way `db-missing` is throttled (first verbatim, then 1/60 s summary).
- **Release verification:** add a CI smoke step (linux leg) that runs the packaged Harness headless (`ELECTRON_RUN_AS_NODE=1` + harness-entry) and asserts `@@MC_HARNESS_LISTENING@@` with zero `open-failed` lines, so this regresses loudly.

### 5.2 Harness owns its schema (unblocks A and enables B)

- The Harness process gains DB bootstrap responsibility on VMs where no stateful server runs: open `missioncontrol.db` read-write (create if missing) and apply the same drizzle migrations the stateful server uses (`src/server/` bootstrap), before serving queries or appending events. Ownership rule per CONTEXT.md: the Harness machine owns its data; who *writes* (server sibling vs harness process) is an implementation detail the tickets decide — but on a harness-only VM the schema must come up without a second process.
- Keep the event-log two-writer WAL pattern (`event-log-store.ts` header comment) intact.

### 5.3 Core-link write frames + real handlers (Defect B, protocol)

- Add `projectsMutate` (create/rename/archive project; Harness validates the VM path) and make the existing `tasksMutate` real (create/update task rows), backed by the Harness's SQLite (or a VM-local stateful server if the ticket chooses to bundle `src/server` per ADR 0001 — decide in the first ticket, record as ADR 0004 if it changes ownership).
- Implement `sessionsList` for real (read sessions/tasks tables) so reattach works on remote Cores.
- Session creation = task creation (`tasksMutate`) + existing `spawn` frame with `taskId`; expose a remote `spawn` through the Panel-side dialer IPC surface (`electron/remote-core-dialer.ts`, `src/shared/electron-contract.ts` fleet section).

### 5.4 Panel creation UX routed per Core

- Per-Core navigation + Fleet view gain "Add Project" / "New Task" affordances that target the *selected* Core: mutations go over that Core's core-link; results arrive as live events (no Panel-side persistence — CONTEXT.md rule).
- The global Add Project dialog gains a Core selector (default: currently selected Core; loopback remains the default when no fleet exists).
- `TerminalPane` session spawn routes to the Core that owns the task instead of always using loopback `electron.pty`.
- Creating a project on an unreachable Core fails honestly with the existing "unreachable" treatment.

## 6. Acceptance criteria (feature level)

- [ ] Fresh Linux VM + `harness install` (ADR 0003 flow) → daemon boots, zero `open-failed` spam, `projectsList` returns `[]` against a migrated schema (not a missing DB).
- [ ] The above holds when the installed artifact was cross-built on macOS (`pnpm dist:linux`) and when built by CI on Ubuntu.
- [ ] From the Panel: select remote Core → Add Project → project appears in that Core's `projectsList` (and *not* in the local Core's).
- [ ] From the Panel: on a remote project → New Task → Session starts; PTY streams over the core-link; `pty:spawn`/task events replay after Panel reconnect via `lastEventId`.
- [ ] `tasksMutate`/`sessionsList` handlers are no longer stubs; unknown-ABI binding errors self-describe platform/ABI and are log-throttled.

## 7. Suggested ticket breakdown (to be filed under `.scratch/remote-core-write-path/issues/`)

1. **01 — Cross-target Electron sqlite prebuilds + resolver unpacked fallback + log throttling.** (Defect A, packaging/runtime.)
2. **02 — Harness-side DB bootstrap: create + migrate `missioncontrol.db` on harness-only VMs.** (Blocked by: 01.)
3. **03 — CI smoke test: packaged Harness boots clean on Linux (guards 01–02).** (Blocked by: 02.)
4. **04 — Core-link `projectsMutate` + real `tasksMutate`/`sessionsList` handlers, with ownership decision recorded (ADR 0004 if needed).** (Blocked by: 02.)
5. **05 — Panel: expose remote spawn + mutations through the fleet IPC/dialer surface.** (Blocked by: 04.)
6. **06 — Panel UI: Core selector in Add Project; per-Core/Fleet creation affordances; TerminalPane per-Core spawn routing.** (Blocked by: 05.)

## 8. Open questions

- Does the CI-built (`release.yml`, ubuntu-24.04) Linux artifact actually contain `bin/linux-x64-145`? Verify against the latest GitHub/academy AppImage before scoping ticket 01 — if CI is also broken, ticket 01 is release-blocking.
- Who created `/root/.mission-control/data/missioncontrol.db` on the reporter's VM (manual experiment vs a code path that creates the file without schema)? If a code path creates an empty DB, ticket 02 must handle "file exists, schema absent."
- Write ownership on the VM: extend the Harness process to write projects/tasks directly, or bundle the stateful server (`src/server`) as a second VM process per ADR 0001 and forward over loopback HTTP (the `core-link-frames.ts:126-131` comment assumes the latter)? Decide in ticket 04.
- Should `harness install` refuse to start (fail-fast) when the sqlite binding is missing, instead of booting into a degraded spam loop?

## 9. Immediate workaround for the reporter (no code change)

Use a **CI-built** Linux artifact (GitHub Release / academy), not a macOS-cross-built AppImage — or build the Linux artifact on a Linux machine/CI so `pnpm native:electron` produces the `linux-x64-145` binding. If the CI artifact is confirmed broken too, there is no workaround short of ticket 01.
