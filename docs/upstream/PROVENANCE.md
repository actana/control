# Provenance Map — Actana Control vs upstream Mission Control v0.49.0

> **Scope-narrowing note.** The fork is repositioned as **Actana Control**
> under specs [`docs/specs/`](../specs). The classifications below reflect
> the tree *before* those removal PRs merge. A forward-looking section
> at the end enumerates the REMOVED count deltas once they do.
> Historical name **Mission Control** is retained in this document
> where it names upstream's project.

Upstream: https://github.com/AgentSystemLabs/mission-control
BASE_SHA: `8dff848c1652c0bb5c3895d5dce28582219092b0` (= tag `v0.49.0` = upstream `origin/main` as of 2026-07-30).

**Divergence facts** (verified via `git` on 2026-07-30):

| | SHA | Date |
|---|---|---|
| BASE (merge base) | `8dff848c1652c0bb5c3895d5dce28582219092b0` = tag `v0.49.0` | committed 2026-07-27 09:25 -0400 |
| OURS HEAD | `0be731d5567e4d6e1162bf99031aacad4ec1e840` | 2026-07-29 18:28 +0200 |
| UPSTREAM HEAD | `8dff848` (identical to BASE) | 2026-07-27 09:25 -0400 |

- Commits on OUR side since BASE: **27** (`git rev-list --count 8dff848..HEAD`).
- Commits on UPSTREAM side since BASE: **0** on `main` (`git rev-list --count 8dff848..origin/main`). Upstream's only unreleased work is 8 open dependabot branches (see BACKLOG.md).
- Ancestry intact: `git merge-base HEAD 8dff848` = `8dff848` — no rebase/reset.
- Working tree: `main...azure/main [ahead 4]` (4 local commits not yet pushed to your Azure remote) + untracked `docs/upstream/` (this analysis) and 5 in-flight issue-note/ADR files under `.scratch/` and `docs/adr/0005-*`. No unstaged edits to tracked files.

## Classification

Every path is one of: UNTOUCHED / MODIFIED / REWRITTEN / NEW / REMOVED.
Note on REWRITTEN: no upstream file was *replaced wholesale*. The rewrite is topological — upstream's in-process PTY/data layer's **role** is filled by the new Harness/core-link design (all NEW files), while the upstream files that used to fill that role survive as MODIFIED integration points. Treat the union of `electron/pty-manager.ts` + `electron/main.ts` + `electron/preload.ts` + `electron/ipc-channels.ts` as the REWRITTEN seam.

### NEW — no upstream counterpart (the detached-core layer; **90 files** — `git diff --name-status 8dff848..HEAD | grep -c ^A`)

| Area | Paths | Note |
|---|---|---|
| Harness process | `electron/harness-entry.ts`, `harness-runner.mjs`, `install-runner.mjs`, `harness-install-entry.ts`, `harness-install.ts`, `harness-db-bootstrap.ts`, `harness-autostart.ts` | Standalone Node process owning PTYs + SQLite; install/registration flow |
| core-link protocol | `src/shared/core-link-frames.ts`, `core-link-bearer.ts`, `event-log.ts`, `harness-query.ts`, `harness-mutations.ts`, `registration-blob.ts`, `core-registry.ts`, `fleet-merge.ts`, `remote-core-dial-status.ts` | Self-contained frame schema (see core-link-frames.ts:20-21 — no `~/` imports by design) |
| Transport | `electron/pty-core-link-server.ts`, `pty-core-link-client.ts`, `core-link-node-socket.ts`, `remote-core-dialer.ts` | WS server in Harness; Panel client; mTLS dialer |
| Stores | `electron/core-registry-store.ts`, `event-log-store.ts`, `harness-availability-store.ts`, `harness-cert-material.ts`, `harness-material-store.ts`, `harness-query-store.ts`, `harness-mutation-store.ts` | Registry + secrets (safeStorage), event log, query/mutation ports |
| Renderer | `src/lib/core-pty-bridge.ts`, `selected-core-store.ts`, `subscribe-core-project-events.ts`, `mutate-project-for-core.ts`, `mutate-task-for-core.ts`, `use-fleet.ts`; `src/components/views/FleetView.tsx`, `CoresSettingsPage.tsx`, `ui/SessionIconPicker.tsx`; `src/routes/fleet.tsx` | Fleet view + per-Core navigation |
| Server | `src/server/event-log-recorder.ts` | Appends AppEvents to event_log |
| DB | `src/db/schema-bootstrap.ts` | Standalone-Harness schema creation |
| Build/CI | `scripts/ensure-electron-sqlite-targets.mjs`, `scripts/smoke-packaged-harness.mjs` | Cross-target sqlite prebuilds; packaged-harness smoke |
| Tests | `electron/__tests__/*` (13 new), `src/shared/__tests__/*` (7 new), `src/lib/__tests__/subscribe-core-project-events.test.ts`, `src/server/__tests__/event-log-recorder.test.ts` | |
| Docs | `CONTEXT.md`, `AGENTS.md`, `INSTALL.md`, `docs/adr/0002-core-link-auth-and-transport.md` (+ further ADRs) | Domain language + decisions |

