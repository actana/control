# Tickets — Spec 04 (Remove recall + memory + code graph)

Parent spec: [`../specs/04-remove-recall-and-memory.md`](../specs/04-remove-recall-and-memory.md).

Seven tickets. Ordered so each PR leaves `typecheck` and `test` green.
Mirrors the shape used by [`01-whisper.md`](./01-whisper.md) and
[`02-pet.md`](./02-pet.md): outward UI callers first, then the WASM /
tree-sitter / code-graph service ring, then the atomic core
(`AppSettings` + controller + shared types), then MCP + bundled skill
payloads, then styles / comments cleanup, then the schema-bootstrap
boot-time DELETE + table drop.

---

## AC-04-01 — Unmount recall UI + routes + query hooks

**Depends on:** —

**Summary.** Cut the renderer surface first without touching the server,
DB, MCP, or `AppSettings` type. After this ticket nothing in the Panel
renders `<RecallPanel>` / `<RecallModal>` / `<RecallSettings>`, the
"Recall" sidebar entry is gone, the top-bar Recall button is gone, the
project route no longer subscribes to `memory:*` / `graph:*` events, and
no component calls `api.listMemory` / `api.graphStatus` / friends — but
the settings interface still declares `recall*` fields and the server
still exposes `/api/projects/:id/memory[/…]`. Those come out in AC-04-03.

**Files touched (indicative).**
- Delete: `src/components/views/RecallPanel.tsx`,
  `src/components/views/RecallModal.tsx`,
  `src/components/views/RecallSettings.tsx`.
- Modify: `src/components/views/SettingsPanel.tsx` (drop
  `RecallSettingsPage` import, the `"recall"` sidebar entry, and the
  `activePanel === "recall"` branch),
  `src/components/views/settings-panel-ids.ts` (drop `"recall"` from the
  panel-id union and the `memory: "recall"` legacy alias),
  `src/routes/projects.$id.tsx` (drop `MEMORY_TITLE_MAX` /
  `RecallModal` imports, the `showRecall` / `setShowRecall` /
  `recallInitialFilter` / `setRecallInitialFilter` state, the voice
  `remember` handler that calls `api.createMemory`, the `memory:*` event
  handler branch that pops the "Learned N memories" toast, the "Recall"
  top-bar button block gated on `settings?.recallEnabled`, and the
  `<RecallModal … />` render),
  `src/queries/index.ts` (drop query-key builders `projectMemory`,
  `archivedMemory`, `memorySearch`, `graphStatus`, `graphSummary`, and
  the hook/queryOptions definitions `projectMemoryQueryOptions`,
  `useProjectMemory`, `archivedMemoryQueryOptions`, `useArchivedMemory`,
  `memorySearchQueryOptions`, `useMemorySearch`,
  `graphStatusQueryOptions`, `useGraphStatus`,
  `graphSummaryQueryOptions`, `useGraphSummary`).

**Acceptance criteria.**
- `rg "RecallPanel|RecallModal|RecallSettingsPage|showRecall|recallInitialFilter|MEMORY_TITLE_MAX"`
  returns zero hits in `src/`.
- `rg "projectMemoryQueryOptions|useProjectMemory|archivedMemoryQueryOptions|useArchivedMemory|memorySearchQueryOptions|useMemorySearch|graphStatusQueryOptions|useGraphStatus|graphSummaryQueryOptions|useGraphSummary"`
  returns zero hits in `src/`.
- Settings panel still opens; "Recall" tab absent; project route mounts
  without the top-bar Recall button.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The `recall*` fields on the `AppSettings` interface stay
until AC-04-03; nothing in the renderer reads them after this ticket, so
compile is happy. The voice `remember` branch is deleted here rather
than deferred to spec 01 because it calls `api.createMemory`, which is
removed in AC-04-03 — leaving it would break typecheck for spec 01's
consumers.

---

## AC-04-02 — Delete code-graph service ring + tree-sitter WASM + graph auto-index

**Depends on:** AC-04-01

**Summary.** Cut the whole code-graph engine and its tree-sitter
foundation as a single unit — the indexer, extractor, enumerator,
source resolver, staleness checker, WASM loader, watcher, and
auto-index registration all only exist to serve each other. Removes the
`web-tree-sitter` / `@vscode/tree-sitter-wasm` deps, deletes
`dist/bundled-wasm/`, and prunes `vite.config.ts` so it stops declaring
a now-absent module as external. The controller, HTTP routes,
`AppSettings` fields, and MCP tools all still exist after this ticket —
they get torn out in AC-04-03 and AC-04-04.

