# Spec 05 — Remove bundled agent skills and skill-install infrastructure

## Overview

Delete every bundled agent skill Actana Control installs into the operator's harness (diagram, ship, recall), delete the entire skill-install infrastructure (services, controllers, HTTP endpoints, IPC types, renderer modals/menu items, harness-target registries), and stop injecting `MC_API_URL` / `MC_API_TOKEN` / `MC_TASK_ID` / `MC_THEME` into agent Sessions. This enforces ADR 0006: the Panel is a remote control, not a config editor for the operator's harness.

## Files to delete

Bundled skill assets and MCP payload:
- `dist/bundled-skills/diagram/` (entire directory, including `SKILL.md`)
- `dist/bundled-skills/recall/` (entire directory, including `SKILL.md`) — see cross-spec note below
- `bundled-mcp/recall-mcp.mjs` — see cross-spec note below
- `.claude/skills/diagram/` (repo-local development mirror)
- `.agents/skills/diagram/` (repo-local development mirror)
- `.agents/skills/recall/` (repo-local development mirror) — see cross-spec note below
- `scripts/copy-bundled-skills.mjs` — the whole build helper goes; the code-graph WASM copy it also does needs to be inlined into `build:web` (or a smaller replacement script) as part of this spec

Install-side Electron / server code:
- `electron/ensure-diagram-skill.ts`
- `electron/ensure-recall-skill.ts` — see cross-spec note below
- `electron/ensure-recall-mcp.ts` — see cross-spec note below
- `src/server/bundled-skills-path.ts`
- `src/server/services/install-diagram-skill.ts`
- `src/server/services/install-ship-skills.ts`
- `src/server/services/_skills-install-helpers.ts`
- `src/server/controllers/skills.controller.ts`
- `src/shared/diagram-skill-install.ts`
- `src/shared/ship-skill-install.ts`

UI:
- `src/components/views/InstallDiagramSkillModal.tsx`
- `src/components/views/InstallDiagramSkillMenuItem.tsx`
- `src/components/views/InstallShipSkillModal.tsx`
- `src/components/views/InstallShipSkillMenuItem.tsx`
- `src/components/views/ShipFailedDialog.tsx`
- `src/components/views/CommitPushButton.tsx`
- `src/components/views/DiagramDialog.tsx`
- `src/components/views/skill-install-shared.tsx`
- `src/lib/install-skills-client.ts`
- `src/lib/use-diagram-events.tsx`
- `src/lib/use-diagram-ready-notifications.tsx`
- `src/lib/mermaid-theme.ts`

Diagram API + persistence:
- `src/server/controllers/diagrams.controller.ts`
- `src/server/repositories/diagrams.repo.ts`
- `src/server/services/diagram-store.ts`
- `src/shared/diagram.ts`

Tests:
- `electron/__tests__/ensure-diagram-skill.test.ts`
- `electron/__tests__/ensure-recall-skill.test.ts` — see cross-spec note below
- `electron/__tests__/ensure-recall-mcp.test.ts` — see cross-spec note below
- `src/server/__tests__/diagram-skill-install.test.ts`
- `src/server/__tests__/ship-skill-install.test.ts`
- `src/server/__tests__/diagram-api.test.ts`
- `src/lib/__tests__/mermaid-theme.test.ts`

## Files to modify

Env injection (strip `MC_API_URL`, `MC_API_TOKEN`, `MC_TASK_ID`, `MC_THEME` from agent-Session env setup):
- `electron/pty-manager.ts`
  - `sanitizeEnv()` currently deletes `MC_API_URL` / `MC_API_TOKEN` before spawn — the whole delete-and-selectively-re-add dance dies. Delete the `env.MC_TASK_ID = …` / `env.MC_API_URL = …` / `env.MC_API_TOKEN = …` / `env.MC_THEME = …` assignments in the agent-mode branch (lines around 667–672). Delete the `ensureDiagramSkillForAgent` / `ensureRecallSkillForAgent` / `ensureRecallMcpForAgent` / `removeRecallSkillForAgent` / `removeRecallMcpForAgent` imports and call sites.
