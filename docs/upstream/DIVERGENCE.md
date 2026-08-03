# Architectural Divergence — upstream v0.49.0 vs Actana Control

> **Scope-narrowing note (2026-07-30).** The fork is repositioned as
> **Actana Control** — a harness remote control — with a smaller feature
> surface. Specs under [`docs/specs/`](../specs) and ADRs 0006–0009
> describe the removals. Until those PRs land, the classifications
> below still describe the current tree; a forward-looking section at
> the end enumerates the axis changes that will apply once they do.
> Historical name **Mission Control** is retained in this document
> because it references the upstream project by its correct name.

> **Electron-teardown note (2026-08-01).** Electron is gone from our side
> entirely (ADR 0010): the Panel is a self-hosted web service, and the
> loopback Core no longer exists. Every `electron/…` path named below as
> *ours* has moved — the Harness half to `packages/harness/src/`, the Panel
> half to `packages/panel/src/`, and the preload bridge to
> `packages/panel/src/lib/panel-bridge.ts` over the panel link. References to
> Electron as *upstream's* architecture remain accurate and are left as-is,
> which is the point of this document. The **Packaging & distribution** axis
> is now NON-EXISTENT on our side.

Verdicts: IDENTICAL (patches apply as-is) / COMPATIBLE (patches apply with mechanical adjustment) / INCOMPATIBLE (patches to this axis will not apply; reimplement or skip) / NON-EXISTENT (axis is being deleted; upstream patches to it are SKIP).

## Data model — COMPATIBLE
The task/project/session data model is upstream's, unchanged. Every upstream table in `src/db/schema.ts` is byte-identical; we appended one table, `event_log` (schema.ts:494-519), and `src/db/schema-bootstrap.ts` for standalone-Harness schema creation. Upstream schema migrations/patches port cleanly unless they collide with the appended tail of schema.ts.
**Named seams:** `eventLog` table, `EventLogRow`/`NewEventLogRow` types (schema.ts:606-607).

## Execution & control flow — INCOMPATIBLE (the core rewrite)
Upstream: Electron `main` owns the PtyManager; the renderer reaches it via `ipcRenderer.invoke` over channels in `electron/ipc-channels.ts` (`pty:spawn` etc.), exposed through `electron/preload.ts`.
Ours: PTYs live in a detached **Harness** Node process (`electron/harness-entry.ts`, spawned via `electron/harness-runner.mjs`), reached over a WebSocket **core-link** carrying multiplexed frames (`src/shared/core-link-frames.ts` — request/response with `reqId`, stream frames by `ptyId`, `subscribe` with `lastEventId` replay cursor). The Panel side bridges via `electron/pty-core-link-client.ts` and `src/lib/core-pty-bridge.ts`.
Consequence: **any upstream patch that touches PTY spawning, IPC channel wiring, or main-process PTY lifecycle will not apply.** Reimplement against the Harness.
**Named seams:** `electron/pty-manager.ts`, `electron/main.ts`, `electron/preload.ts`, `electron/ipc-channels.ts`, `CoreLinkPtySpawnOptions` union (core-link-frames.ts:27-50).

## Process/concurrency model — INCOMPATIBLE
Upstream is a 2-process app (main + renderer, plus its bundled server). Ours adds N Harness processes (loopback + remote), each owning its own SQLite and event log, with reconnect-replay semantics (monotonic `eventId`, CONTEXT.md "Event"/"Event cursor"). Upstream has no notion of events surviving a UI restart.
**Named seams:** `electron/event-log-store.ts`, `src/server/event-log-recorder.ts`, `src/shared/event-log.ts`.

## Data reads/writes — INCOMPATIBLE at the transport, COMPATIBLE at the semantics
Upstream renderer talks HTTP to the bundled server (`src/server.ts`). Ours routes queries/mutations for any Core through core-link ports (`electron/harness-query-store.ts`, `harness-mutation-store.ts`; renderer-side `src/lib/mutate-task-for-core.ts`, `mutate-project-for-core.ts`, `use-fleet.ts` + `src/shared/fleet-merge.ts`). The loopback path still exists, so *semantic* upstream fixes (e.g. "task status computed wrong") usually land in still-shared service code — check the touched file's provenance class first.
**Named seams:** `HarnessQueryPort` / `HarnessMutationPort` (consumed in `electron/pty-core-link-server.ts`), `src/queries/index.ts`.

## Auth — INCOMPATIBLE additions, upstream layer retained
Upstream: single API token in `app_settings` (`electron/api-token-store.ts`), passed to PTYs via env. We keep that (file unchanged) and add: HMAC-signed expiring bearer per Core (`src/shared/core-link-bearer.ts`), mTLS with self-signed pinned certs (`electron/harness-cert-material.ts`, `remote-core-dialer.ts`; ADR `docs/adr/0002-core-link-auth-and-transport.md`), secrets encrypted at rest via Electron safeStorage (`electron/core-registry-store.ts`, `harness-material-store.ts`). Upstream auth patches port; they just don't cover our remote surface.