**Files touched (indicative).**
- Delete: `src/server/services/code-graph.ts`,
  `src/server/services/code-graph-enumerate.ts`,
  `src/server/services/code-graph-extract.ts`,
  `src/server/services/code-graph-indexer.ts`,
  `src/server/services/code-graph-source.ts`,
  `src/server/services/code-graph-staleness.ts`,
  `src/server/services/code-graph-wasm.ts`,
  `src/server/services/graph-auto-index.ts`,
  `src/server/services/graph-watcher.ts`,
  `src/shared/code-graph.ts`,
  `src/server/services/__tests__/code-graph-brief.test.ts`,
  `src/server/services/__tests__/code-graph-extract.test.ts`,
  `src/server/services/__tests__/code-graph-fuzzy.test.ts`,
  `src/server/services/__tests__/code-graph-indexer.test.ts`,
  `src/server/services/__tests__/code-graph-source.test.ts`,
  `src/server/services/__tests__/code-graph-staleness.test.ts`,
  `src/server/services/__tests__/graph-auto-index.test.ts`,
  `src/server/services/__tests__/graph-watcher.test.ts`,
  `src/shared/__tests__/code-graph.test.ts`,
  `dist/bundled-wasm/` (whole directory:
  `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`,
  `tree-sitter-javascript.wasm`, `tree-sitter-python.wasm`,
  `web-tree-sitter.wasm`), and any packaged copy under
  `dist-electron-out/**/bundled-wasm/`.
- Modify: `src/server.ts` (drop the `registerGraphWatchCoalesce` import
  and its registration call plus the surrounding comment),
  `src/server/controllers/hooks.controller.ts` (drop
  `maybeAutoIndexGraph` / `ensureGraphWatch` imports and any
  post-tool-use / stop-hook branches that call them — the proactive-recall
  block lands in AC-04-03),
  `src/server/event-log-recorder.ts` (drop the comment reference to
  `registerGraphWatchCoalesce`),
  `vite.config.ts` (drop `web-tree-sitter` from `optimizeDeps.exclude`
  and `rollupOptions.external`),
  `scripts/copy-bundled-skills.mjs` (drop the wasm-copy block at
  ~lines 62–91 — the MCP esbuild block at 93–115 comes out in
  AC-04-04),
  `package.json` (drop `@vscode/tree-sitter-wasm` and `web-tree-sitter`
  from `dependencies`).

**Acceptance criteria.**
- `rg "codeGraph|code_graph|code-graph|graphNodes|graphEdges|graphFiles"`
  returns zero hits in `src/server/services/`, `src/shared/`, and
  `src/server.ts`.
- `rg "web-tree-sitter|@vscode/tree-sitter-wasm|tree-sitter-.*\\.wasm"`
  returns zero hits outside `dist-electron-out/`.
- `rg "registerGraphWatchCoalesce|maybeAutoIndexGraph|ensureGraphWatch"`
  returns zero hits.
- `pnpm build` and `pnpm build:web` succeed without Vite warning about
  `web-tree-sitter` being externalized when the dep is gone.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `code-graph.controller.ts`,
`src/server/repositories/code-graph.repo.ts`, and the
`api-router.ts` graph route constants still exist after this ticket
because the controller imports from `code-graph.ts`; the fastest path
is to keep them compiling by making the controller export throw-not-implemented
stubs — OR delete controller/repo/routes together in this ticket. Prefer
the latter if it stays commit-sized; otherwise defer to AC-04-03 and
mark the code-graph controller/repo as its atomic sibling. Either is
fine as long as `pnpm typecheck` passes at ticket boundary.

---

## AC-04-03 — Atomic: retire recall/memory/graph AppSettings, controllers, repos, shared types, HTTP routes

**Depends on:** AC-04-02

