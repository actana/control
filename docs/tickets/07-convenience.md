# Tickets — Spec 07 (Remove convenience features)

Parent spec: [`../specs/07-remove-convenience.md`](../specs/07-remove-convenience.md).

Four tickets. Ordered so each PR leaves `typecheck` and `test` green.
Mirrors the shape used by [`01-whisper.md`](./01-whisper.md) and
[`02-pet.md`](./02-pet.md): peel off each convenience surface (Scratch
Pad, Custom Scripts / Launch Commands, Prompt Search) as its own
self-contained ticket, then a final cleanup + schema-bootstrap
forward-migration pass.

---

## AC-07-01 — Delete Scratch Pad surface (UI + provider + queries + controller + table)

**Depends on:** —

**Summary.** Rip out the project-scoped notepad end to end. Removes the
header button + modal, the renderer store + save queue, the shared
type, the server service / controller / repo, the `/api/projects/:id/scratch-pads(/:padId)`
routes, the client `listScratchPads`/`create`/`update`/`delete` methods,
the `scratchPadsQueryOptions` query, the `scratchPad` header-button /
hideable-element / InterfaceSettings entries, and the `scratch.toggle`
keybinding. Leaves the `scratch_pads` table in existing SQLite dbs —
that DROP lands boot-time in AC-07-04.

**Files touched (indicative).**
- Delete: `src/components/views/ScratchPadButton.tsx`,
  `src/components/views/ScratchPadModal.tsx`,
  `src/lib/scratch-pad-store.tsx`,
  `src/lib/scratch-pad-save-queue.ts`,
  `src/shared/scratch-pads.ts`,
  `src/shared/__tests__/scratch-pads.test.ts`,
  `src/server/services/scratch-pads.ts`,
  `src/server/controllers/scratch-pads.controller.ts`,
  `src/server/repositories/scratch-pads.repo.ts`,
  `src/server/__tests__/scratch-pads-api.test.ts`.
- Modify: `src/components/views/HeaderToolsCluster.tsx` (drop
  `ScratchPadButton` import + render),
  `src/routes/__root.tsx` (drop `ScratchPadProvider` import at line 49
  and its wrapping provider),
  `src/shared/header-buttons.ts` (drop `"scratchPad"` from the id union
  and default visibility map at lines 13 / 27),
  `src/lib/hideable-elements.tsx` (drop the `scratchPad` label at
  line 54 and any `hideElementContextMenu("header-button:scratchPad")`
  callers),
  `src/components/views/InterfaceSettingsPage.tsx` (drop the
  `scratchPad` visibility entry at lines 45–56 and the
  `headerButtonRow("scratchPad")` call at line 136–137),
  `src/lib/keybindings/types.ts` (drop `"scratch.toggle"` from the
  action union at lines 32–33 and its descriptor at lines 118–123),
  `src/lib/keybindings/defaults.ts` (drop
  `"scratch.toggle": makeBinding({ mod: true, key: "j" })` at line 45),
  `src/lib/keybindings/groups.ts` (drop `"scratch.toggle"` from the
  tools group at lines 54–55),
  `src/server/api-router.ts` (drop `scratchPadsController` import at
  line 25, the scratch-pads path regex at lines 53–54, and the
  `/api/projects/:id/scratch-pads(/:padId)` handlers at lines 337–345),
  `src/lib/api.ts` (drop the `ScratchPadView` import at line 66 and the
  `listScratchPads` / `create` / `update` / `delete` client methods at
  lines ~531–543),
  `src/queries/index.ts` (drop `queryKeys.scratchPads` at line 64 and
  `scratchPadsQueryOptions` at lines 300–307).

**Acceptance criteria.**
- `rg -i "scratchpad|scratch-pad|scratch_pad|scratch\.toggle"` in `src`
  and `electron` returns zero hits.
- Header tools cluster still renders (Prompt Search + any residuals
  still mounted); InterfaceSettings page renders without the ScratchPad
  toggle row; keybindings settings screen lists no `scratch.toggle`
  action.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `HeaderToolsCluster.tsx` still has the Prompt Search button
after this ticket — do not collapse the "…" tray yet (that happens in
AC-07-04 once the tray is verifiably empty). Rebase carefully if spec
03 or spec 06 land in parallel — both also edit `header-buttons.ts`,
`hideable-elements.tsx`, `keybindings/*`, and `InterfaceSettingsPage.tsx`.

---

## AC-07-02 — Delete Custom Scripts / Launch Commands surface (UI + schema fields + terminal tagging)

