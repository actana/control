# 07 — Remove convenience features (Scratch Pad, Custom Scripts / Launch Commands, Prompt Search)

## Overview
Rip out three convenience surfaces that don't belong in the Actana Control harness remote: Scratch Pad (a project-scoped notepad), Custom Scripts / Launch Commands (per-project shell-runner UIs), and the Prompt Search palette (durable searchable prompt history). Storage, IPC, keybindings, settings toggles, and mount points all go with them — no feature flags, hard forward-only cutover.

## Files to delete

### Scratch Pad
- `src/components/views/ScratchPadButton.tsx`
- `src/components/views/ScratchPadModal.tsx`
- `src/lib/scratch-pad-store.tsx`
- `src/lib/scratch-pad-save-queue.ts`
- `src/shared/scratch-pads.ts`
- `src/shared/__tests__/scratch-pads.test.ts`
- `src/server/services/scratch-pads.ts`
- `src/server/controllers/scratch-pads.controller.ts`
- `src/server/repositories/scratch-pads.repo.ts`
- `src/server/__tests__/scratch-pads-api.test.ts`

### Custom Scripts / Launch Commands / Script Args
- `src/components/views/CustomScriptsButton.tsx`
- `src/components/views/CustomScriptsDialog.tsx`
- `src/components/views/LaunchCommandsDialog.tsx`
- `src/components/views/ScriptArgsModal.tsx`
- `src/shared/__tests__/custom-scripts.test.ts`
- `src/lib/project-launch-running.ts`
- `src/lib/__tests__/project-launch-running.test.ts`
- `src/server/__tests__/projects-custom-scripts-api.test.ts`

### Prompt Search
- `src/components/views/PromptSearchButton.tsx`
- `src/components/views/PromptSearchPalette.tsx`
- `src/lib/prompt-search-store.tsx`
- `src/shared/prompts.ts`
- `src/server/services/prompts.ts`
- `src/server/controllers/prompts.controller.ts`
- `src/server/repositories/prompts.repo.ts`
- `src/server/__tests__/prompts-api.test.ts`

## Files to modify

### Toolbar / mount points
- `src/components/views/HeaderToolsCluster.tsx` — drop `ScratchPadButton` and `PromptSearchButton` imports/renders; collapse the "…" tools tray if it becomes empty (see comment referencing "Scratch pads / prompt search / voice" in `src/routes/__root.tsx:916`).
- `src/routes/__root.tsx` — drop `PromptSearchProvider` (line 48) and `ScratchPadProvider` (line 49) imports and the wrapping providers; update the "…" cluster comment (line 916).
- `src/routes/projects.$id.tsx` — remove `LaunchCommandsDialog`, `CustomScriptsDialog`, `CustomScriptsButton`, `ScriptArgsModal` imports (lines 34–45) and all mount points (~lines 3411, 4198, 4208, 4219); remove `parseLaunchCommands` / `parseCustomScripts` derivations, `launchCommandSet`, `hasRunningLaunch`, launch/kill effects, `customScripts.find` in the `scriptId` voice-intent handler (~line 2091), and any Launch button state (~lines 716–967).

### Header buttons registry
- `src/shared/header-buttons.ts` — remove `"scratchPad"` and `"promptSearch"` from the id union and defaults (lines 13, 14, 27, 28).
- `src/lib/hideable-elements.tsx` — remove `scratchPad` and `promptSearch` labels (lines 54–55) and any `hideElementContextMenu("header-button:scratchPad" | ":promptSearch")` uses.

### Settings pages
- `src/components/views/InterfaceSettingsPage.tsx` — delete `scratchPad` and `promptSearch` entries (lines 45–56) and the corresponding `headerButtonRow` calls (lines 136–137).

### Keybindings
- `src/lib/keybindings/types.ts` — remove `"prompt.search"` and `"scratch.toggle"` from action union (lines 32–33) and their descriptors (lines 118–123).
- `src/lib/keybindings/defaults.ts` — remove `"prompt.search": makeBinding({ mod: true, shift: true, key: "p" })` (line 43) and `"scratch.toggle": makeBinding({ mod: true, key: "j" })` (line 45).
- `src/lib/keybindings/groups.ts` — remove `"prompt.search"` and `"scratch.toggle"` from the tools group (lines 54–55); drop the group if it empties.