**Summary.** The atomic core removal. `AppSettings.recall*` (ten
fields), the settings-controller keys / zod schemas / reads / PATCH
branches, the recall-settings service, the project-memory service +
controller + repo + shared module, the code-graph controller + repo (if
not already gone in AC-04-02), the proactive-recall service + hook-side
context-injection block, the brief-delivery service, the
recall-auto-distill / recall-engine / recall-transcript services, every
recall/memory/graph HTTP route on `api-router.ts`, the `memory:*` and
`graph:*` variants of the `AppEvent` union, and the recall imports in
`electron/pty-manager.ts` all land in one ticket — the type surface
only reconciles if they land together.

**Files touched (indicative).**
- Delete: `src/server/services/brief-delivery.ts`,
  `src/server/services/proactive-recall.ts`,
  `src/server/services/project-memory.ts`,
  `src/server/services/recall-auto-distill.ts`,
  `src/server/services/recall-engine.ts`,
  `src/server/services/recall-settings.ts`,
  `src/server/services/recall-transcript.ts`,
  `src/server/controllers/code-graph.controller.ts` (if AC-04-02
  deferred it),
  `src/server/controllers/project-memory.controller.ts`,
  `src/server/repositories/code-graph.repo.ts` (if AC-04-02 deferred
  it), `src/server/repositories/project-memory.repo.ts`,
  `src/shared/project-memory.ts`,
  `src/shared/agent-memory-file.ts`,
  `electron/agent-memory-brief.ts`,
  `electron/recall-enabled.ts`,
  `src/server/services/__tests__/proactive-recall.test.ts`,
  `src/server/services/__tests__/project-memory-verify.test.ts`,
  `src/server/services/__tests__/project-memory.test.ts`,
  `src/server/services/__tests__/recall-auto-distill.test.ts`,
  `src/server/services/__tests__/recall-bounded-maps.test.ts`,
  `src/server/services/__tests__/recall-engine.test.ts`,
  `src/server/services/__tests__/recall-transcript.test.ts`,
  `src/server/__tests__/code-graph-api.test.ts`,
  `src/server/__tests__/project-memory-api.test.ts`,
  `src/server/__tests__/project-memory-live.test.ts`,
  `src/shared/__tests__/agent-memory-file.test.ts`,
  `electron/__tests__/agent-memory-brief.test.ts`,
  `electron/__tests__/recall-enabled.test.ts`.
- Modify: `src/lib/api.ts` — drop the `~/shared/project-memory` imports
  (`MemoryCreateInput`, `MemoryUpdateInput`, `MemoryVerifyVerdict`,
  `MemoryView`), every `recall*` field from the settings interface and
  the `Partial<>` update union, the "Recall — project memory" API block
  (`listMemory`, `searchMemory`, `createMemory`, `updateMemory`,
  `deleteMemory`, `verifyMemory`, `previewTaskBrief`,
  `previewProjectBrief`), and the "Recall — code graph" API block
  (`graphStatus`, `graphSummary`, `indexGraph`, `cancelGraphIndex`,
  `searchGraph`, `graphNode`, `graphNeighbors`, `graphPath`,
  `graphImpact`).
- Modify `src/server/api-router.ts` — drop `projectMemoryController` /
  `codeGraphController` imports; delete `PROJECT_MEMORY_PATH`,
  `PROJECT_BRIEF_PATH`, `PROJECT_MEMORY_SEARCH_PATH`, `MEMORY_PATH`,
  `MEMORY_VERIFY_PATH`, `PROJECT_GRAPH_STATUS_PATH`,
  `PROJECT_GRAPH_SUMMARY_PATH`, `PROJECT_GRAPH_INDEX_PATH`,
  `PROJECT_GRAPH_INDEX_CANCEL_PATH`, `PROJECT_GRAPH_SEARCH_PATH`,
  `PROJECT_GRAPH_NODE_PATH`, `PROJECT_GRAPH_NEIGHBORS_PATH`,
  `PROJECT_GRAPH_PATH_PATH`, `PROJECT_GRAPH_IMPACT_PATH`,
  `TASK_BRIEF_PATH`; delete every corresponding `if (m …)` route block.
- Modify `src/server.ts` — drop the `registerRecallAutoDistill` import
  and registration call.
- Modify `src/server/events.ts` — delete `memory:created`,
  `memory:updated`, `memory:deleted`, `memory:learned`,
  `graph:index-progress`, `graph:indexed` variants and the
  `GraphIndexProgress` import.
