# 06 — Writes: mutations + Harness folder browser

**What to build:** All write operations work from the browser over the panel link: create project, start session (NewAgentDialog with Harness-published CLI availability), rename/pin/icon mutations — every write routed as mutation frames to the owning Harness (ADR 0004 upheld; the loopback HTTP write path is not used). Adding a project uses a folder-tree picker dialog backed by new core-link directory-listing frames (list, create folder) served and validated by the Harness; typing a path remains the fallback, validated Harness-side.

**Blocked by:** 04 — Panel link + live read path.

**Status:** done — on branch `wt-e06` (2026-07-31), not merged

- [x] Create project via the folder picker on a remote Core; the tree browses the Harness's filesystem, never the Panel's or the browser's machine
- [x] Typed paths validate on the Harness with clear errors for missing/invalid paths
- [x] Start session works with availability pre-checked; submit blocked when the CLI is missing
- [x] Pin, rename, and session-icon mutations round-trip and appear in a second tab (Harness-owned state)
- [x] All writes travel as core-link mutation frames; no write path touches the old loopback HTTP API

## Notes

- Two new core-link frames — `dirList` / `dirCreate`, with `dirListResult` /
  `dirCreateResult` — take the protocol to 0.9.0. Failures come back as the
  ordinary `error` frame carrying the message the operator should read, so the
  Panel's request path rejects rather than handing the picker a result to
  inspect. `packages/harness/src/directory-browse.ts` is the whole back end
  (ported from the Electron `dialog:listFolders` handler) and re-checks every
  name the picker pre-filters.
- `FolderBrowser` now takes a `coreId` and walks that Core's disk over the
  panel-link bridge. Both edit dialogs pass the owning Core down, so editing a
  project browses the machine the project actually lives on.
- `mutateProjectForCore` / `mutateTaskForCore` lost their transport branch:
  they take a `coreId` and a mutation, and that is all a call site knows. Every
  write in scope — project create, session create, pin, rename, session icon —
  goes through them. `api.createProject` and `api.createTaskInternal` are no
  longer reachable from the UI.
- Project rename sends `projectsMutate {op: "rename"}` and *also* keeps the
  Panel-local PATCH for the fields the frame does not carry (group, image,
  launch URL). Project `icon` / `iconColor` are on the Harness row but have no
  patch op — changing them in the edit dialog still only moves Panel-local
  state. Growing the frame is a follow-up, not this ticket.
- The session warm pool is gone from the project route. It pre-spawned through
  the in-process loopback core-link and persisted its row with
  `api.createTaskInternal` — the last HTTP write on the session-create path.
  `session-warm-pool.ts` still exports the payload helpers the route uses; the
  pooling half is now unreferenced and goes with 08.
- Creating a project now lands on `/fleet` for every Core. Two things went with
  the loopback branch that carried them: the "start this agent right after
  creating" onboard intent, and the project image upload (it wrote through
  `electron.saveProjectImage`, which has no browser equivalent). Both want
  restoring once per-Core project navigation is the only navigation.
- Archive / delete / restore / path-repair still call the Panel's local HTTP
  API. They are outside this ticket's named write set and go with the wider
  loopback teardown (08).
- Seam: `packages/panel/src/server/panel-link/__tests__/write-path.test.ts`
  drives a browser tab against a real mTLS Harness — creates a project at a
  path that machine validates, starts a session, pins/renames/re-icons, reads
  the same state back from a second tab, and walks and mutates the Harness's
  real filesystem.