- `electron/main.ts`
  - Delete `MC_API_URL: apiUrl ?? undefined` and `MC_API_TOKEN: getOrCreateApiToken(...)` from the harness `spawn` env (around lines 1057–1058). `buildLocalMissionControlApiUrl` / `apiUrl` may go entirely if that's its only caller — verify.
- `electron/harness-entry.ts`
  - Delete the `MC_API_URL` / `MC_API_TOKEN` reads and the header comment describing them.
- `electron/app-theme.ts`
  - Purge the `MC_THEME` comment/logic branch (spawn-time theme hint).
- `src/lib/session-warm-pool.ts`
  - Drop the `MC_THEME` reference in the warm-pool key/comment.
- `src/components/views/TerminalPane.tsx`
  - Drop the `MC_API_URL / MC_API_TOKEN` comment (line 1348) and any code that depends on those env vars being present.
- `src/shared/opencode-mission-control-plugin.ts`
  - `MC_AGENT_ENV_KEYS = ["MC_TASK_ID", "MC_API_URL", "MC_API_TOKEN"]` and the plugin body all reference these env vars for hook egress. Since agent hooks (spec 04) are also being narrowed / removed for the recall path, coordinate: either delete the plugin entirely or reduce it to a no-op stub.
- `.opencode/plugins/mission-control.js`
  - Same story — delete or stub.
- `src/shared/agent-hooks.ts`
  - The generated hook commands are built around `$MC_TASK_ID` / `$MC_API_URL` / `$MC_API_TOKEN`. If any surviving hook still fires (see spec 04 for what remains), it needs a new transport story that does not depend on env-injected credentials. If no hooks survive, delete this module and `electron/agent-hooks.ts` and the `installAgentHooks` call in `pty-manager.ts`.
- `src/shared/mission-control-hook-env.ts` — the whole file's purpose is generating the `MC_API_URL` / `MC_API_TOKEN` pair for hook egress. Delete or reduce.
- `src/server/auth.ts` — the comment referencing `MC_API_TOKEN` seeding needs updating; token-issuing logic (`getOrCreateApiToken`) survives for the core-link auth transport but stops flowing into agent Sessions.

Router registration (remove diagram + skill-install routes):
- `src/server/api-router.ts`
  - Delete route handlers at lines ~438–449 (`/api/skills/install/diagram*`, `/api/skills/install/ship*`) and lines ~463–470 (`/api/diagram`, `/api/diagrams`). Delete the `import * as skillsController` and `import * as diagramsController` lines.
- `src/server/__tests__/api-auth.test.ts` — remove the `/api/diagram*` entries from the auth matrix.

Server tasks + services:
- `src/server/services/tasks.ts` — delete `deleteDiagramsForTask(id)` call and its import (task deletion no longer cascades to a diagram store because there is no diagram store).