- Modify `src/server/event-log-recorder.ts` — drop the comment
  reference to `registerRecallAutoDistill`.
- Modify `src/server/controllers/hooks.controller.ts` — drop
  `readRecallSettings` import, everything from `./proactive-recall`,
  `briefDeliveredAt` from `./brief-delivery`, and `markMemoriesUsed`;
  delete the proactive-recall block that force-loads Recall's deferred
  MCP tools, builds the per-turn recall block, and consumes
  `readRecallSettings().proactiveRecallEnabled`; delete the
  `briefDeliveredAt(taskId)` call site.
- Modify `src/server/controllers/settings.controller.ts` — drop
  `readRecallSettings` / `writeRecallSettings` imports, every recall
  field from the Zod body schema (`recallEnabled`,
  `recallAutoCaptureEnabled`, `recallEngineEnabled`,
  `recallEngineHarness`, `recallEngineModel`,
  `recallAgentWriteEnabled`, `recallInjectBriefEnabled`,
  `recallCodeGraphEnabled`, `recallProactiveRecallEnabled`,
  `recallLearnedToastEnabled`), `recallSettingsPayload()` and its
  spread into the GET response, and the `writeRecallSettings({ … })`
  block in the PATCH handler.
- Modify `src/components/views/GeneralSettingsPage.tsx`,
  `src/components/views/TerminalSettingsPage.tsx`,
  `src/components/views/ThemeSettingsPage.tsx` — remove every `recall*`
  key from the local settings state literal (each page has the same
  10-line block).
- Modify `src/shared/agent-hooks.ts` — delete the two comments
  referencing the Recall injected memory + code block and any hook
  payload field carrying recall context.
- Modify `src/shared/pet-remark.ts`, `src/shared/pet-tool-classify.ts`
  — strip the comment mentions of Recall / recall tool-load (no
  behavioral change).
- Modify `src/server/repositories/prompts.repo.ts` — if the grep hit
  turns out to be a prose comment, remove it.
- Modify `electron/pty-manager.ts` — drop the four recall imports
  (`installAgentMemoryBrief`, `ensureRecallSkillForAgent` /
  `removeRecallSkillForAgent`, `ensureRecallMcpForAgent` /
  `removeRecallMcpForAgent`, `fetchRecallEnabled`); delete the
  recall-skill / recall-MCP install block; delete the
  `installAgentMemoryBrief({ … })` call; update the comment to drop
  "recall/memory-brief".
- Modify `src/lib/voice-intent.ts` — remove the `REMEMBER_RE` handling
  branch and the "Save a fact about the current project to Recall"
  help entry. (File goes away entirely in spec 01; this is a
  guaranteed-safe partial edit since AC-04-01 already deleted its
  consumer in `routes/projects.$id.tsx`.)
- Modify `src/db/schema.ts` — delete the `projectMemory`, `graphNodes`,
  `graphEdges`, `graphFiles` table definitions plus their `*Relations`
  blocks and the `ProjectMemory` / `NewProjectMemory` type exports;
  drop `MemoryType` / `MemoryStatus` / `MemoryConfidence` /
  `MemorySource` / `GraphNodeKind` / `GraphEdgeKind` / `GraphLanguage`
  / `GraphConfidence` imports if they came from
  `~/shared/project-memory` / `~/shared/code-graph`.
- Modify `src/server/__tests__/settings-api.test.ts` — delete the
  `recallEnabled: false` cases enumerated in the parent spec (lines
  201, 215, 229, 234, 248, 252, 271); do not delete the whole file.
- Modify `src/server/__tests__/agent-hooks-api.test.ts` — delete the
  `mcp__recall__graph_search` reference at line 603 and the
  `resetBriefDeliveries` import at line 16.

**Acceptance criteria.**
- `rg "recallEnabled|recallAutoCaptureEnabled|recallEngineEnabled|recallEngineHarness|recallEngineModel|recallAgentWriteEnabled|recallInjectBriefEnabled|recallCodeGraphEnabled|recallProactiveRecallEnabled|recallLearnedToastEnabled"`
  returns zero hits in `src/` and `electron/`.
- `rg "readRecallSettings|writeRecallSettings|recallSettingsPayload|proactive-recall|brief-delivery|briefDeliveredAt|previewBrief|SessionBrief"`
  returns zero hits in `src/` and `electron/`.