**Depends on:** AC-07-01

**Summary.** Remove the per-project shell-runner UIs and everything
that plumbs `launchCommands` / `customScripts` / `startCommand` through
the app. Deletes the four dialogs, the run-state helper, the
project-update Zod fields, the `serializeLaunchCommands` /
`serializeCustomScripts` service branches with their `_MAX` constants,
the `launchCommands: null` / `customScripts: null` query defaults, all
`launchCommand` / `customScript` / `startCommand` reads across the
terminal + fleet + project surfaces, the `killTerminalsByStartCommand`
call sites tied to launch commands, the Launch split-button on the
project card / bar / picker / table, and the voice-intent
`run-custom-script` branch (leftover from Whisper — nothing to add to
`VoiceController.tsx` if AC-01-01 already deleted it). Leaves the
`projects.launch_commands`, `projects.custom_scripts`, and
`user_terminals.start_command` columns in existing SQLite dbs — the
DROPs land boot-time in AC-07-04.

**Files touched (indicative).**
- Delete: `src/components/views/CustomScriptsButton.tsx`,
  `src/components/views/CustomScriptsDialog.tsx`,
  `src/components/views/LaunchCommandsDialog.tsx`,
  `src/components/views/ScriptArgsModal.tsx`,
  `src/lib/project-launch-running.ts`,
  `src/lib/__tests__/project-launch-running.test.ts`,
  `src/shared/__tests__/custom-scripts.test.ts`,
  `src/server/__tests__/projects-custom-scripts-api.test.ts`.
- Modify: `src/routes/projects.$id.tsx` (drop the
  `LaunchCommandsDialog` / `CustomScriptsDialog` / `CustomScriptsButton`
  / `ScriptArgsModal` imports at lines 34–45, all four mount points at
  ~lines 3411 / 4198 / 4208 / 4219, the `parseLaunchCommands` /
  `parseCustomScripts` derivations, `launchCommandSet`,
  `hasRunningLaunch`, launch/kill effects, the `customScripts.find`
  branch in the `scriptId` voice-intent handler at ~line 2091, and the
  Launch button state at ~lines 716–967),
  `src/server/controllers/projects.controller.ts` (drop `launchCommands`
  / `customScripts` fields from the project-update Zod schema at
  lines 77–78 and any custom-script / launch-command sub-schemas),
  `src/server/services/projects.ts` (drop `launchCommands`,
  `customScripts`, `serializeLaunchCommands`, `serializeCustomScripts`,
  `LAUNCH_COMMANDS_MAX`, `CUSTOM_SCRIPTS_MAX`, and the null defaults on
  create at lines 334–335 / 372–459),
  `src/queries/index.ts` (drop `launchCommands: null` /
  `customScripts: null` defaults at lines 93–94),
  `src/lib/voice-intent.ts` (drop `run-custom-script` / `scriptId`
  intent variants if the file still exists post-spec-01),
  `src/lib/terminal-store.tsx`, `src/lib/agent-command.ts`,
  `src/lib/use-fleet.ts`, `src/lib/user-terminal-store.tsx`,
  `src/components/views/TerminalPane.tsx`,
  `src/components/views/ProjectCard.tsx`,
  `src/components/views/ProjectBar.tsx`,
  `src/components/views/ProjectPicker.tsx`,
  `src/components/views/ProjectsTable.tsx` (drop all `launchCommand` /
  `customScript` / `startCommand` reads, `killTerminalsByStartCommand`
  calls tied to launch commands, and the Launch split-button surfaces),
  and trim launch/script assertions from
  `src/server/__tests__/settings-api.test.ts`,
  `src/server/__tests__/sandboxes-api.test.ts`,
  `src/lib/__tests__/agent-command.test.ts`,
  `src/lib/__tests__/shell-query-cache.test.ts`,
  `src/lib/__tests__/sort-projects.test.ts`,
  `src/lib/__tests__/worktree-live-activity.test.ts`,
  `src/db/__tests__/bootstrap-existing-sandbox-id.test.ts`.
- Audit-only: callers of `electron/pty-manager.ts` and
  `electron/sandbox-agent-client.ts` for a `startCommand` field on the
  spawn payload — remove it if forwarded, no channel deletion needed.

**Acceptance criteria.**
- `rg "CustomScript|customScript|LaunchCommand|launchCommand|ScriptArgs|start_command|startCommand"`
  in `src` and `electron` returns zero hits.
- `PATCH /api/projects/:id` no longer accepts `launchCommands` or
  `customScripts` in the body (rejected by Zod).
