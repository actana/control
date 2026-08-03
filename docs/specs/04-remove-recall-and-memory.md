# 04 — Remove Recall, Code Graph, and Project Memory

## Overview
Hard-fork removal of the merged Recall pillar: Code Graph indexing, Proactive
Recall (per-turn injected memory + code hits), Session Brief delivery, and
Project Memory (curated typed facts + FTS + manual notes). All three share the
same DB, settings namespace, MCP server, bundled skill, and UI surface, so they
are cut in a single sweep.

## Files to delete

### Server services
- `src/server/services/brief-delivery.ts`
- `src/server/services/code-graph-enumerate.ts`
- `src/server/services/code-graph-extract.ts`
- `src/server/services/code-graph-indexer.ts`
- `src/server/services/code-graph-source.ts`
- `src/server/services/code-graph-staleness.ts`
- `src/server/services/code-graph-wasm.ts`
- `src/server/services/code-graph.ts`
- `src/server/services/graph-auto-index.ts`
- `src/server/services/graph-watcher.ts`
- `src/server/services/proactive-recall.ts`
- `src/server/services/project-memory.ts`
- `src/server/services/recall-auto-distill.ts`
- `src/server/services/recall-engine.ts`
- `src/server/services/recall-settings.ts`
- `src/server/services/recall-transcript.ts`

### Server controllers + repos
- `src/server/controllers/code-graph.controller.ts`
- `src/server/controllers/project-memory.controller.ts`
- `src/server/repositories/code-graph.repo.ts`
- `src/server/repositories/project-memory.repo.ts`

### Shared modules
- `src/shared/code-graph.ts`
- `src/shared/project-memory.ts`
- `src/shared/agent-memory-file.ts` (the `<!-- mc:recall:start … -->` injector
  used only by the memory-brief path)

### UI
- `src/components/views/RecallPanel.tsx`
- `src/components/views/RecallModal.tsx`
- `src/components/views/RecallSettings.tsx`

### Electron
- `electron/agent-memory-brief.ts`
- `electron/ensure-recall-mcp.ts`
- `electron/ensure-recall-skill.ts`
- `electron/recall-enabled.ts`

### Bundled MCP + skill payloads
- `bundled-mcp/recall-mcp.mjs` (source)
- `dist/bundled-mcp/recall-mcp.mjs` (build artifact — coordinated with the
  copy-bundled-skills script edits in "Package.json edits")
- `dist/bundled-skills/recall/` (entire directory + all packaged copies under
  `dist-electron-out/**/resources/bundled-skills/recall/`)
- `dist/bundled-wasm/` (whole dir — tree-sitter grammars + `web-tree-sitter.wasm`
  are only used by the code-graph indexer)
- `.agents/skills/recall/` (source skill payload copied by
  `scripts/copy-bundled-skills.mjs`; delete if present)

### DB migrations (delete outright — pre-cutover data is dropped by 0025)
- `src/db/migrations/0018_project_memory.sql`
- `src/db/migrations/0019_code_graph.sql`
- `src/db/migrations/0020_project_memory_fts.sql`
- `src/db/migrations/0021_graph_edges_incremental.sql`
- `src/db/migrations/0022_graph_files.sql`

### Tests
- `src/server/services/__tests__/code-graph-brief.test.ts`
- `src/server/services/__tests__/code-graph-extract.test.ts`
- `src/server/services/__tests__/code-graph-fuzzy.test.ts`
- `src/server/services/__tests__/code-graph-indexer.test.ts`
- `src/server/services/__tests__/code-graph-source.test.ts`
- `src/server/services/__tests__/code-graph-staleness.test.ts`
- `src/server/services/__tests__/graph-auto-index.test.ts`
- `src/server/services/__tests__/graph-watcher.test.ts`
- `src/server/services/__tests__/proactive-recall.test.ts`
- `src/server/services/__tests__/project-memory-verify.test.ts`
- `src/server/services/__tests__/project-memory.test.ts`
- `src/server/services/__tests__/recall-auto-distill.test.ts`
- `src/server/services/__tests__/recall-bounded-maps.test.ts`
- `src/server/services/__tests__/recall-engine.test.ts`
- `src/server/services/__tests__/recall-transcript.test.ts`
- `src/server/__tests__/code-graph-api.test.ts`
- `src/server/__tests__/project-memory-api.test.ts`
- `src/server/__tests__/project-memory-live.test.ts`
- `src/server/__tests__/recall-mcp.test.ts`
- `src/db/__tests__/memory-fts-repair.test.ts`
- `src/shared/__tests__/code-graph.test.ts`
- `src/shared/__tests__/agent-memory-file.test.ts`
- `electron/__tests__/agent-memory-brief.test.ts`
- `electron/__tests__/ensure-recall-mcp.test.ts`
- `electron/__tests__/ensure-recall-skill.test.ts`
- `electron/__tests__/recall-enabled.test.ts`