## Public surface — INCOMPATIBLE additions
Upstream exposes no WebSocket server. Ours listens on `ws://127.0.0.1:<port>` (loopback) and `wss://` + mTLS (remote mode, `MC_HARNESS_REMOTE=1` in `electron/harness-entry.ts`), plus a registration-blob install flow (`src/shared/registration-blob.ts`, `electron/install-runner.mjs`). This surface is entirely ours to secure and version; upstream ships nothing for it.

## Configuration — COMPATIBLE
Upstream `app_settings` untouched. New Core registry is additive (`cores` + `core_secrets` via `electron/core-registry-store.ts`).

## UI — COMPATIBLE by design
The "Singular UI" invariant (CONTEXT.md): the same upstream components render every Core, threaded with `coreId` props. ~10 view files are MODIFIED (SessionGrid, TerminalPane, NewAgentDialog, ProjectBar, …), ~100 UNTOUCHED. Upstream visual/UI fixes are the **most portable category** — expect clean or near-clean application except where a diff hunk overlaps a coreId-threading line. New surfaces (`FleetView.tsx`, `fleet.tsx` route, `CoresSettingsPage.tsx`) are ours alone.
**Named seams:** `src/lib/terminal-store.tsx:29-30`, `src/routes/__root.tsx` (Core provider), `src/routeTree.gen.ts` (regenerate, never merge).

## Error handling / logging — COMPATIBLE
Upstream patterns kept; we added `electron/log.ts` + `log-throttle.ts` for harness log spam. No global change.

## Extension mechanism (skills/MCP) — IDENTICAL
No divergence found (bundled-skills copy, MCP resources).

## Packaging & distribution — NON-EXISTENT
Upstream ships a signed/notarized Electron desktop app via electron-builder and
an auto-updater. We ship a Panel service image plus a Harness tarball; the
electron-builder config, the per-OS installer pipeline, and the updater are
deleted (ADR 0010). Upstream patches to this axis are SKIP.

## Summary for porting
Portable as-is: UI components, lib utilities, server services, schema (additive), scripts, CI (modulo our extra smoke steps).
Never portable: anything touching PTY IPC, main-process PTY lifecycle, or single-machine assumptions ("the renderer can reach the DB/server directly").
The 51 MODIFIED files listed in PROVENANCE.md are the entire expected-conflict surface.

## Scope-narrowing deltas (post-Actana Control removal PRs)

Once specs 01–09 land, upstream patches to the following axes become **NON-EXISTENT** — no code to patch, so SKIP:

- **Voice / Whisper / STT** (spec 01). Entire subsystem removed; upstream `electron/whisper-server.ts`, voice UI, `voice-*` lib code, mic entitlements, `setup:whisper` script — gone.
- **Pet / mascot / multiplayer** (spec 02). `src/components/pet/`, `src/lib/pet/`, `src/shared/pet.ts`, `PetSettingsPage`, `src/shared/academy.ts` (entirely pet-related), pet `app_settings` keys — gone.
- **Screenshot capture / annotator** (spec 03). `src/lib/screenshot*.ts`, `Screenshot*` components, macOS `screencapture` IPC in `electron/main.ts`, `build.mac.extendInfo.NSScreenCaptureUsageDescription` in `package.json` — gone.
- **Code graph / Recall / Project memory** (spec 04). `src/server/services/code-graph-*`, `recall-*`, `brief-*`, `Recall*` components, `dist/bundled-wasm/`, tree-sitter deps, `recall_enabled` in `app_settings` — gone.
- **Bundled skills + MCPs + agent-session env injection** (spec 05, ADR 0006). `dist/bundled-skills/`, `bundled-mcp/`, `ensure-*-skill` electron modules, `InstallDiagramSkill*`/`InstallShipSkill*`/`Ship*`/`Diagram*` UI, `POST /api/diagram` endpoint, `mermaid` dep, `MC_API_URL`/`MC_API_TOKEN`/`MC_TASK_ID`/`MC_THEME` env injection, `task_diagrams*` tables — gone. The remaining `MC_*` prefix (`MC_TASK_ID`, `MC_HARNESS_REMOTE`, etc.) is the Harness ↔ Panel core-link contract; it renames to `AC_*` per spec 09 (the VM-agent wire contract it once also served is gone with spec 10).
- **IDE-adjacent** (spec 06). `FileEditorDialog`, `FileFinderDialog`, `HtmlPreview`, `MarkdownPreview` (confirmed safe to delete), `AnnotationsPanel`, `MarkdownAnnotator`, associated file-IO helpers — gone. (`src/lib/project-fs.ts` was briefly retained for the sandbox git path; spec 10 removed it too.)
- **Convenience** (spec 07). `ScratchPad*`, `CustomScripts*`, `LaunchCommandsDialog`, `ScriptArgsModal`, `PromptSearch*` — gone. Backing storage in `app_settings` and `user_terminals.start_command` handled per the spec.
- **Managed sandbox / remote VM** (spec 10, ADR 0009 — landed). The entire sandbox axis is NON-EXISTENT on the fork side: the `sandboxes` table and every `sandbox_id` / `scope_id` column, `src/server/services/sandboxes.ts` + controller + repo, `src/shared/sandbox*`, every `Sandbox*` / `ScopeDropdown` component, `electron/sandbox-*.ts`, the `sandbox:*` / `remoteVm:*` / `remotePty:*` / `remoteFs:*` / `remoteGit:*` IPC surface (48 channels), `scripts/remote-vm.mjs` + `scripts/golden-ami-manifest.json`, and the `@agentsystemlabs/mission-control-agent` dependency. **Any upstream commit touching these paths — or bumping the agent package version — is permanently SKIP.** Managed remote work is the detached-core Harness (ADR 0001–0004).
- **Theme axes** (spec 12 — landed). The multi-theme system is NON-EXISTENT on the fork side: the Panel renders the fixed Actana Studio look (Studio palette + JetBrains Mono) with dark/light/system as the only operator axis (`mc:theme` in localStorage, `.dark` class on `<html>`). Upstream commits touching the accent registry (`src/lib/accent-colors.ts`), the theme-style painter (`theme-style.ts`, `ThemeStylePreview`, painted/flat chrome), the surface-tint recipes (`surface-tint.ts`), the background-image uploader (`background-image.ts`), the background-grid toggle, the interface/terminal font settings (`interface-appearance.ts`, `terminal-appearance.ts`), the theme onboarding overlay, the launch "doors" overlay, `public/borders/`, or `scripts/gen-theme-images.mjs` are **permanently SKIP** — as are upstream additions to the fourteen dropped `app_settings` theming keys (guarded delete in `dropLegacyThemeSettings`, `src/db/schema-bootstrap.ts`). `src/styles.css` moves from "reconcile-carefully" to **fork-owned**: it is a ground-up rewrite around the Studio token block; upstream patches to it never apply. When the Studio palette itself changes, re-copy the `:root, .light` / `.dark` blocks from Studio wholesale — never merge upstream theme CSS.
- **Worktree management + git integration** (spec 11 — landed). The Panel's entire source-control surface is NON-EXISTENT on the fork side: the `worktrees` table and the `tasks`/`user_terminals` `worktree_id` columns plus `projects.branch` / `projects.worktree_setup_command`, `src/server/services/worktrees.ts` + `git.ts` + `_spawn.ts` + their controllers and repo, `src/shared/worktrees.ts` / `git-status.ts` / `github-pr.ts`, `src/components/views/GitDiffView/`, `BranchTypeahead.tsx`, `WorktreeSetupCommandDialog.tsx`, `src/lib/git-diff-view-store.ts` / `use-worktrees-enabled.ts` / `worktree-live-activity.ts`, `src/queries/git.ts`, the `/api/projects/:id/worktrees*` + `/api/projects/:id/git/*` + `/api/projects/:id/file` routes, and the `git.diff` keybinding. **Any upstream commit under these paths — or any migration creating/extending the `worktrees` table — is permanently SKIP.** Source-control decisions belong to the operator's tools on the Harness host (ADR 0007); Ship (an AI-session request) is the one retained adjacent surface. Grep exception: `src/lib/scoped-project.ts` keeps the frozen `${projectId}:main` scope-key literal (persisted UI state) with a comment naming the worktree era.

Axes affected but **not removed**:

- **Data model — moves to INCOMPATIBLE** for the KV rows and columns dropped by specs 02/03/04/05/07. Schema-bootstrap is the seam that carries the drops (per fork convention "we don't ship migration files to the user"), not numbered SQL files.
- **Configuration — moves to INCOMPATIBLE** for `app_settings` keys that are being dropped. Upstream additions to those keys are SKIP.
- **UI — moves to INCOMPATIBLE (subtractive)** for the ~40 view files being deleted. Upstream patches to any deleted component are SKIP; patches to retained components (SessionGrid, TerminalPane, ProjectBar, etc.) stay COMPATIBLE by design (Singular UI invariant retained).
- **Extension mechanism (skills/MCP) — moves from IDENTICAL to NON-EXISTENT.** ADR 0006 forbids Panel-installed skills; upstream additions to bundled skills/MCPs are SKIP.

Axes affected by the rebrand only (spec 09):

- **Product identity strings** (`productName`, `appId`, window title, docs) switch to Actana Control. Upstream string patches touching the old name apply as a mechanical adjustment.
- **Package identifiers.** `package.json` `name` moves `mission-control` → `actana-control`. The `@agentsystemlabs/mission-control-agent` dependency is **gone** (spec 10) — no `@qcentic/actana-control-agent` fork needs to be published, and upstream bumps to the agent package are SKIP.
- **Update / download host.** `agentsystem.dev` → `control.actana.ai`. Upstream references to the old host (currently in `README.md`, `package.json` `build.publish.url`, `electron/update-manager.ts` comment) are ADAPT.
- **Auto-update** disabled locally until `control.actana.ai` is live; upstream update-manager patches — ADAPT rather than PORT until re-enabled.

Once the removal PRs merge, revise the classifications at the top of this file and delete this section.