Renderer routes / dialogs / notifications:
- `src/routes/__root.tsx` — remove `DiagramDialogHost`, `useDiagramReadyNotificationList`, imports from `use-diagram-events` / `use-diagram-ready-notifications`, and the `diagramNotificationList` merge into `sessionNotifications`.
- `src/routes/projects.$id.tsx` — remove imports of `InstallDiagramSkillMenuItem`, `InstallDiagramSkillModal`, `InstallShipSkillMenuItem`, `InstallShipSkillModal`, `CommitPushButton`, `useSyncProjectDiagrams`; delete the `showInstallDiagramSkill` state, the menu items in the New Session menu (~3287–3293), the modals at ~3988–3994, both `CommitPushButton` usages (~3504, ~4637), and the `useSyncProjectDiagrams(id)` call (~409).
- `src/components/views/TaskCard.tsx` — remove `useDiagrams` import, `hasDiagram` / `openDiagram` calls, the whole `Diagram` action button block (~338–365).
- `src/components/views/GitDiffView/ChangedFilesList.tsx` — remove `CommitPushButton` import (~15) and its usage (~216). Replace with existing commit UI or nothing; product intent is "Panel does not commit/push."
- `src/components/views/SessionNotificationsButton.tsx` — remove the `diagram-ready` branches (~258, ~367).
- `src/components/views/InterfaceSettingsPage.tsx` — update the notifications-bell description (line 66) to drop "and ready diagrams."
- `src/components/views/GeneralSettingsPage.tsx` — update the finish-ding description (line 392) to drop "or a diagram is ready."
- `src/lib/session-notification-store.ts` — delete the `DiagramReadyNotification` type, `"diagram-ready"` kind, `diagramId` / `diagramTitle` fields, `DIAGRAM_NOTIFICATION_OPEN_EVENT`, the `type: "diagram"` open-target variant, all `diagram-ready` branches, `diagramReadySnapshot` / `getDiagramReadyNotificationsSnapshot`, `PENDING_DIAGRAM_OPEN_KEY`, and every conditional keyed off `diagram-ready`. Corresponding tests in `src/lib/__tests__/session-notification-store.test.ts` need updating.
- `src/lib/pet/pet-store.ts`, `pet-messages.ts`, `pet-lines.ts`, `src/lib/pet/pet-store.test.ts` — any pet lines mentioning diagrams get pruned.
- `src/lib/api.ts` — remove the `/api/diagram*` fetch wrappers (~912–916) and the "diagram-ready" comment (~116).
- `src/lib/design-meta.ts` — audit and strip any diagram-related metadata.

Server events:
- `src/server/events.ts` — delete the `"diagram:show"` event type (~66) and any producer.
- `src/server/controllers/__tests__/events.controller.test.ts` — drop any `diagram:show` assertions.

Electron contract:
- `src/shared/electron-contract.ts` — delete `InstallDiagramSkillResult` (~62) and any other diagram/ship skill types.

Recall touch-points (see cross-spec note; spec 04 owns these):
- `electron/pty-manager.ts` recall-related branches
- `src/server/services/proactive-recall.ts`
- `src/server/__tests__/recall-mcp.test.ts`
- `electron/__tests__/recall-enabled.test.ts`

Warm pool / claude-cli comment cleanup:
- `src/server/services/claude-cli.ts` — comment block (~31–35) explains blanking `MC_TASK_ID` / `MC_API_URL` / `MC_API_TOKEN` on nested spawn. That whole concern goes away.

## Schema changes

- Drop `task_diagrams` table (currently defined in `src/db/schema.ts` ~200 as `taskDiagrams`, and mirrored in `src/db/schema-bootstrap.ts` ~365 as `CREATE TABLE IF NOT EXISTS task_diagrams`).
- Drop `task_diagrams` indexes `task_diagrams_project_idx` and `task_diagrams_task_idx`.
- Remove `taskDiagrams`, `taskDiagramsRelations`, and the `diagrams: many(taskDiagrams)` relation entry from `src/db/schema.ts` (~200, ~545, ~575).
- Remove the corresponding `CREATE TABLE IF NOT EXISTS task_diagrams …` block from `src/db/schema-bootstrap.ts` (~365–376).
- Historical migrations `0011_task_diagrams.sql` and `0012_task_diagrams_multi.sql` stay on disk unchanged (they predate the fork; see project memory) — the drop happens in a new forward migration.
- `app_settings`: audit for any `diagram_*` / `ship_*` / `skill_*` keys; drop them in the same migration. Current grep of `getBooleanAppSetting` shows `pet_enabled` is unrelated; the recall-enabled key is spec 04's concern.

## Migration

Add `src/db/migrations/0025_remove_bundled_skills.sql` (the current tail is `0024_scratch_pads.sql`):

```sql
-- 0025_remove_bundled_skills.sql
-- Drop tables backing the removed diagram feature (ADR 0006).
DROP INDEX IF EXISTS task_diagrams_project_idx;
DROP INDEX IF EXISTS task_diagrams_task_idx;
DROP TABLE IF EXISTS task_diagrams;
-- Legacy from the 0012 rename dance, defensive:
DROP TABLE IF EXISTS task_diagrams_new;

-- Drop any diagram/skill-install app_settings rows (values, if any, were
-- session-local install hints — see install-*-skill services).
DELETE FROM app_settings WHERE key LIKE 'diagram\_%' ESCAPE '\';
DELETE FROM app_settings WHERE key LIKE 'ship\_skill\_%' ESCAPE '\';
DELETE FROM app_settings WHERE key LIKE 'diagram\_skill\_%' ESCAPE '\';
```

