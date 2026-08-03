# Tickets — Spec 05 (Remove bundled skills)

Parent spec: [`../specs/05-remove-bundled-skills.md`](../specs/05-remove-bundled-skills.md).
ADR: [`../adr/0006-no-bundled-skills.md`](../adr/0006-no-bundled-skills.md).

Five tickets. Ordered so each PR leaves `typecheck` and `test` green.
Mirrors the shape used by [`01-whisper.md`](./01-whisper.md) and
[`02-pet.md`](./02-pet.md): renderer callers first, then the diagram
API + persistence, then skill-install infrastructure and harness
registry, then the `MC_*` env-injection purge, then the boot-time
schema cleanup.

---

## AC-05-01 — Delete diagram renderer surface + notification pipeline

**Depends on:** —

**Summary.** Unmount every diagram-facing thing in the Panel UI without
touching the diagram HTTP API, the skill-install services, or the
`MC_API_*` env injection. After this ticket the Panel has no
`DiagramDialog`, no diagram menu action on `TaskCard`, no
`diagram-ready` notification kind, no `useSyncProjectDiagrams` call,
and no `use-diagram-events` / `use-diagram-ready-notifications`
imports — but `POST /api/diagram*` still answers, the `task_diagrams`
table still exists, and `dist/bundled-skills/diagram/` still ships.
Those go in AC-05-02.

**Files touched (indicative).**
- Delete: `src/components/views/DiagramDialog.tsx`,
  `src/lib/use-diagram-events.tsx`,
  `src/lib/use-diagram-ready-notifications.tsx`,
  `src/lib/mermaid-theme.ts`,
  `src/lib/__tests__/mermaid-theme.test.ts`.
- Modify: `src/routes/__root.tsx` — drop `DiagramDialogHost`,
  `useDiagramReadyNotificationList`, imports from
  `~/lib/use-diagram-events` / `~/lib/use-diagram-ready-notifications`,
  and the `diagramNotificationList` merge into `sessionNotifications`.
- Modify: `src/routes/projects.$id.tsx` — drop the
  `useSyncProjectDiagrams(id)` call (~409). Diagram-related menu-item
  and modal removals ride with the skill-install strip in AC-05-03.
- Modify: `src/components/views/TaskCard.tsx` — drop `useDiagrams`
  import and the `hasDiagram` / `openDiagram` block plus the whole
  `Diagram` action button block (~338–365).
- Modify: `src/components/views/SessionNotificationsButton.tsx` — drop
  the `diagram-ready` branches (~258, ~367).
- Modify: `src/components/views/InterfaceSettingsPage.tsx` — update the
  notifications-bell description (~line 66) to drop "and ready
  diagrams."
- Modify: `src/components/views/GeneralSettingsPage.tsx` — update the
  finish-ding description (~line 392) to drop "or a diagram is ready."
- Modify: `src/lib/session-notification-store.ts` — delete
  `DiagramReadyNotification`, the `"diagram-ready"` kind, `diagramId`
  / `diagramTitle` fields, `DIAGRAM_NOTIFICATION_OPEN_EVENT`, the
  `type: "diagram"` open-target variant, `diagramReadySnapshot` /
  `getDiagramReadyNotificationsSnapshot`, `PENDING_DIAGRAM_OPEN_KEY`,
  and every conditional keyed off `diagram-ready`. Update
  `src/lib/__tests__/session-notification-store.test.ts` accordingly.
- Modify: `src/lib/pet/pet-store.ts`, `src/lib/pet/pet-messages.ts`,
  `src/lib/pet/pet-lines.ts`, `src/lib/pet/pet-store.test.ts` — prune
  any pet lines mentioning diagrams (only if spec 02's pet removal has
  not yet reaped these files; otherwise skip).
- Modify: `src/lib/api.ts` — drop the `"diagram-ready"` comment
  (~line 116). The `/api/diagram*` fetch wrappers (~912–916) survive
  until AC-05-02.
- Modify: `src/lib/design-meta.ts` — audit and strip any
  diagram-related metadata.

**Acceptance criteria.**
- `rg "DiagramDialog|useSyncProjectDiagrams|useDiagrams\\b|diagram-ready|DIAGRAM_NOTIFICATION_OPEN_EVENT|DiagramReadyNotification|use-diagram-events|use-diagram-ready-notifications|mermaid-theme"`
  returns zero hits in `src/`.