## Files to modify

### `src/db/schema.ts`
- Delete the `projectMemory`, `graphNodes`, `graphEdges`, `graphFiles` table
  definitions (lines ~351–472) plus their `*Relations` blocks and the
  `ProjectMemory` / `NewProjectMemory` type exports (lines ~596–597).
- Drop the `MemoryType`/`MemoryStatus`/`MemoryConfidence`/`MemorySource`/
  `GraphNodeKind`/`GraphEdgeKind`/`GraphLanguage`/`GraphConfidence` imports if
  they came from `~/shared/project-memory` / `~/shared/code-graph`.

### `src/db/schema-bootstrap.ts`
- Remove the `project_memory` CREATE + 5 indexes (lines ~494–518).
- Remove the `graph_nodes`, `graph_edges`, `graph_files` CREATE + all their
  indexes (lines ~530–574).
- Remove the `graph_edges.is_member` `ensureColumn` + `graph_edges_dangling_idx`
  block (lines ~646–654).
- Delete `ensureMemoryFts` (lines ~716–776), `repairMemoryFtsIfCorrupt` (lines
  ~795–end of function), and every call site (line 668 and the try/catch that
  calls `repairMemoryFtsIfCorrupt`).

### `src/server/api-router.ts`
- Remove imports of `projectMemoryController` and `codeGraphController`.
- Delete the constants: `PROJECT_MEMORY_PATH`, `PROJECT_BRIEF_PATH`,
  `PROJECT_MEMORY_SEARCH_PATH`, `MEMORY_PATH`, `MEMORY_VERIFY_PATH`,
  `PROJECT_GRAPH_STATUS_PATH`, `PROJECT_GRAPH_SUMMARY_PATH`,
  `PROJECT_GRAPH_INDEX_PATH`, `PROJECT_GRAPH_INDEX_CANCEL_PATH`,
  `PROJECT_GRAPH_SEARCH_PATH`, `PROJECT_GRAPH_NODE_PATH`,
  `PROJECT_GRAPH_NEIGHBORS_PATH`, `PROJECT_GRAPH_PATH_PATH`,
  `PROJECT_GRAPH_IMPACT_PATH`, `TASK_BRIEF_PATH`.
- Delete every corresponding `if (m …)` route block (lines ~310–329, 348–366,
  and the `TASK_BRIEF_PATH` block near line 404).

### `src/server.ts`
- Remove `import { registerRecallAutoDistill } from "~/server/services/recall-auto-distill"`.
- Remove `import { registerGraphWatchCoalesce } from "~/server/services/graph-watcher"`.
- Delete the two registration calls (`registerRecallAutoDistill()`;
  `registerGraphWatchCoalesce()`) and the surrounding comment.

### `src/server/events.ts`
- Delete the `memory:created`, `memory:updated`, `memory:deleted`,
  `memory:learned`, `graph:index-progress`, `graph:indexed` variants from the
  `Event` union (lines 59–64) and any `GraphIndexProgress` import.

### `src/server/event-log-recorder.ts`
- Delete the comment reference to `registerRecallAutoDistill` /
  `registerGraphWatchCoalesce` (line ~27).

### `src/server/controllers/hooks.controller.ts`
- Remove imports of `maybeAutoIndexGraph`, `ensureGraphWatch`,
  `readRecallSettings`, everything from `./proactive-recall`,
  `briefDeliveredAt` from `./brief-delivery`, and any `markMemoriesUsed`.
- Delete the proactive-recall block (~lines 470–620) that force-loads Recall's
  deferred MCP tools, builds the per-turn recall block, and consumes
  `readRecallSettings().proactiveRecallEnabled`. This is the session-prompt
  context-injection hook the ADR called out.
- Delete `briefDeliveredAt(taskId)` call site (~line 586).
- Remove calls to `ensureGraphWatch` and `maybeAutoIndexGraph` from any
  post-tool-use / stop-hook branches.