### Server / API
- `src/server/api-router.ts` — remove `promptsController` / `scratchPadsController` imports (lines 23, 25), the two path regexes (lines 53–54), the `/api/projects/:id/scratch-pads(/:padId)` handlers (lines 337–345), and `GET /api/prompts` (line 479).
- `src/server/controllers/hooks.controller.ts` — remove `recordPrompt` import and call sites (line 17).
- `src/server/controllers/tasks.controller.ts` — remove `recordPrompt` import and call sites (line 29).
- `src/server/controllers/projects.controller.ts` — drop `launchCommands` / `customScripts` fields from project update Zod schema (lines 77–78) and any custom script/launch command sub-schemas.
- `src/server/services/projects.ts` — remove `launchCommands`, `customScripts`, `serializeLaunchCommands`, `serializeCustomScripts`, `LAUNCH_COMMANDS_MAX`, `CUSTOM_SCRIPTS_MAX`, and the null defaults on create (lines 334–335, 372–459).

### Client API + queries
- `src/lib/api.ts` — remove `PromptSearchResponse` / `ScratchPadView` imports (lines 26, 66), the `listScratchPads` / `create` / `update` / `delete` client methods (~lines 531–543), and `searchPrompts` (~line 904).
- `src/queries/index.ts` — remove `queryKeys.promptSearch` / `queryKeys.scratchPads` (lines 59, 64), `launchCommands: null` / `customScripts: null` defaults (lines 93–94), `scratchPadsQueryOptions` (300–307), `promptSearchQueryOptions` and `usePromptSearch` (460–520).

### Voice / terminal ancillaries
- `src/lib/voice-intent.ts` — remove any `run-custom-script` / `scriptId` intent variants (grep confirms references).
- `src/components/views/VoiceController.tsx` — drop the matching intent dispatch branch.
- `src/lib/terminal-store.tsx`, `src/lib/agent-command.ts`, `src/lib/use-fleet.ts`, `src/lib/user-terminal-store.tsx`, `src/components/views/TerminalPane.tsx`, `src/components/views/ProjectCard.tsx`, `src/components/views/ProjectBar.tsx`, `src/components/views/ProjectPicker.tsx`, `src/components/views/ProjectsTable.tsx` — remove all `launchCommand` / `customScript` / `startCommand` reads, `killTerminalsByStartCommand` calls tied to launch commands, and the "Launch" split-button surfaces on the project card / bar.
- `src/components/views/GitDiffView/GitDiffModal.tsx` — drop the "mirrors prompt-search palette" doc comment (line 6).
- `src/lib/session-notification-store.ts` — drop the prompt-search palette doc comment (line 506); no code changes expected.

## Schema changes

Confirmed via `src/db/schema.ts` and the migration ledger:

- `scratch_pads` table (created in `0024_scratch_pads.sql`; schema.ts lines 477–490): DROP TABLE.
- `prompts` table (created in `0017_prompts.sql`; schema.ts lines 286–306) including indexes `prompts_task_idx`, `prompts_project_idx`, `prompts_ts_idx`: DROP INDEX + DROP TABLE.
- `projects.launch_commands` (added `0003_launch_commands.sql`; schema.ts line 95): ALTER TABLE DROP COLUMN.
- `projects.custom_scripts` (added `0014_custom_scripts.sql`; schema.ts line 96): ALTER TABLE DROP COLUMN.
- `user_terminals.start_command` (added `0003_launch_commands.sql`; schema.ts line 233): ALTER TABLE DROP COLUMN — this column exists solely to tag terminals spawned by Launch buttons; verify no other consumer before dropping (only `project-launch-running.ts` and `killTerminalsByStartCommand` reference it today).
- `app_settings` / user prefs: no scratch-pad/prompt-search-specific rows found; visibility is stored in header-button toggles in `app_settings` JSON — reset any persisted `hiddenElements` entries containing `header-button:scratchPad` / `header-button:promptSearch` during migration (or accept they become orphan strings ignored by the new registry).

## Migration

`src/db/migrations/0025_remove_convenience.sql`:

```sql
-- Actana Control: drop harness-remote-inappropriate convenience surfaces.
-- Scratch pads, prompt-search history, per-project launch commands and
-- custom scripts, and the terminal start_command tag they relied on.

DROP INDEX IF EXISTS prompts_task_idx;
DROP INDEX IF EXISTS prompts_project_idx;
DROP INDEX IF EXISTS prompts_ts_idx;
DROP TABLE IF EXISTS prompts;

DROP INDEX IF EXISTS scratch_pads_project_idx;
DROP INDEX IF EXISTS scratch_pads_project_updated_idx;
DROP TABLE IF EXISTS scratch_pads;

ALTER TABLE projects DROP COLUMN launch_commands;
ALTER TABLE projects DROP COLUMN custom_scripts;

ALTER TABLE user_terminals DROP COLUMN start_command;
```

Also update `src/db/schema-bootstrap.ts` if it snapshots the current schema for fresh installs.

## IPC channels