- `rg "memoryFact|memoryFacts|projectMemory|project_memory|MemoryView|MemoryCreateInput|MemoryUpdateInput"`
  returns zero hits in `src/` and `electron/`.
- `rg "memory:created|memory:updated|memory:deleted|memory:learned|graph:index-progress|graph:indexed"`
  returns zero hits.
- `src/lib/api.ts` `AppSettings` interface no longer declares any
  `recall*` field; the settings PATCH union has none either.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** This is the atomic ticket that spec 05 (bundled skills)
depends on. The recall skill sits in `BUNDLED_SKILL_NAMES` — spec 05
cannot land its "no bundled skills" outcome until this ticket has
removed the recall skill from that array (done here as part of the
`electron/pty-manager.ts` edits, and reinforced by AC-04-04 which
deletes the payload directories). Land 04 before 05, per the parent
spec's Coordination note.

The `pet-store.ts` / `PetGuideModal.tsx` edits for `memory:learned` /
`graph:indexed` handlers are deliberately **NOT** touched here — pet
removal (spec 02) already landed and those handlers are gone. If for
any reason spec 02 has not landed at merge time, edit
`src/lib/pet/pet-store.ts` (drop the `XP_MEMORY_LEARNED` constant, the
`memoryLearned` entry in `PET_XP_AWARDS`, and the `case
"memory:learned":` / `case "graph:indexed":` handlers) and
`src/components/pet/PetGuideModal.tsx` (drop the "Memory learned"
award row) as part of this ticket.

---

## AC-04-04 — Delete recall MCP server + bundled skill payload + electron install helpers

**Depends on:** AC-04-03

**Summary.** With the settings surface, HTTP routes, and PTY-manager
install call sites already gone, remove the bundled MCP + skill
artifacts themselves. Deletes `bundled-mcp/recall-mcp.mjs`, every
built and packaged copy of the recall MCP + skill payload, and the two
electron installer modules that copied them into agent working
directories. Verifies `@modelcontextprotocol/sdk` isn't held up by any
other consumer and drops it if not; prunes the `extraResources` +
`build:web` package.json wiring for `dist/bundled-mcp/` and
`copy-bundled-skills.mjs`.

**Files touched (indicative).**
- Delete: `bundled-mcp/recall-mcp.mjs`,
  `dist/bundled-mcp/recall-mcp.mjs`,
  `dist/bundled-skills/recall/` (entire directory + all packaged copies
  under `dist-electron-out/**/resources/bundled-skills/recall/`),
  all packaged copies under
  `dist-electron-out/*/resources/bundled-mcp/recall-mcp.mjs`,
  `.agents/skills/recall/` (source skill payload copied by
  `scripts/copy-bundled-skills.mjs`; delete if present),
  `electron/ensure-recall-mcp.ts`, `electron/ensure-recall-skill.ts`,
  `src/server/__tests__/recall-mcp.test.ts`,
  `electron/__tests__/ensure-recall-mcp.test.ts`,
  `electron/__tests__/ensure-recall-skill.test.ts`.
- Modify: `scripts/copy-bundled-skills.mjs` — drop the MCP esbuild
  block (~lines 93–115); the script becomes diagram-only (spec 05 owns
  the final fate).
- Modify: `package.json` — drop the `extraResources[]` entry for
  `dist/bundled-mcp` if the recall MCP was the only bundled MCP;
  **verify** `@modelcontextprotocol/sdk` is only pulled in for
  `bundled-mcp/recall-mcp.mjs` and drop from `dependencies` if no other
  consumer exists. Leave the trailing `&& node
  scripts/copy-bundled-skills.mjs` on `build:web` in place — spec 05
  removes it once diagram is decided.

**Acceptance criteria.**
- `rg -i "\\brecall\\b" src electron bundled-mcp scripts`
  (case-insensitive, excluding node_modules/dist-electron-out build
  artifacts) returns zero matches.
- `rg "ensureRecallMcpForAgent|removeRecallMcpForAgent|ensureRecallSkillForAgent|removeRecallSkillForAgent|installAgentMemoryBrief|fetchRecallEnabled"`
  returns zero hits.
- `ls dist/bundled-mcp/` shows no `recall-mcp.mjs`; `ls
  dist/bundled-skills/` shows no `recall/` directory.