### `src/server/controllers/settings.controller.ts`
- Remove import of `readRecallSettings`/`writeRecallSettings`.
- Delete every recall field from the Zod body schema (`recallEnabled`,
  `recallAutoCaptureEnabled`, `recallEngineEnabled`, `recallEngineHarness`,
  `recallEngineModel`, `recallAgentWriteEnabled`, `recallInjectBriefEnabled`,
  `recallCodeGraphEnabled`, `recallProactiveRecallEnabled`,
  `recallLearnedToastEnabled`) — lines ~309–318.
- Delete `recallSettingsPayload()` helper (lines ~662–675) and its spread into
  the GET response (line 632).
- Delete the `writeRecallSettings({ … })` block in the PATCH handler (lines
  ~966–977).

### `src/lib/api.ts`
- Delete imports from `~/shared/project-memory` (`MemoryCreateInput`,
  `MemoryUpdateInput`, `MemoryVerifyVerdict`, `MemoryView`).
- Delete every `recall*` field from the settings interface (lines ~235–249) and
  from the `Partial<>` union at lines ~773–782.
- Delete the "Recall — project memory" API block (lines ~486–527:
  `listMemory`, `searchMemory`, `createMemory`, `updateMemory`, `deleteMemory`,
  `verifyMemory`, `previewTaskBrief`, `previewProjectBrief`).
- Delete the "Recall — code graph" API block starting at line 545 (all
  `graphStatus`, `graphSummary`, `indexGraph`, `cancelGraphIndex`,
  `searchGraph`, `graphNode`, `graphNeighbors`, `graphPath`, `graphImpact`).

### `src/queries/index.ts`
- Delete the query-key builders `projectMemory`, `archivedMemory`,
  `memorySearch`, `graphStatus`, `graphSummary` (lines 60–66).
- Delete every hook/queryOptions definition (lines ~260–330):
  `projectMemoryQueryOptions`, `useProjectMemory`, `archivedMemoryQueryOptions`,
  `useArchivedMemory`, `memorySearchQueryOptions`, `useMemorySearch`,
  `graphStatusQueryOptions`, `useGraphStatus`, `graphSummaryQueryOptions`,
  `useGraphSummary`.

### `src/components/views/SettingsPanel.tsx`
- Remove `import { RecallSettingsPage } from "./RecallSettings"`.
- Delete the `"recall"` sidebar entry (lines ~263–267) and the
  `activePanel === "recall"` branch (lines ~338–339).

### `src/components/views/settings-panel-ids.ts`
- Remove `"recall"` from the panel-id union (line 16) and the
  `memory: "recall"` legacy alias (line 34).

### `src/components/views/GeneralSettingsPage.tsx`, `TerminalSettingsPage.tsx`, `ThemeSettingsPage.tsx`
- Remove every `recall*` key from the local settings state literal (each page
  has an identical 10-line block around lines 163–176 / 227–236). These pages
  otherwise stand.

### `src/routes/projects.$id.tsx`
- Remove `import { MEMORY_TITLE_MAX } from "~/shared/project-memory"` and
  `import { RecallModal } from "~/components/views/RecallModal"`.
- Delete `showRecall`, `setShowRecall`, `recallInitialFilter`,
  `setRecallInitialFilter` state (lines ~693–694).
- Delete the voice `remember` handler that calls `api.createMemory` and
  invalidates `queryKeys.projectMemory` (lines ~2104–2110) — this dies with
  voice/Whisper (see Follow-ups).
- Delete the `memory:*` event handler branch (lines ~2434–2459) that invalidates
  memory queries and pops the "Learned N memories" toast.
- Delete the "Recall" top-bar button block gated on `settings?.recallEnabled`
  (lines ~3211–3222).
- Delete the `<RecallModal … />` render (lines ~3958–3964).

### `src/lib/pet/pet-store.ts`
- Delete the `XP_MEMORY_LEARNED` constant (line 226), the `memoryLearned` entry
  in `PET_XP_AWARDS` (line 238), and the `case "memory:learned":` /
  `case "graph:indexed":` handlers (lines ~1159–1170).

### `src/components/pet/PetGuideModal.tsx`
- Delete the "Memory learned" award row (lines ~34–36) and the
  "Grows each time Recall learns a new memory" copy (line ~50).

### `src/shared/pet-remark.ts`, `src/shared/pet-tool-classify.ts`
- Strip the two comment mentions of Recall / recall tool-load (no behavioral
  change).

### `src/shared/agent-hooks.ts`
- Delete the two comments (lines ~8, ~43) referencing the Recall injected
  memory + code block; if any hook payload field carries recall context,
  remove it here and update the shared type.