### MODIFIED — upstream-derived, changed by us (**41 files** — `git diff --name-status 8dff848..HEAD | grep -c ^M`; representative below, not exhaustive)

| Path | Note (what changed) |
|---|---|
| `electron/main.ts` | Spawns Harness; registers core registry + RemoteCoreDialer (main.ts:49-58) |
| `electron/pty-manager.ts` | Refactored into harness-hosted PTY core |
| `electron/preload.ts`, `electron/ipc-channels.ts`, `electron/ipc-safe-handle.ts` | Core-registry/harness IPC surface added |
| `electron/project-roots.ts`, `agent-memory-brief.ts`, `better-sqlite3-native-binding.ts`, `recall-enabled.ts`, `electron/tsconfig.json` | Harness-aware config/binding resolution |
| `src/db/schema.ts` | **Additive only**: `event_log` table (schema.ts:494-519) + `EventLogRow` types (606-607); all upstream tables byte-identical |
| `src/db/client.ts` | Event-log accessors |
| `src/shared/electron-contract.ts`, `projects.ts`, `pty-spawn-policy.ts` | coreId / harness channel types |
| `src/lib/terminal-store.tsx` | Core-aware (imports `LOOPBACK_CORE_ID`, core-link snapshot types — terminal-store.tsx:29-30) |
| `src/lib/user-terminal-store.tsx`, `add-project-store.tsx`, `cli-availability.ts`, `optimistic-task.ts` | Core-aware routing |
| `src/components/views/`: `NewAgentDialog`, `ProjectBar`, `ProjectDialog`, `SessionGrid`, `SettingsPanel`, `TerminalPane`, `UserTerminalPane`, `UserTerminalPanel`, `settings-panel-ids.ts` | coreId props / Cores settings tab (the "Singular UI" invariant: same components, Core-scoped) |
| `src/routes/__root.tsx`, `index.tsx`, `projects.$id.tsx`, `src/routeTree.gen.ts` | Core provider, /fleet route |
| `src/server.ts` | Registers event-log-recorder |
| `src/queries/index.ts` | Core-aware selectors |
| `.github/workflows/ci.yml` | +1 step: packaged-Harness smoke (ci.yml:146-153); otherwise byte-identical to upstream |
| `.github/workflows/release.yml` | +harness smoke on linux leg (release.yml:236-240) + 2 cross-build smoke jobs (288-393) |
| `package.json` | +`selfsigned`, harness runner copy steps, `dist:*` sqlite targets (`remote-vm` script removed by spec 10) |
| `pnpm-lock.yaml` | Follows package.json |

### UNTOUCHED (**906 files** — 947 tracked in BASE − 41 modified = 906 unchanged)

Everything else: the vast majority of `src/components/`, `src/lib/`, server API controllers/hooks/services, `electron/` support files (update-manager, api-token-store, …), `build/`, `resources/`, upstream `scripts/`, `drizzle` config. These are the cheap-porting zone. **~96% of upstream code was UNTOUCHED at fork time — the divergence is smaller than it feels.** (The sandbox / remote-VM tract of that set — `electron/sandbox-*`, `src/server/services/sandboxes.ts`, `src/shared/sandbox*`, `Sandbox*` components, `scripts/remote-vm.mjs` — has since moved to REMOVED via spec 10.)

### REWRITTEN / REMOVED

- REWRITTEN (role-level): PTY + data-access ownership — see note above. No file qualifies individually.
- REMOVED: **0 files** — verified via `git diff --name-status 8dff848..HEAD | grep -c ^D` = 0. Also 0 renames (`^R`).