Confirm the exact `app_settings` keys during implementation and prune the `DELETE`s to what actually existed — do not leave speculative deletes.

## Package.json edits

- Remove dependency `"mermaid": "11.12.0"` (line 129).
- Remove `build:web` postprocessing: change `"build:web": "vite build && node scripts/copy-bundled-skills.mjs"` — either delete `copy-bundled-skills.mjs` outright and drop the trailing step, or replace it with a slimmer `scripts/copy-code-graph-wasm.mjs` that only handles the tree-sitter WASM copy (the current script bundles skills + recall MCP + code-graph WASM into one place). Code-graph WASM is out of scope for this removal and must still be copied.
- `build.extraResources` currently lists only `resources/whisper` and `dist/bundled-mcp` (lines 204–219). Delete the `dist/bundled-mcp` entry — the recall MCP was the only thing in it. `dist/bundled-skills/` is not an `extraResources` entry; it rides along inside `dist/**/*` (line 187). Verify no lingering `dist/bundled-skills/` files ship by inspecting the packaged app after `pnpm dist`.
- Repo-local development mirrors `.claude/skills/diagram/` and `.agents/skills/diagram/` (and recall equivalents) are not referenced by `build.files` and go away with the file deletions above. Confirm no accidental inclusion.
- No scripts specifically named `diagram*` exist; confirm during implementation.

## Cross-spec coordination

Recall skill deletion overlaps with spec 04 (recall/memory removal). Convention:
- **Spec 05 (this spec) owns:** deleting the on-disk skill payload and MCP bundle — `dist/bundled-skills/recall/`, `bundled-mcp/recall-mcp.mjs`, `.agents/skills/recall/` — and stripping their references from `scripts/copy-bundled-skills.mjs` (which spec 05 deletes wholesale) and from `package.json` `build.extraResources` (`dist/bundled-mcp`).
- **Spec 04 owns:** deleting the Electron install/uninstall modules — `electron/ensure-recall-skill.ts`, `electron/ensure-recall-mcp.ts`, their tests (`electron/__tests__/ensure-recall-skill.test.ts`, `electron/__tests__/ensure-recall-mcp.test.ts`), the `fetchRecallEnabled` / master-switch logic, and the recall service + settings.

Ordering: spec 04 lands first (removes the code that references the payloads); spec 05 then reaps the payload files without leaving dangling imports. If spec 05 lands first, expect a temporary period where `ensureRecallSkillForAgent` throws at runtime because the source dir is missing — acceptable because both specs are part of the same rebrand cutover and the app is not user-facing between them.

Diagram-adjacent removals (diagram skill, diagram API, ensure-diagram-skill, DiagramDialog, mermaid dep, `task_diagrams` tables, `MC_API_*` env injection) belong entirely to this spec.

## Harness registry impact

The current harness registry lives implicitly in `src/shared/diagram-skill-install.ts` and `src/shared/ship-skill-install.ts`, each a `{ claude, codex, cursor }` map carrying `label` + `segments` (diagram) or `label` + `skillSegments` + others (ship). Post-cut:

- Delete the `skillsInstallSegments` / `segments` / `skillSegments` field from wherever the harness registry ends up living.
- Keep the `label` field (`"Claude Code"`, `"Codex"`, `"Cursor CLI"`) — the New-Session UI still needs display names.
- Delete the `DIAGRAM_SKILL_INSTALL_TARGETS`, `SHIP_SKILL_INSTALL_TARGETS`, `DIAGRAM_SKILL_HARNESS_KEYS`, `SHIP_SKILL_HARNESS_KEYS`, `DiagramSkillHarnessSelection`, `ShipSkillHarnessSelection`, `diagramSkillInstallPath`, `shipSkillInstallPath`, `shipSkillInstallCommand`, and all `emptyXHarnessSelection` / `allXHarnessesSelected` / `hasXHarnessSelection` / `installedXHarnessLabels` helpers.
- If a consolidated harness registry does not yet exist, create a minimal `src/shared/harness-registry.ts` with just `{ id, label }` entries so New Session and settings UI have a single source.