### `src/server/repositories/prompts.repo.ts`
- Only touch if a JOIN or `RECALL_*` constant leaks in (grep hit was a comment;
  verify it's just prose and remove).

### `electron/pty-manager.ts`
- Remove the four recall imports at the top (`installAgentMemoryBrief`,
  `ensureRecallSkillForAgent`/`removeRecallSkillForAgent`,
  `ensureRecallMcpForAgent`/`removeRecallMcpForAgent`, `fetchRecallEnabled`).
- Delete the recall-skill/recall-MCP install block (lines ~654–661).
- Delete the `installAgentMemoryBrief({ … })` call (lines ~678–685).
- Update the comment on line ~643 to drop "recall/memory-brief".

### `src/lib/voice-intent.ts`
- Remove the `REMEMBER_RE` handling branch (lines ~209–215) and the
  `Save a fact about the current project to Recall` help entry (line ~382).
- Marked moot in Follow-ups: voice-intent goes away with Whisper (spec TBD).

## Schema changes

Drop from SQLite:
- **Tables:** `project_memory`, `project_memory_fts` (+ triggers
  `project_memory_fts_ai`, `project_memory_fts_ad`, `project_memory_fts_au`),
  `graph_nodes`, `graph_edges`, `graph_files`.
- **Indexes** (dropped automatically with tables, listed for completeness):
  `project_memory_project_idx`, `project_memory_project_scope_idx`,
  `project_memory_type_idx`, `project_memory_status_idx`,
  `project_memory_pinned_idx`, `graph_nodes_project_idx`,
  `graph_nodes_project_kind_idx`, `graph_nodes_project_name_idx`,
  `graph_nodes_project_file_idx`, `graph_nodes_project_degree_idx`,
  `graph_edges_project_idx`, `graph_edges_src_idx`, `graph_edges_dst_idx`,
  `graph_edges_project_kind_idx`, `graph_edges_dangling_idx`.
- **`app_settings` rows** (KV store — DELETE by key):
  - `recall_enabled`
  - `recall_auto_capture_enabled`
  - `recall_engine_enabled`
  - `recall_engine_harness`
  - `recall_engine_model`
  - `recall_agent_write_enabled`
  - `recall_inject_brief_enabled`
  - `recall_code_graph_enabled`
  - `recall_proactive_recall_enabled`
  - `recall_learned_toast_enabled`
  - Any stray `code_graph_state` row (legacy blob replaced by `graph_files` in
    0022; may still exist on old DBs).
- **`graph_edges.is_member`** column: not needed once table is dropped, but
  called out because `schema-bootstrap.ensureColumn` also adds it.

## Migration

New file: `src/db/migrations/0025_remove_recall_memory.sql`:

```sql
-- 0025 — Remove Recall + Code Graph + Project Memory.
-- Forward-only cutover. No feature flag, no back-migration.

-- FTS triggers first (safer before dropping their content table).
DROP TRIGGER IF EXISTS project_memory_fts_ai;
DROP TRIGGER IF EXISTS project_memory_fts_ad;
DROP TRIGGER IF EXISTS project_memory_fts_au;
DROP TABLE   IF EXISTS project_memory_fts;

DROP INDEX IF EXISTS project_memory_project_idx;
DROP INDEX IF EXISTS project_memory_project_scope_idx;
DROP INDEX IF EXISTS project_memory_type_idx;
DROP INDEX IF EXISTS project_memory_status_idx;
DROP INDEX IF EXISTS project_memory_pinned_idx;
DROP TABLE IF EXISTS project_memory;

DROP INDEX IF EXISTS graph_edges_dangling_idx;
DROP INDEX IF EXISTS graph_edges_project_idx;
DROP INDEX IF EXISTS graph_edges_src_idx;
DROP INDEX IF EXISTS graph_edges_dst_idx;
DROP INDEX IF EXISTS graph_edges_project_kind_idx;
DROP TABLE IF EXISTS graph_edges;

DROP INDEX IF EXISTS graph_nodes_project_idx;
DROP INDEX IF EXISTS graph_nodes_project_kind_idx;
DROP INDEX IF EXISTS graph_nodes_project_name_idx;
DROP INDEX IF EXISTS graph_nodes_project_file_idx;
DROP INDEX IF EXISTS graph_nodes_project_degree_idx;
DROP TABLE IF EXISTS graph_nodes;

DROP TABLE IF EXISTS graph_files;

-- Purge KV settings so a re-install doesn't reactivate anything phantomly.
DELETE FROM app_settings WHERE key IN (
  'recall_enabled',
  'recall_auto_capture_enabled',
  'recall_engine_enabled',
  'recall_engine_harness',
  'recall_engine_model',
  'recall_agent_write_enabled',
  'recall_inject_brief_enabled',
  'recall_code_graph_enabled',
  'recall_proactive_recall_enabled',
  'recall_learned_toast_enabled',
  'code_graph_state'
);
```

Note: SQLite `ALTER TABLE DROP COLUMN` on `graph_edges.is_member` is
unnecessary because the whole table is dropped. The DELETEs on `app_settings`
are safe on a fresh DB (WHERE matches nothing) and required on upgraded DBs.

Also: the existing `0018`–`0022` migration files are deleted outright (see
Files to delete), and `schema-bootstrap.ts` no longer creates any of these
tables — so a fresh install goes straight to the trimmed schema and 0025 is a
no-op there. An upgraded install runs 0025 to drop the pre-existing tables.

## MCP + bundled skill

Delete together (they only exist to serve Recall):
- `bundled-mcp/recall-mcp.mjs` (source stdio server exposing `mem_*` +
  `graph_*` tools).
- `dist/bundled-mcp/recall-mcp.mjs` (esbuild output).
- `dist/bundled-skills/recall/SKILL.md` and any siblings under
  `dist/bundled-skills/recall/`.
- All packaged copies under
  `dist-electron-out/*/resources/bundled-mcp/recall-mcp.mjs` and
  `dist-electron-out/*/resources/bundled-skills/recall/`.

Electron install/uninstall helpers go with them:
- `electron/ensure-recall-mcp.ts`, `electron/ensure-recall-skill.ts`,
  `electron/recall-enabled.ts`, `electron/agent-memory-brief.ts` — and every
  call site in `electron/pty-manager.ts` (see Files to modify).

Coordination with spec 05 (bundled skills): the recall skill is one of the two
skills currently in `BUNDLED_SKILL_NAMES`; spec 05 owns the "no bundled skills"
outcome but this spec removes recall specifically so spec 05 need only handle
the remaining diagram skill (and its own decision).

## Tree-sitter WASM

Tree-sitter is used exclusively by the code-graph indexer. Remove:
- `src/server/services/code-graph-wasm.ts` (already listed).
- `dist/bundled-wasm/` (whole dir: `tree-sitter-typescript.wasm`,
  `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`,
  `tree-sitter-python.wasm`, `web-tree-sitter.wasm`).
- Any packaged copy under `dist-electron-out/**/bundled-wasm/`.

`vite.config.ts` currently marks `web-tree-sitter` as external (`optimizeDeps.exclude`
and `rollupOptions.external`). Remove both references — with the dep gone,
declaring it external is a lie and Vite will warn.

`scripts/copy-bundled-skills.mjs` copies the grammar wasm; those blocks
(lines ~62–91 and the MCP esbuild block at 93–115) go too — that leaves the
script as diagram-only (or empty, per spec 05).

## Package.json edits

Dependencies to remove from `dependencies`:
- `@vscode/tree-sitter-wasm` (line 116)
- `web-tree-sitter` (line 139)
- `@modelcontextprotocol/sdk` — **verify** it's only pulled in for the recall
  MCP server (`bundled-mcp/recall-mcp.mjs`); if any other consumer exists,
  keep it.

Build config to update:
- `extraResources[]` block for `dist/bundled-mcp` (lines ~211–216): drop the
  whole entry if the recall MCP was the only bundled MCP. `dist/bundled-mcp`
  will be empty otherwise.
- `build:web` script: keep the call to `copy-bundled-skills.mjs` only if
  another bundled skill survives; otherwise drop the trailing
  `&& node scripts/copy-bundled-skills.mjs` (coordinated with spec 05).

## Env vars / IPC channels

- **Env vars:** grep shows no `RECALL_*` env vars — Recall's on/off is entirely
  driven by the `recall_enabled` row in `app_settings`, read by
  `electron/recall-enabled.ts` over HTTP (`GET /api/settings`). Deleting that
  file + the settings field is sufficient; no env cleanup needed.
- **IPC channels:** no dedicated Electron IPC handlers for recall (the PTY
  manager consumes settings via HTTP inside the same process). Nothing to
  unregister on the main-process side beyond deleting the four electron
  modules.
- **HTTP endpoints removed** (already covered under `api-router.ts` edits):
  `/api/projects/:id/memory[/…]`, `/api/memory/:id[/verify]`,
  `/api/projects/:id/brief`, `/api/tasks/:id/brief`,
  `/api/projects/:id/graph/…`.
- **MCP tools removed** (once `recall-mcp.mjs` is gone): all
  `mcp__recall__mem_*` and `mcp__recall__graph_*` tools; the "load recall's
  deferred MCP tools" one-shot injection also goes with hooks.controller.

## Keybindings

No dedicated recall/memory/code-graph bindings live in
`src/lib/keybindings/defaults.ts` (verified). No changes required. The Recall
top-bar button is opened by direct click, not a bound `HotkeyAction`.

## Tests to remove

Enumerated under "Files to delete → Tests". After removal:
- `src/server/__tests__/settings-api.test.ts` still references
  `recallEnabled: false` in three cases (lines 201, 215, 229, 234, 248, 252,
  271). Delete those cases (or trim them) — do not delete the whole file; it
  covers non-recall settings too.
- `src/server/__tests__/agent-hooks-api.test.ts` references
  `mcp__recall__graph_search` at line 603 and imports `resetBriefDeliveries`
  at line 16. Delete both.

## Verification checklist

- `rg -i "\brecall\b" src electron bundled-mcp scripts` returns zero matches
  (case-insensitive, excluding node_modules/dist-electron-out build artifacts).
- `rg "codeGraph|code_graph|code-graph|graphNodes|graphEdges|graphFiles" src electron`
  returns zero.
- `rg "briefDelivery|brief_delivery|BriefDelivery|previewBrief|SessionBrief"
  src electron` returns zero.
- `rg "memoryFact|memoryFacts|projectMemory|project_memory|MemoryView|
  MemoryCreateInput" src electron` returns zero.
- `pnpm build` and `pnpm build:web` succeed with no missing-import / dead-import
  errors (in particular Vite must not warn about
  `web-tree-sitter` being externalized when the dep is gone).
- `pnpm test` green: no test file imports a deleted module; the trimmed
  `settings-api.test.ts` and `agent-hooks-api.test.ts` pass.
- Agent PTY spawn end-to-end: no memory-brief block is written into
  `CLAUDE.md` / `AGENTS.md`, no `mcp__recall__*` tool-load nudge appears in
  the first-turn context, and the fresh session env has no recall-derived
  fields.
- Settings UI has no "Recall" sidebar item and no orphan `recall*` state keys
  in the general/terminal/theme pages (compile-time check via the settings
  interface no longer having those fields).

## Follow-ups / out of scope

- **Voice / Whisper (spec TBD):** `src/lib/voice-intent.ts` has a
  `REMEMBER_RE` branch that only made sense with Recall. The Whisper-removal
  spec should delete `voice-intent.ts` entirely, so leaving a stub here is
  fine — but the `remember`-kind consumer in `routes/projects.$id.tsx`
  (`api.createMemory` call) MUST be removed in this spec because it references
  an API surface that no longer exists.
- **Bundled skills (spec 05 — no-bundled-skills):** the recall skill is one of
  the two entries in `BUNDLED_SKILL_NAMES`; this spec strips `"recall"` from
  that array and deletes its payload directories. Spec 05 owns the ultimate
  decision on the remaining `diagram` skill and the fate of
  `scripts/copy-bundled-skills.mjs`, `dist/bundled-skills/`, and the
  `extraResources` bundled-mcp block. Land 04 before 05.
- **`app_settings` KV cleanup on fresh install:** the DELETE in migration 0025
  is a no-op on a fresh DB, but on upgraded DBs it purges phantom rows so a
  future rename doesn't collide. Confirm this matches the migration policy
  the domain doc lays out (`docs/domain-model.md`).
- **Pet system:** `memory:learned` / `graph:indexed` event cases in
  `pet-store.ts` and the `memoryLearned` XP award were the last consumers of
  those two event types. If the pet system stays (see ADR 0007 scope), it
  loses two award kinds; if it is being cut in a later spec, coordinate to
  avoid double-editing `pet-store.ts` and `PetGuideModal.tsx`.
- **`agent-memory-file.ts` (`<!-- mc:recall:start -->` markers):** deleting
  this shared module means an upgraded checkout may still contain stale
  managed blocks in a project's `CLAUDE.md` / `AGENTS.md`. No cleanup pass is
  planned — the marker text is harmless prose without the injector. Flag if
  UX wants a one-shot removal utility.