### Upcoming REMOVED (post-Actana Control removal PRs)

The nine specs under [`docs/specs/`](../specs) delete large tracts of the tree.
Voice / Whisper (spec 01) is removed in the fork — no `voice*` renderer
pipeline, `whisper-server`, `resources/whisper/`, mic entitlement, or
push-to-talk keybinding. Rough shape of the pending REMOVED set:

| Spec | Area | UNTOUCHED → REMOVED | MODIFIED → REMOVED | NEW → REMOVED |
|---|---|---|---|---|
| 01 | Whisper | voice UI + lib + audio assets | mic entitlement lines in `package.json` | `electron/whisper-server.ts`, `resources/whisper/*`, `scripts/fetch-whisper.mjs` |
| 02 | Pet + multiplayer | `src/components/pet/`, `src/lib/pet/`, `PetSettingsPage`, `src/shared/pet.ts`, `src/shared/academy.ts`, pet audio assets | — | — |
| 03 | Screenshot | `src/lib/screenshot*`, `Screenshot*` components, `screencapture` IPC in `electron/main.ts`, screenshot audio assets | `package.json` `build.mac.extendInfo` NSScreenCaptureUsageDescription | — |
| 04 | Recall + memory | `src/server/services/code-graph-*`, `recall-*`, `brief-*`, `RecallPanel/Modal/Settings`, project-memory queries, tree-sitter WASM in `dist/bundled-wasm/`, `bundled-mcp/recall-mcp.mjs`, `dist/bundled-skills/recall/` | `electron/recall-enabled.ts`, `electron/agent-memory-brief.ts`, `vite.config.ts` externals | — |
| 05 | Bundled skills + agent-session env | `dist/bundled-skills/diagram/`, `InstallDiagramSkill*`, `InstallShipSkill*`, `Ship*`, `DiagramDialog`, `src/shared/diagram*`, `skill-install-shared`, `src/server/services/install-diagram-skill.ts`, `src/server/controllers/diagrams.controller.ts`, `src/server/repositories/diagrams.repo.ts`, `src/server/services/diagram-store.ts`, `scripts/copy-bundled-skills.mjs` | `package.json` `mermaid` dep, agent-session env injection sites | `electron/ensure-diagram-skill.ts` |
| 06 | IDE-adjacent | `FileEditorDialog`, `FileFinderDialog`, `HtmlPreview`, `MarkdownPreview`, `AnnotationsPanel`, `MarkdownAnnotator`, related IPC in `electron/file-handlers.ts` (partial), preview loopback server code | `src/lib/project-fs.ts` (partial — retained briefly for the sandbox git path; spec 10 finished the job) | — |
| 07 | Convenience | `ScratchPad*`, `CustomScripts*`, `LaunchCommandsDialog`, `ScriptArgsModal`, `PromptSearch*` and backing queries/lib | — | — |
| 10 | Managed sandbox / remote VM (**landed**) | `src/server/services/sandboxes.ts` + `sandbox-scope.ts` + controller + repo, `src/shared/sandbox.ts` / `sandbox-agent-upgrade.ts` / `sandbox-workspace.ts`, eight `Sandbox*`/`ScopeDropdown` components, the sandbox client libs (`activate-sandbox-scope`, `sandbox-runtime`, `remote-vm-deploy`, …), `electron/sandbox-*.ts` (7 modules + 6 tests), `scripts/remote-vm.mjs` + `golden-ami-manifest.json`, `src/db/migrate-multi-sandbox.ts`, docs (`project-sandbox-aws-flow`, `digitalocean-sandboxes-plan`, `remote-vm-cli`, `daytona-hosted-removal-plan`) | `electron/main.ts` / `preload.ts` / `ipc-channels.ts` (48 channels), `src/shared/electron-contract.ts`, `src/db/schema.ts` (+ `sandboxes` table, `sandbox_id` / `scope_id` columns), `package.json` (`@agentsystemlabs/mission-control-agent` dep + `remote-vm` scripts) | — |
| 11 | Worktrees + git integration (**landed**) | `src/server/services/worktrees.ts` / `git.ts` / `_spawn.ts` + `worktrees.controller` / `git.controller` / `project-file.controller` + `worktrees.repo`, `src/shared/worktrees.ts` / `git-status.ts` / `github-pr.ts`, `src/components/views/GitDiffView/` (4 files) + `BranchTypeahead.tsx` + `WorktreeSetupCommandDialog.tsx`, `src/lib/git-diff-view-store.ts` / `use-worktrees-enabled.ts` / `worktree-live-activity.ts`, `src/queries/git.ts`, `docs/worktree-implementation-plan.md` | `src/db/schema.ts` (− `worktrees` table, `worktree_id` columns, `projects.branch` / `worktree_setup_command`), `src/server/api-router.ts` (− worktree/git/file routes), `src/lib/api.ts`, `src/queries/index.ts`, `src/routes/projects.$id.tsx`, keybindings (`git.diff`), settings surface (`worktreesEnabled`, `gitDiffChangedFiles*`, `selectedWorktreeByProject`) | — |
| 08 | Cross-core notifications | — (additive) | `src/lib/use-session-finish-notifications.tsx`, `src/lib/session-notification-store.ts` | — |
| 09 | Rebrand + auto-update | — | `package.json` (`name`, `productName`, `appId`, publish), window title, docs (`README`, `PRODUCT`, `SPEC`, `CHANGELOG`, `CONTEXT`), string surfaces in `src/` | `electron/update-manager.ts` (stubbed, not deleted) |