- Panel loads, `TaskCard` renders with no Diagram action, settings
  descriptions no longer mention diagrams, notifications button no
  longer branches on `diagram-ready`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `src/lib/api.ts` `apiDiagram*` wrappers remain in place
this ticket so the diagram controller still has typed consumers if
anything in the tree still calls it; AC-05-02 removes both sides
together.

---

## AC-05-02 — Retire the diagram HTTP API + persistence + SSE event

**Depends on:** AC-05-01

**Summary.** Cut the entire diagram server surface: the controller,
repository, service, shared type, `/api/diagram*` router entries,
the `diagram:show` SSE event, and the `deleteDiagramsForTask` call
from task deletion. Also removes the `mermaid` npm dependency —
nothing in the renderer imports it after AC-05-01. Leaves the
`task_diagrams` SQLite table on disk (dropped at boot in AC-05-05)
and leaves `dist/bundled-skills/diagram/` shipping (deleted in
AC-05-03).

**Files touched (indicative).**
- Delete: `src/server/controllers/diagrams.controller.ts`,
  `src/server/repositories/diagrams.repo.ts`,
  `src/server/services/diagram-store.ts`,
  `src/shared/diagram.ts`,
  `src/server/__tests__/diagram-api.test.ts`.
- Modify: `src/server/api-router.ts` — delete route handlers at
  ~463–470 (`/api/diagram`, `/api/diagrams`) and the
  `import * as diagramsController` line. Skill-install routes at
  ~438–449 stay this ticket; they go in AC-05-03.
- Modify: `src/server/__tests__/api-auth.test.ts` — remove the
  `/api/diagram*` entries from the auth matrix.
- Modify: `src/server/services/tasks.ts` — delete the
  `deleteDiagramsForTask(id)` call and its import.
- Modify: `src/server/events.ts` — delete the `"diagram:show"` event
  type (~66) and any producer.
- Modify: `src/server/controllers/__tests__/events.controller.test.ts`
  — drop any `diagram:show` assertions.
- Modify: `src/lib/api.ts` — delete the `/api/diagram*` fetch wrappers
  (~912–916).
- Modify: `package.json` — remove the `"mermaid": "11.12.0"`
  dependency (line 129) and re-run `pnpm install` so the lockfile is
  updated in the same commit.

**Acceptance criteria.**
- `rg "diagrams\\.controller|diagrams\\.repo|diagram-store|shared/diagram\"|diagram:show|deleteDiagramsForTask|apiDiagram|/api/diagram"`
  returns zero hits in `src/`.
- `rg -i "mermaid" -g '!pnpm-lock.yaml' -g '!*.md'` returns zero hits.
- Task deletion still works end-to-end (task row removed; no error
  from missing diagram-store).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The `task_diagrams` table itself stays in
`src/db/schema.ts` and `src/db/schema-bootstrap.ts` at end of this
ticket — dropping it while the table is still declared in the
bootstrap CREATE would fight itself. AC-05-05 does the schema strip
and the boot-time DROP together.

---

## AC-05-03 — Delete skill-install services, controllers, UI, and harness registry shims

**Depends on:** AC-05-02, AC-04-NN (recall service + Electron
`ensure-recall-*` modules must land first — see cross-spec note)

**Summary.** The atomic core removal of the skill-install
infrastructure. Deletes the diagram + ship install services, the
`skills.controller`, the shared `*-skill-install.ts` registries and
every helper hanging off them, the four Install* modals + menu items,
`ShipFailedDialog`, `CommitPushButton`, `skill-install-shared.tsx`,
`install-skills-client.ts`, the `ChangedFilesList` commit/push
integration, the diagram + recall on-disk skill payloads, the
`recall-mcp` bundle, the `copy-bundled-skills.mjs` build helper (with
the code-graph WASM copy re-homed into a slimmer script), the
`electron/ensure-diagram-skill.ts` module, and the `InstallDiagramSkillResult`
electron-contract type. Introduces a minimal
`src/shared/harness-registry.ts` if one does not already exist,
carrying just `{ id, label }` per harness so the New Session menu
still has display names.