- Project detail page has no Launch split-button, no Custom Scripts
  split-button, no Script Args modal path.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** No dedicated IPC channel exists for script execution —
scripts spawn via the ordinary PTY path, so no `electron/ipc-channels.ts`
edit is required here. The `user_terminals.start_command` column stays
in the schema until AC-07-04.

---

## AC-07-03 — Delete Prompt Search palette (UI + provider + queries + controller + table + hook recorders)

**Depends on:** AC-07-02

**Summary.** Cut the prompt-history palette end to end. Removes the
header button + palette, the renderer store, the shared type, the
server service / controller / repo, the `GET /api/prompts` route, the
`searchPrompts` client method, the `promptSearchQueryOptions` /
`usePromptSearch` queries, the `recordPrompt` call sites in the hooks
and tasks controllers, the `promptSearch` header-button /
hideable-element / InterfaceSettings entries, and the `prompt.search`
keybinding. Leaves the `prompts` table in existing SQLite dbs — the
DROP lands boot-time in AC-07-04.

**Files touched (indicative).**
- Delete: `src/components/views/PromptSearchButton.tsx`,
  `src/components/views/PromptSearchPalette.tsx`,
  `src/lib/prompt-search-store.tsx`,
  `src/shared/prompts.ts`,
  `src/server/services/prompts.ts`,
  `src/server/controllers/prompts.controller.ts`,
  `src/server/repositories/prompts.repo.ts`,
  `src/server/__tests__/prompts-api.test.ts`.
- Modify: `src/components/views/HeaderToolsCluster.tsx` (drop
  `PromptSearchButton` import + render),
  `src/routes/__root.tsx` (drop `PromptSearchProvider` import at
  line 48 and its wrapping provider),
  `src/shared/header-buttons.ts` (drop `"promptSearch"` from the id
  union and default visibility map at lines 14 / 28),
  `src/lib/hideable-elements.tsx` (drop the `promptSearch` label at
  line 55 and any `hideElementContextMenu("header-button:promptSearch")`
  callers),
  `src/components/views/InterfaceSettingsPage.tsx` (drop the
  `promptSearch` visibility entry and the `headerButtonRow("promptSearch")`
  call at lines 136–137),
  `src/lib/keybindings/types.ts` (drop `"prompt.search"` from the
  action union at lines 32–33 and its descriptor at lines 118–123),
  `src/lib/keybindings/defaults.ts` (drop
  `"prompt.search": makeBinding({ mod: true, shift: true, key: "p" })`
  at line 43),
  `src/lib/keybindings/groups.ts` (drop `"prompt.search"` from the
  tools group at lines 54–55; drop the tools group entirely if it
  empties after this and AC-07-01),
  `src/server/api-router.ts` (drop `promptsController` import at
  line 23, the prompts path regex at lines 53–54, and the
  `GET /api/prompts` handler at line 479),
  `src/server/controllers/hooks.controller.ts` (drop the `recordPrompt`
  import and call sites at line 17),
  `src/server/controllers/tasks.controller.ts` (drop the `recordPrompt`
  import and call sites at line 29),
  `src/lib/api.ts` (drop the `PromptSearchResponse` import at line 26
  and `searchPrompts` at ~line 904),
  `src/queries/index.ts` (drop `queryKeys.promptSearch` at line 59 and
  `promptSearchQueryOptions` / `usePromptSearch` at lines 460–520).

**Acceptance criteria.**
- `rg "PromptSearch|prompt-search|prompt\.search|savedPrompts|saved_prompts|recordPrompt"`
  in `src` and `electron` returns zero hits (except this spec).
- Header tools tray no longer renders a Prompt Search button; pressing
  `Mod+Shift+P` is a no-op.
- Task creation and Claude hooks no longer write to the prompts table.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** After this ticket lands, the `keybindings/groups.ts` tools
group is empty (both `scratch.toggle` and `prompt.search` are gone) —
drop the group entirely here. Rebase carefully if spec 03 or spec 06
land in parallel — both also edit `header-buttons.ts`,
`hideable-elements.tsx`, `keybindings/*`, and `InterfaceSettingsPage.tsx`.

---

## AC-07-04 — Cleanup + schema-bootstrap: DROP prompts / scratch_pads / launch_commands / custom_scripts / start_command

**Depends on:** AC-07-03