- Agent PTY spawn end-to-end (manual smoke): no memory-brief block is
  written into `CLAUDE.md` / `AGENTS.md`, no `mcp__recall__*` tool-load
  nudge appears in the first-turn context, and the fresh session env
  has no recall-derived fields.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The parent spec's coordination note lands here: the recall
skill was one of the two entries in `BUNDLED_SKILL_NAMES`, and its
payload directory is deleted in this ticket. Spec 05 handles the
remaining `diagram` skill and the ultimate fate of
`scripts/copy-bundled-skills.mjs`, `dist/bundled-skills/`, and the
`extraResources` bundled-mcp block.

---

## AC-04-05 — Purge recall/memory comments, CSS, and stale prose

**Depends on:** AC-04-04

**Summary.** Cleanup pass. Prunes lingering "Recall" / "memory brief"
/ "code graph" mentions from comments across the tree and rewrites the
last docstring or header that still refers to the old pillar. No
behavioral change — grep-only pass.

**Files touched (indicative).**
- Modify (comment prunes only): any file surfaced by
  `rg -i "recall|project memory|code graph|memory brief"` in `src/`
  and `electron/` that survived AC-04-01…AC-04-04. Expected touch set
  based on the parent spec's grep survey:
  `src/server/services/session-transcripts.ts` (if a recall reference
  slipped through),
  `src/server/services/prompts.ts` (docstring pruning),
  any surviving comment in
  `src/server/controllers/hooks.controller.ts`,
  `src/server/repositories/prompts.repo.ts` (verify the prompt-repo
  hit was purely prose; remove).
- Modify `docs/upstream/PROVENANCE.md` — add a divergence note that
  Recall / project memory / code graph are REMOVED from the fork (per
  ADR 0007); retain upstream historical references.

**Acceptance criteria.**
- `rg -i "recall|project memory|code graph|memory brief"` in `src/`
  and `electron/` returns only species-timbre matches in unrelated
  files (grep-verify by reading each hit).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** No `.mc-recall-*` CSS block exists in `src/styles.css` (the
recall UI used the standard panel styling), so no stylesheet edit is
needed. If a stray class name surfaces during the grep pass, prune it
here.

---

## AC-04-06 — Delete legacy code-graph / project-memory migration files

**Depends on:** AC-04-05

**Summary.** With every consumer of the recall/memory/graph tables
gone, delete the numbered migration files that created them. This is
safe because the fork convention (`docs/tickets/README.md` + the
schema-bootstrap seam in AC-04-07) is that we don't ship numbered SQL
migrations to the user — a fresh install goes through
`schema-bootstrap.ts` and an upgraded install runs the boot-time
DELETE + `DROP TABLE` in AC-04-07.

**Files touched (indicative).**
- Delete: `src/db/migrations/0018_project_memory.sql`,
  `src/db/migrations/0019_code_graph.sql`,
  `src/db/migrations/0020_project_memory_fts.sql`,
  `src/db/migrations/0021_graph_edges_incremental.sql`,
  `src/db/migrations/0022_graph_files.sql`,
  `src/db/__tests__/memory-fts-repair.test.ts`.

**Acceptance criteria.**
- `ls src/db/migrations/` shows no `0018`, `0019`, `0020`, `0021`, or
  `0022` file.
- `rg "0018_project_memory|0019_code_graph|0020_project_memory_fts|0021_graph_edges_incremental|0022_graph_files"`
  returns zero hits.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The parent spec says migrations 0018–0022 are deleted
outright because pre-cutover data is dropped by the boot-time cleanup
in AC-04-07. If any test harness reads the migrations directory to
verify sequence continuity, adjust it — but the fork already tolerates
gaps in the migration numbering (see spec 02's schema-bootstrap
convention).

---

## AC-04-07 — Schema-bootstrap: drop project_memory / graph_nodes / graph_edges / graph_files + FTS + purge KV rows

**Depends on:** AC-04-06

**Summary.** Add the one-shot idempotent boot-time cleanup that
removes the FTS triggers + content table, the `project_memory` table
and its five indexes, the three graph tables and their indexes, and
the ten `recall_*` `app_settings` rows (plus the stray
`code_graph_state` legacy blob). Also removes the `graph_edges.is_member`
`ensureColumn` block and the `ensureMemoryFts` /
`repairMemoryFtsIfCorrupt` helpers from `schema-bootstrap.ts` so the
boot path stops trying to maintain FTS on a dropped table. Follows the
fork convention ("we don't ship migration files to the user") — this
is code in `schema-bootstrap.ts`, not a numbered SQL file.