**Files touched (indicative).**
- Delete: `dist/bundled-skills/diagram/` (entire directory),
  `dist/bundled-skills/recall/` (entire directory),
  `bundled-mcp/recall-mcp.mjs`,
  `.claude/skills/diagram/`,
  `.agents/skills/diagram/`,
  `.agents/skills/recall/`,
  `scripts/copy-bundled-skills.mjs`,
  `electron/ensure-diagram-skill.ts`,
  `electron/__tests__/ensure-diagram-skill.test.ts`,
  `src/server/bundled-skills-path.ts`,
  `src/server/services/install-diagram-skill.ts`,
  `src/server/services/install-ship-skills.ts`,
  `src/server/services/_skills-install-helpers.ts`,
  `src/server/controllers/skills.controller.ts`,
  `src/shared/diagram-skill-install.ts`,
  `src/shared/ship-skill-install.ts`,
  `src/server/__tests__/diagram-skill-install.test.ts`,
  `src/server/__tests__/ship-skill-install.test.ts`,
  `src/components/views/InstallDiagramSkillModal.tsx`,
  `src/components/views/InstallDiagramSkillMenuItem.tsx`,
  `src/components/views/InstallShipSkillModal.tsx`,
  `src/components/views/InstallShipSkillMenuItem.tsx`,
  `src/components/views/ShipFailedDialog.tsx`,
  `src/components/views/CommitPushButton.tsx`,
  `src/components/views/skill-install-shared.tsx`,
  `src/lib/install-skills-client.ts`.
- Add (only if a consolidated harness registry does not already
  exist): `src/shared/harness-registry.ts` with `{ id, label }` entries
  for `claude`, `codex`, `cursor`.
- Add (replacement build step): `scripts/copy-code-graph-wasm.mjs`
  handling only the tree-sitter WASM copy previously done by
  `copy-bundled-skills.mjs`.
- Modify: `src/server/api-router.ts` — delete route handlers at
  ~438–449 (`/api/skills/install/diagram*`,
  `/api/skills/install/ship*`) and the `import * as skillsController`
  line.
- Modify: `src/routes/projects.$id.tsx` — remove imports of
  `InstallDiagramSkillMenuItem`, `InstallDiagramSkillModal`,
  `InstallShipSkillMenuItem`, `InstallShipSkillModal`,
  `CommitPushButton`; delete the `showInstallDiagramSkill` state, the
  menu items in the New Session menu (~3287–3293), the modals at
  ~3988–3994, and both `CommitPushButton` usages (~3504, ~4637).
- Modify: `src/components/views/GitDiffView/ChangedFilesList.tsx` —
  remove `CommitPushButton` import (~15) and its usage (~216). Product
  intent per ADR 0006 is "Panel does not commit/push" — no
  replacement UI.
- Modify: `src/shared/electron-contract.ts` — delete
  `InstallDiagramSkillResult` (~62) and any other diagram/ship skill
  types.
- Modify: `package.json` — change
  `"build:web": "vite build && node scripts/copy-bundled-skills.mjs"`
  to invoke the new slim wasm-copy script instead; delete the
  `dist/bundled-mcp` entry from `build.extraResources` (lines
  204–219).
- Modify: `electron/pty-manager.ts` — delete the
  `ensureDiagramSkillForAgent` import and call site.
  `ensureRecallSkillForAgent` / `ensureRecallMcpForAgent` /
  `removeRecallSkillForAgent` / `removeRecallMcpForAgent` imports and
  call sites are removed by spec 04; if they still linger at this
  ticket's start, delete them here.

**Acceptance criteria.**
- `rg "SKILL\\.md" -uu` returns zero non-`node_modules` hits.
- `rg "install-diagram-skill|install-ship-skills|skills\\.controller|InstallDiagramSkill|InstallShipSkill|ShipFailedDialog|CommitPushButton|skill-install-shared|install-skills-client|InstallDiagramSkillResult|copy-bundled-skills"`
  returns zero hits.
- `rg "DIAGRAM_SKILL_INSTALL_TARGETS|SHIP_SKILL_INSTALL_TARGETS|DIAGRAM_SKILL_HARNESS_KEYS|SHIP_SKILL_HARNESS_KEYS|DiagramSkillHarnessSelection|ShipSkillHarnessSelection|diagramSkillInstallPath|shipSkillInstallPath|shipSkillInstallCommand|skillsInstallSegments"`
  returns zero hits.