**Summary.** Final cleanup pass plus the forward-migration boot-time
schema drop. Prunes lingering doc comments (`GitDiffModal.tsx`,
`session-notification-store.ts`, `__root.tsx` tools-cluster comment),
collapses the header "…" tools tray in `HeaderToolsCluster.tsx` if it
is empty (only voice was ever in it; already gone via spec 01), and
adds an idempotent boot-time cleanup that DROPs the `prompts` and
`scratch_pads` tables (and their indexes) and DROPs the
`projects.launch_commands`, `projects.custom_scripts`, and
`user_terminals.start_command` columns. Follows the fork convention
("we don't ship migration files to the user") — this is code in
`schema-bootstrap.ts`, not a numbered SQL file.

**Files touched (indicative).**
- Modify `src/db/schema-bootstrap.ts` — add a
  `dropLegacyConvenienceSurfaces(sqlite)` helper that runs, guarded by
  `sqlite_master` existence checks:
    - `DROP INDEX IF EXISTS prompts_task_idx;`
      `DROP INDEX IF EXISTS prompts_project_idx;`
      `DROP INDEX IF EXISTS prompts_ts_idx;`
      `DROP TABLE IF EXISTS prompts;`
    - `DROP INDEX IF EXISTS scratch_pads_project_idx;`
      `DROP INDEX IF EXISTS scratch_pads_project_updated_idx;`
      `DROP TABLE IF EXISTS scratch_pads;`
    - `ALTER TABLE projects DROP COLUMN launch_commands;`
      (guarded by a `pragma_table_info('projects')` check)
    - `ALTER TABLE projects DROP COLUMN custom_scripts;`
      (guarded)
    - `ALTER TABLE user_terminals DROP COLUMN start_command;`
      (guarded)
  Call it from `ensureSchema` alongside the other
  `dropLegacy*Settings` helpers and document that the block stays in
  the tree for one release.
- Modify `src/db/schema.ts` — drop the `scratch_pads` table definition
  at lines 477–490, the `prompts` table + indexes at lines 286–306,
  `projects.launch_commands` at line 95, `projects.custom_scripts` at
  line 96, and `user_terminals.start_command` at line 233.
- Modify `src/components/views/HeaderToolsCluster.tsx` — collapse the
  "…" tools tray if it becomes empty after AC-07-01 and AC-07-03; drop
  the "Scratch pads / prompt search / voice" comment.
- Modify `src/routes/__root.tsx` — update the "…" cluster comment at
  line 916 (drop the "scratch pads / prompt search / voice" reference).
- Modify (comment prunes only):
  `src/components/views/GitDiffView/GitDiffModal.tsx` (drop the
  "mirrors prompt-search palette" doc comment at line 6),
  `src/lib/session-notification-store.ts` (drop the prompt-search
  palette doc comment at line 506; no code changes).
- Audit-only: `electron/keybindings-reader.ts` — verify the reader
  silently drops unknown actions so persisted
  `app_settings.keybindings` entries for `prompt.search` /
  `scratch.toggle` are harmless. If it errors on unknown keys, add a
  one-shot cleanup here; otherwise no change.

**Acceptance criteria.**
- Booting the Panel against a pre-cutover SQLite (with `prompts`,
  `scratch_pads` tables and `launch_commands` / `custom_scripts` /
  `start_command` columns present) leaves zero of them after
  `ensureSchema` runs.
- Booting the Panel against a fresh SQLite runs the guarded DROPs
  without error (no `no such table` / `no such column`) and produces
  no rows.
- Fresh DB from `schema-bootstrap.ts` contains no `prompts`,
  `scratch_pads` tables and no `projects.launch_commands`,
  `projects.custom_scripts`, `user_terminals.start_command` columns.
- `rg -i "scratchpad|scratch-pad|scratch_pad"` in `src` and `electron`
  returns zero hits.
- `rg "PromptSearch|prompt-search|prompt\.search|savedPrompts|saved_prompts"`
  in `src` and `electron` returns zero hits (except this spec).
- `rg "CustomScript|customScript|LaunchCommand|launchCommand|ScriptArgs|start_command|startCommand"`
  in `src` and `electron` returns zero hits (except the boot-time DROP
  in `schema-bootstrap.ts`).
- Header "…" tools tray is either removed (if empty) or contains only
  remaining Actana Control tools.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-01-05 and AC-02-05, this cleanup block stays in the
tree for one release, then is removed by a follow-up ticket (tracked
as AC-CLEANUP-01 in the rebrand set). SQLite `ALTER TABLE DROP COLUMN`
requires 3.35+ (2021-03-12) — Mission Control's `better-sqlite3`
bundled version is well past that.