Once these merge:

- REMOVED count moves from **0** to roughly **150–200** files (order of magnitude — final count depends on how the specs consolidate overlapping deletions).
- MODIFIED count moves from **41** to **~55–65** (some UNTOUCHED files transition to MODIFIED via strip edits; a few MODIFIED files become REMOVED entirely).
- NEW count drops from **90** by ~5 (whisper-server, ensure-diagram-skill, and related NEW files that this fork itself added but that Actana Control removes).
- License attribution: the code volume marked "substantially upstream" shrinks proportionally, but the license posture is unchanged (MIT throughout).

Update this section with actual counts after the merges land. Recompute via `git diff --name-status <post-removal HEAD>..HEAD | awk '{print $1}' | sort | uniq -c`.

## Divergence — spec 04 (Recall + memory + code graph)

Landed under branch `actana/recall-memory`. Removed from the fork per
ADR 0007 scope narrowing:

- **Recall pillar (project memory + proactive per-turn injection):** all
  server services (`brief-delivery`, `proactive-recall`, `project-memory`,
  `recall-auto-distill`, `recall-engine`, `recall-settings`,
  `recall-transcript`), the project-memory controller/repo/shared module,
  the recall UI (`RecallPanel`, `RecallModal`, `RecallSettings`), the
  bundled MCP server (`bundled-mcp/recall-mcp.mjs`) + its skill payload
  (`.agents/skills/recall/`, `dist/bundled-skills/recall/`), electron
  install/uninstall helpers, the `memory:*` event variants, the
  `/api/projects/:id/memory[/…]` + `/api/memory/:id[/…]` +
  `/api/tasks/:id/brief` HTTP routes, the ten `recall*` `AppSettings`
  fields, and their query hooks.
- **Code Graph pillar:** the entire indexer/extractor/enumerator/source-
  resolver/staleness-checker/WASM-loader/watcher/auto-index service ring,
  its controller/repo/tests, its `graph:*` event variants, its HTTP
  routes, and the tree-sitter WASM (`@vscode/tree-sitter-wasm`,
  `web-tree-sitter`, `dist/bundled-wasm/`).
- **Schema:** `project_memory` + `project_memory_fts` + graph tables
  (`graph_nodes`, `graph_edges`, `graph_files`) are dropped by the
  boot-time cleanup in `schema-bootstrap.ts` (spec 04's AC-04-07);
  numbered migrations 0018–0022 are deleted outright per the fork's
  "we don't ship migration files to the user" convention.

Historical upstream references to Recall / project memory / code graph
are retained wherever they name upstream's design; only the fork's own
implementations and their carry-over comments are removed.

## License attribution flags

Upstream is MIT; OURS keeps `"license": "MIT"` (package.json:5). All 41 MODIFIED files remain substantially upstream code (most are >80% upstream by volume — e.g. `src/db/schema.ts` is upstream + one appended table; `ci.yml` is upstream + 8 lines). All 906 UNTOUCHED files are 100% upstream. **Any relicensing or attribution decision must treat the whole repo minus the 90 NEW files as upstream-derived.** The NEW detached-core layer (core-link, harness, fleet) is original work but imports upstream types (`~/db/schema`, `~/shared/domain`).