- `dist/bundled-skills/` and `dist/bundled-mcp/` do not exist in the
  repo tree; a fresh `pnpm dist` does not recreate them.
- New Session menu still lists Claude Code / Codex / Cursor CLI (from
  the retained `label` field); no "Install …" menu items appear.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Recall on-disk assets (`dist/bundled-skills/recall/`,
`bundled-mcp/recall-mcp.mjs`, `.agents/skills/recall/`) are this
spec's territory per the spec's cross-spec split; the `ensureRecall*`
Electron modules and their tests are spec 04's territory. If spec 04
has not landed yet, hold this ticket — deleting the payloads while
the Electron code still tries to copy from them will crash agent
spawn.

---

## AC-05-04 — Purge `MC_API_URL` / `MC_API_TOKEN` / `MC_TASK_ID` / `MC_THEME` env injection

**Depends on:** AC-05-03

**Summary.** Strip Panel-owned credential and identity env vars from
every agent-Session env-writing site. `sanitizeEnv()` no longer
deletes-then-re-adds the `MC_*` set; `main.ts` stops seeding
`MC_API_URL` / `MC_API_TOKEN` into the harness spawn env;
`harness-entry.ts` stops reading them; `app-theme.ts` and
`session-warm-pool.ts` stop referencing `MC_THEME`; `TerminalPane.tsx`
loses the vestigial comment. Agent hooks (`agent-hooks.ts`,
`mission-control-hook-env.ts`, the opencode plugin) either reduce to
no-ops or delete outright — coordinate with spec 04's decision on
which hooks survive. `getOrCreateApiToken` stays in `src/server/auth.ts`
for the core-link auth transport (spec 02, ADR 0002) but stops
flowing into agent Sessions.

**Files touched (indicative).**
- Modify: `electron/pty-manager.ts` — delete the `env.MC_TASK_ID = …`
  / `env.MC_API_URL = …` / `env.MC_API_TOKEN = …` / `env.MC_THEME = …`
  assignments in the agent-mode branch (~667–672) and simplify
  `sanitizeEnv()` now that the delete-and-re-add dance is gone.
- Modify: `electron/main.ts` — delete `MC_API_URL: apiUrl ?? undefined`
  and `MC_API_TOKEN: getOrCreateApiToken(...)` from the harness
  `spawn` env (~1057–1058). If `buildLocalMissionControlApiUrl` /
  `apiUrl` have no other callers, delete them.
- Modify: `electron/harness-entry.ts` — delete the `MC_API_URL` /
  `MC_API_TOKEN` reads and the header comment describing them.
- Modify: `electron/app-theme.ts` — purge the `MC_THEME`
  comment/logic branch.
- Modify: `src/lib/session-warm-pool.ts` — drop the `MC_THEME`
  reference in the warm-pool key/comment.
- Modify: `src/components/views/TerminalPane.tsx` — drop the
  `MC_API_URL / MC_API_TOKEN` comment (~1348) and any code that
  depends on those env vars being present.
- Modify: `src/shared/opencode-mission-control-plugin.ts` — delete or
  reduce to a no-op stub; `MC_AGENT_ENV_KEYS = ["MC_TASK_ID",
  "MC_API_URL", "MC_API_TOKEN"]` and its consumers all go.
- Modify: `.opencode/plugins/mission-control.js` — same treatment as
  the shared plugin.
- Modify: `src/shared/agent-hooks.ts` — if no hooks survive spec 04,
  delete this module (and `electron/agent-hooks.ts`, and the
  `installAgentHooks` call in `pty-manager.ts`). If any hook survives,
  rewrite its transport to not depend on env-injected credentials.
- Modify: `src/shared/mission-control-hook-env.ts` — delete or reduce;
  the whole module's purpose is generating the `MC_API_URL` /
  `MC_API_TOKEN` pair for hook egress.
- Modify: `src/server/auth.ts` — update the comment referencing
  `MC_API_TOKEN` seeding; `getOrCreateApiToken` survives.
- Modify: `src/server/services/claude-cli.ts` — delete the comment
  block (~31–35) that explains blanking `MC_TASK_ID` / `MC_API_URL` /
  `MC_API_TOKEN` on nested spawn.