There is no dedicated Electron IPC surface for these features — traffic is HTTP-only through the local API server. Confirmed via `electron/ipc-channels.ts` (no matches for scratch/prompt/customScript/launchCommand).

HTTP routes to delete (see `src/server/api-router.ts`):
- `GET/POST /api/projects/:id/scratch-pads`
- `PATCH/DELETE /api/projects/:id/scratch-pads/:padId`
- `GET /api/prompts?q=…&limit=…`
- `PATCH /api/projects/:id` — drop `launchCommands` and `customScripts` from the accepted body.

Script-run "IPC": there is no dedicated channel; scripts execute via the ordinary PTY spawn path (`electron/pty-manager.ts` + `pty-spawn-policy.ts`). No electron-side change required beyond ensuring `start_command` is no longer forwarded in the terminal spawn payload — audit callers of `pty-manager.ts` and `sandbox-agent-client.ts` for a `startCommand` field.

## Keybindings

Delete these actions and their default bindings — no user-migration path since we cut forward-only:

- `scratch.toggle` — default `Mod+J` (see `src/lib/keybindings/defaults.ts:45`).
- `prompt.search` — default `Mod+Shift+P` (see `src/lib/keybindings/defaults.ts:43`).
- No dedicated launch-command hotkey exists (`LaunchCommandsDialog` is opened from the project bar only) — nothing to unregister.

Persisted user overrides in `app_settings.keybindings` (or wherever the reader in `electron/keybindings-reader.ts` writes them) may still carry these keys — the reader should silently drop unknown actions (verify) so no migration is strictly required; otherwise add a one-shot cleanup.

## Tests to remove
- `src/server/__tests__/scratch-pads-api.test.ts`
- `src/server/__tests__/prompts-api.test.ts`
- `src/server/__tests__/projects-custom-scripts-api.test.ts`
- `src/shared/__tests__/scratch-pads.test.ts`
- `src/shared/__tests__/custom-scripts.test.ts`
- `src/lib/__tests__/project-launch-running.test.ts`
- Trim launch/script assertions out of `src/server/__tests__/settings-api.test.ts`, `src/server/__tests__/sandboxes-api.test.ts`, `src/lib/__tests__/agent-command.test.ts`, `src/lib/__tests__/shell-query-cache.test.ts`, `src/lib/__tests__/sort-projects.test.ts`, `src/lib/__tests__/worktree-live-activity.test.ts`, `src/db/__tests__/bootstrap-existing-sandbox-id.test.ts` (all matched by the grep and reference `launchCommands` / `customScripts` / `startCommand`).

## Verification checklist
- [ ] `rg -i "scratchpad|scratch-pad|scratch_pad" src electron` returns zero hits.
- [ ] `rg "PromptSearch|prompt-search|prompt\\.search|savedPrompts|saved_prompts" src electron` returns zero hits (except this spec).
- [ ] `rg "CustomScript|customScript|LaunchCommand|launchCommand|ScriptArgs|start_command|startCommand" src electron` returns zero hits.
- [ ] `pnpm tsc --noEmit` passes — no dangling imports from `HeaderToolsCluster`, `__root.tsx`, `projects.$id.tsx`, `queries/index.ts`, `lib/api.ts`.
- [ ] Fresh DB from `schema-bootstrap.ts` contains no `prompts`, `scratch_pads` tables and no `projects.launch_commands`, `projects.custom_scripts`, `user_terminals.start_command` columns; existing DBs upgrade cleanly via `0025_remove_convenience.sql`.
- [ ] Interface settings page renders without the two orphaned toggle rows; `hideable-elements` registry has no scratchPad/promptSearch ids.
- [ ] Keybindings settings screen lists no `scratch.toggle` / `prompt.search` actions; pressing the old defaults (`Mod+J`, `Mod+Shift+P`) is a no-op.
- [ ] Project detail page has no Launch split-button, no Custom Scripts split-button, no Script Args modal path; voice intents no longer resolve `run-custom-script`.
- [ ] Header "…" tools tray is either removed (if empty) or contains only remaining Actana Control tools (e.g. voice).

## Follow-ups / out of scope
- Custom scripts and launch commands are legitimately useful — they belong in the **sandbox layer**, not the harness remote. Track as future work under the sandbox spec; do not port the current UI as-is.
- Prompt search / saved prompts belong in the user's own toolchain (their editor, their prompt manager). Actana Control is not a prompt manager and will not reintroduce this surface. Out of scope entirely.
- The dropped `user_terminals.start_command` column is fine to lose because Launch-managed lifecycle disappears with it. If the future sandbox layer needs to tag spawned processes, it should introduce its own column with sandbox-appropriate semantics.