## Env vars / IPC channels

- Purge `MC_API_URL`, `MC_API_TOKEN`, `MC_TASK_ID`, `MC_THEME` from every agent-Session env-writing site listed under **Files to modify**. Grep must show zero occurrences in `electron/`, `src/`, and `.opencode/`.
- No IPC channels are namespaced `diagram:` today (`src/server/events.ts` has a `"diagram:show"` SSE event type — delete it). No `skill:` IPC channels found; confirm during implementation.
- The `DIAGRAM_NOTIFICATION_OPEN_EVENT = "mc:diagram-notification-open"` DOM CustomEvent constant goes away with `session-notification-store.ts` edits.

## Tests to remove

- `electron/__tests__/ensure-diagram-skill.test.ts`
- `electron/__tests__/ensure-recall-skill.test.ts` (spec 04)
- `electron/__tests__/ensure-recall-mcp.test.ts` (spec 04)
- `src/server/__tests__/diagram-skill-install.test.ts`
- `src/server/__tests__/ship-skill-install.test.ts`
- `src/server/__tests__/diagram-api.test.ts`
- `src/lib/__tests__/mermaid-theme.test.ts`
- Any test in `src/lib/__tests__/session-notification-store.test.ts` covering `diagram-ready`.
- Any `MC_API_URL` / `MC_API_TOKEN` / `MC_TASK_ID` injection assertions in `electron/__tests__/file-handlers-sensitive.test.ts`, `src/server/__tests__/opencode-plugin-integration.test.ts`, `src/server/__tests__/agent-hooks.test.ts`, `src/shared/__tests__/opencode-mission-control-plugin.test.ts`, `src/server/services/__tests__/commit-cli.test.ts` — verify each and delete or update.

## Verification checklist

- [ ] `rg "SKILL\.md" -uu` returns zero non-node_modules hits.
- [ ] `rg "MC_API_URL|MC_API_TOKEN|MC_TASK_ID|MC_THEME" -g '!*.md' -uu` returns zero hits in `src/`, `electron/`, and `.opencode/` (documentation may still discuss the removal).
- [ ] `rg -i "mermaid" -g '!pnpm-lock.yaml' -g '!*.md'` returns zero hits.
- [ ] `rg -w "diagram" -g '!*.md' -g '!*.sql' src electron` returns zero hits outside comments describing removal history.
- [ ] `pnpm typecheck` passes without dangling imports.
- [ ] `pnpm test` passes with the deleted tests gone and touched tests updated.
- [ ] Launching an agent Session (Claude Code, Codex, Cursor) produces a process whose environment (`ps eww $PID`) contains no `MC_API_*` / `MC_TASK_ID` / `MC_THEME` keys.
- [ ] `pnpm dist` yields a packaged app whose `Resources/app.asar` unpacks with no `bundled-skills/` or `bundled-mcp/` directory, and whose `Resources/` has no `bundled-mcp/` sibling.
- [ ] Fresh install against a clean SQLite DB applies migration `0025_remove_bundled_skills.sql` without error; running against an existing DB with populated `task_diagrams` drops the table cleanly.

## Follow-ups / out of scope

Nothing replaces this. The Panel does not install skills, does not render diagrams, does not commit or push, and does not inject Panel-owned credentials into agent Sessions. Operators who want the diagram, ship, or recall workflows install those skills themselves into their own harness (`.claude/skills/`, `.codex/skills/`, `.cursor/skills/`); the Panel neither offers a UI for it nor knows about the outcome. Any future feature that would require Panel-installed skills has to relitigate ADR 0006 first.