**Files touched (indicative).**
- Modify `src/db/schema-bootstrap.ts`:
    - Remove the `project_memory` CREATE + its 5 indexes.
    - Remove the `graph_nodes`, `graph_edges`, `graph_files` CREATE +
      all their indexes.
    - Remove the `graph_edges.is_member` `ensureColumn` +
      `graph_edges_dangling_idx` block.
    - Delete `ensureMemoryFts`, `repairMemoryFtsIfCorrupt`, and every
      call site (the `ensureMemoryFts()` call plus the try/catch that
      calls `repairMemoryFtsIfCorrupt`).
    - Add a `dropLegacyRecallMemoryGraph(sqlite)` helper called from
      `ensureSchema` (alongside `dropLegacyPetSettings` /
      `dropLegacyVoiceSettings`) that runs, in order:
        - `DROP TRIGGER IF EXISTS project_memory_fts_ai;`
        - `DROP TRIGGER IF EXISTS project_memory_fts_ad;`
        - `DROP TRIGGER IF EXISTS project_memory_fts_au;`
        - `DROP TABLE IF EXISTS project_memory_fts;`
        - `DROP INDEX IF EXISTS project_memory_project_idx;` (and the
          four sibling `project_memory_*_idx` DROP INDEXes)
        - `DROP TABLE IF EXISTS project_memory;`
        - `DROP INDEX IF EXISTS graph_edges_dangling_idx;` (and the
          four sibling `graph_edges_*` DROP INDEXes)
        - `DROP TABLE IF EXISTS graph_edges;`
        - `DROP INDEX IF EXISTS graph_nodes_project_idx;` (and the
          four sibling `graph_nodes_*` DROP INDEXes)
        - `DROP TABLE IF EXISTS graph_nodes;`
        - `DROP TABLE IF EXISTS graph_files;`
        - `DELETE FROM app_settings WHERE key IN ('recall_enabled',
          'recall_auto_capture_enabled', 'recall_engine_enabled',
          'recall_engine_harness', 'recall_engine_model',
          'recall_agent_write_enabled', 'recall_inject_brief_enabled',
          'recall_code_graph_enabled', 'recall_proactive_recall_enabled',
          'recall_learned_toast_enabled', 'code_graph_state');`

**Acceptance criteria.**
- Booting the Panel against a pre-cutover SQLite (with `project_memory`
  / `project_memory_fts` / `graph_nodes` / `graph_edges` / `graph_files`
  present, plus `recall_*` and `code_graph_state` rows in `app_settings`)
  leaves zero tables matching `project_memory%` / `graph_%` in
  `sqlite_master`, and zero rows matching those `app_settings` keys.
- Booting the Panel against a fresh SQLite runs the DROPs + DELETEs
  without error (all `IF EXISTS` / `WHERE` predicates match nothing) and
  produces no rows or tables.
- `rg "project_memory|project_memory_fts|graph_nodes|graph_edges|graph_files|ensureMemoryFts|repairMemoryFtsIfCorrupt"`
  in `src/` returns only the boot-time DROP block in
  `schema-bootstrap.ts`.
- `rg "recall_enabled|recall_auto_capture_enabled|recall_engine_enabled|recall_engine_harness|recall_engine_model|recall_agent_write_enabled|recall_inject_brief_enabled|recall_code_graph_enabled|recall_proactive_recall_enabled|recall_learned_toast_enabled|code_graph_state"`
  in `src/` returns only the boot-time DELETE in
  `schema-bootstrap.ts`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-02-05 and AC-01-05, this cleanup block stays in the
tree for one release, then is removed by a follow-up ticket (tracked
as AC-CLEANUP-01 in the rebrand set). SQLite `ALTER TABLE DROP COLUMN`
on `graph_edges.is_member` is unnecessary because the whole table is
dropped. The DELETEs on `app_settings` are safe on a fresh DB (WHERE
matches nothing) and required on upgraded DBs so a future rename
doesn't collide with phantom rows.