- Modify: `electron/__tests__/file-handlers-sensitive.test.ts`,
  `src/server/__tests__/opencode-plugin-integration.test.ts`,
  `src/server/__tests__/agent-hooks.test.ts`,
  `src/shared/__tests__/opencode-mission-control-plugin.test.ts`,
  `src/server/services/__tests__/commit-cli.test.ts` — verify each and
  delete or update any `MC_API_URL` / `MC_API_TOKEN` / `MC_TASK_ID`
  injection assertions.

**Acceptance criteria.**
- `rg "MC_API_URL|MC_API_TOKEN|MC_TASK_ID|MC_THEME" -g '!*.md' -uu`
  returns zero hits in `src/`, `electron/`, and `.opencode/`.
- Launching an agent Session (Claude Code, Codex, Cursor) produces a
  process whose environment contains none of the four keys (verify
  with `ps eww $PID` during manual smoke).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** This ticket owns the env-injection removal that spec 09
(rebrand) depends on: spec 09 renames `MC_*` → `AC_*` and must land
against a tree where the Panel no longer speaks the `MC_*` names to
agent Sessions at all. Land AC-05-04 before starting spec 09's
rename ticket.

---

## AC-05-05 — Schema-bootstrap: drop `task_diagrams` + diagram/ship `app_settings` rows

**Depends on:** AC-05-04

**Summary.** Add a one-shot idempotent boot-time cleanup that drops
the `task_diagrams` table and its indexes and removes any lingering
`diagram_*` / `ship_skill_*` / `diagram_skill_*` rows from
`app_settings`. Also removes `taskDiagrams`, `taskDiagramsRelations`,
and the `diagrams: many(taskDiagrams)` relation from
`src/db/schema.ts`, and the corresponding
`CREATE TABLE IF NOT EXISTS task_diagrams …` block from
`src/db/schema-bootstrap.ts`. Follows the fork convention ("we don't
ship migration files to the user") — this is code in
`schema-bootstrap.ts`, not a numbered SQL file. Historical migrations
`0011_task_diagrams.sql` and `0012_task_diagrams_multi.sql` stay on
disk unchanged.

**Files touched (indicative).**
- Modify: `src/db/schema.ts` — remove `taskDiagrams` (~200),
  `taskDiagramsRelations` (~545), and the `diagrams: many(taskDiagrams)`
  relation entry (~575).
- Modify: `src/db/schema-bootstrap.ts` — remove the
  `CREATE TABLE IF NOT EXISTS task_diagrams …` block (~365–376) and
  its indexes. Add a `dropLegacyBundledSkillsSchema(sqlite)` helper
  that runs, in order:
    - `DROP INDEX IF EXISTS task_diagrams_project_idx;`
    - `DROP INDEX IF EXISTS task_diagrams_task_idx;`
    - `DROP TABLE IF EXISTS task_diagrams;`
    - `DROP TABLE IF EXISTS task_diagrams_new;` (defensive; legacy from
      the 0012 rename dance)
    - guarded `DELETE FROM app_settings WHERE key LIKE 'diagram\_%' ESCAPE '\';`
    - guarded `DELETE FROM app_settings WHERE key LIKE 'ship\_skill\_%' ESCAPE '\';`
    - guarded `DELETE FROM app_settings WHERE key LIKE 'diagram\_skill\_%' ESCAPE '\';`
  Call it from `ensureSchema` alongside `dropLegacyPetSettings` and
  `dropLegacyVoiceSettings`. Confirm the exact `app_settings` keys
  during implementation — prune the `DELETE`s to what actually
  existed rather than leaving speculative deletes.

**Acceptance criteria.**
- Booting the Panel against a pre-cutover SQLite (with `task_diagrams`
  populated and any `diagram_*` / `ship_skill_*` rows present) leaves
  zero rows in either place and no `task_diagrams` table.
- Booting the Panel against a fresh SQLite runs the DROPs and DELETEs
  without error and produces no rows.
- Booting against a DB where `task_diagrams` never existed (fresh
  install post-cutover) skips the DROP cleanly (no error from
  `IF EXISTS`).
- `rg "taskDiagrams|task_diagrams" src` returns only the boot-time
  DROP in `schema-bootstrap.ts`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-01-05 and AC-02-05, this cleanup block stays in
the tree for one release, then is removed by a follow-up ticket
(tracked as AC-CLEANUP-01 in the rebrand set).
