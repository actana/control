# Tickets — Spec 11 (Remove worktree management and git integration)

Parent spec: [`../specs/11-remove-worktree-and-git.md`](../specs/11-remove-worktree-and-git.md).

Six tickets. Ordered top-down so each commit leaves `pnpm typecheck` and
`pnpm test` green: renderer mounts first, then the client data layer +
settings surface, then the electron engine + shared contracts, then the
server API + services + shared domain, then the DB schema, and finally
docs / divergence bookkeeping.

> **Migration convention.** The parent spec sketches
> `0027_remove_worktree_and_git.sql`. Per ADR 0007 and the cross-spec
> convention in [`README.md`](./README.md), that lands as an idempotent
> boot-time helper (`dropLegacyWorktreeSchema`) in
> `src/db/schema-bootstrap.ts` instead — same shape as
> `dropLegacySandboxSchema` (spec 10), guarded on `pragma_table_info` for
> the column drops. No numbered SQL migration files.

> **Beyond the spec's file list (verified at cut-time).**
> - `src/lib/project-git.ts` and its test no longer exist (already gone
>   with spec 10) — nothing to do.
> - The git controller also exposes a `commit` action and the routes are
>   `/api/projects/:id/git/<action>` shaped — exact route strings win over
>   the spec's `/api/git/*` sketch.
> - The **Ship** feature (`shipAgent` / `shipModel` / `shipPrompt`,
>   `ship-operations.ts`) is **not** removed — it is a Harness session
>   request, exactly the shape ADR 0007 keeps. Only its `worktreeId`
>   parameterization goes (`shipKey(projectId)` only).
> - The settings surface for `worktreesEnabled`,
>   `gitDiffChangedFilesView`, `gitDiffChangedFilesWidth`, and
>   `selectedWorktreeByProject` spans `src/shared/ui-preferences.ts`,
>   `src/server/controllers/settings.controller.ts`, and the `AppSettings`
>   type in `src/lib/api.ts` — per the AppSettings convention these are
>   pruned together (AC-11-02).
> - The stored `app_settings` keys are snake_case
>   (`selected_worktree_by_project`, …) — the boot-time cleanup deletes
>   the real keys, not the spec's camelCase sketch.

---

## AC-11-01 — Unmount worktree + git UI from the renderer

**Depends on:** —

**Summary.** Take every worktree / git surface off the screen without
touching the client data layer, electron, or the server. Deletes the
`GitDiffView/` directory, `BranchTypeahead`, and
`WorktreeSetupCommandDialog`; unmounts them from `projects.$id.tsx`;
removes the header worktree / branch chip, the task-row worktree badge,
the session-row scope label, and the terminal-header branch context; drops
the `git.diff` keybinding. The backing libs (`git-diff-view-store`,
`use-worktrees-enabled`, `queries/git.ts`, the `api.ts` client methods)
stay wired until AC-11-02.

**Files touched (indicative).**
- Delete: `src/components/views/GitDiffView/` (index, `GitDiffModal`,
  `ChangedFilesList`, `DiffPane`), `src/components/views/BranchTypeahead.tsx`,
  `src/components/views/WorktreeSetupCommandDialog.tsx`.
- Modify `src/routes/projects.$id.tsx` — delete `worktreesQuery`,
  `useWorktreesEnabled()`, `useGitDiffViewOpen()`,
  `showWorktreeSetupConfig` state, every worktree-state derivation, the
  header worktree / branch chip, and the `<WorktreeSetupCommandDialog />`,
  `<BranchTypeahead />`, `<GitDiffModal />` mounts.
- Modify `src/routes/__root.tsx` — audit for worktree / branch chrome.
- Modify `src/components/views/ProjectDialog.tsx` — remove
  `worktreeSetupCommand` state, input field, and mutation payload.
- Modify `src/components/views/TaskCard.tsx`, `SessionGrid.tsx`,
  `TerminalPanel.tsx`, `TerminalPane.tsx` — strip worktree / branch
  badges, labels, and spawn-option plumbing that is UI-only.
- Modify `src/lib/keybindings/defaults.ts` + `groups.ts` — remove
  `git.diff`; audit `src/lib/hideable-elements.tsx` /
  `src/shared/header-buttons.ts` for git-diff / worktree entries.
- Modify `src/styles.css` — drop the "New worktree" row comment/rule.

**Acceptance criteria.**
- `rg "GitDiffView|GitDiffModal|ChangedFilesList|DiffPane|BranchTypeahead|WorktreeSetupCommandDialog" src/` returns hits only inside
  `src/lib/git-diff-view-store.ts` (+ its test) and the server/shared git
  modules — all deleted by AC-11-02 / AC-11-04. No component file and no
  renderer import survives.
- `rg "git\.diff" src/lib/keybindings` returns zero hits.
- Header renders no worktree / branch chip; project detail mounts no git
  diff modal; task create / edit flow has no branch or worktree picker.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-11-02 — De-scope the client data layer + settings surface

**Depends on:** AC-11-01

**Summary.** Delete the worktree / git client libs and their tests, strip
worktree-awareness from every surviving store / query / helper, and prune
the four worktree / git settings keys end-to-end (shared normalizers →
settings controller → `AppSettings`). After this ticket the renderer no
longer knows what a worktree is.

**Files touched (indicative).**
- Delete: `src/lib/git-diff-view-store.ts`,
  `src/lib/use-worktrees-enabled.ts`, `src/lib/worktree-live-activity.ts`,
  `src/queries/git.ts`.
- Delete tests: `src/lib/__tests__/git-diff-view-store.test.ts`,
  `src/lib/__tests__/worktree-live-activity.test.ts`,
  `src/queries/__tests__/git.test.ts`.
- Modify `src/lib/api.ts` — remove `listWorktrees`, `createWorktree`,
  `deleteWorktree`, the `worktreeQuery()` helper, every git client method
  (`getGitStatus`, `getGitBranches`, `getGitDiff`, `stageFiles`,
  `unstageFiles`, `gitCommit`, `gitCheckout`, `gitPush`, `gitFetch`,
  `gitPull`, `gitCreatePullRequest` — verify exact names), the
  `WorktreeInfo` / `SelectedWorktreeByProject` imports, and the
  `worktreesEnabled` / `gitDiffChangedFilesView` /
  `gitDiffChangedFilesWidth` / `selectedWorktreeByProject` fields from
  `AppSettings` + the settings-update key union.
- Modify `src/shared/ui-preferences.ts` — remove
  `GitDiffChangedFilesView`, its normalizers, and
  `SelectedWorktreeByProject` + its helpers.
- Modify `src/server/controllers/settings.controller.ts` — remove the four
  keys' Zod schema entries, getters, setters, and stored-key constants
  (server side of the AppSettings convention; same PR or typecheck fails).
- Modify `src/queries/index.ts` — drop worktree query keys,
  `useWorktrees`, worktree option types, and any git query hook re-export.
- Modify (strip `worktreeId` / worktree state): `src/lib/terminal-store.tsx`,
  `user-terminal-store.tsx`, `session-warm-pool.ts`,
  `user-terminal-warm-pool.ts`, `ui-preference-cache.ts`,
  `archive-session.ts`, `optimistic-task.ts`, `scoped-project.ts`,
  `use-fleet.ts`, `grid-layout-prefs.ts`,
  `ship-operations.ts` (drop the `worktreeId` param — `shipKey(projectId)`
  only), `shell-query-cache.ts`, `core-pty-bridge.ts` (audit),
  `src/routes/focus.$taskId.tsx`.
- Modify settings pages fixtures: `GeneralSettingsPage.tsx`,
  `TerminalSettingsPage.tsx`, `ThemeSettingsPage.tsx`,
  `DefaultsSettingsPage.tsx` (audit).
- Trim tests (keep files): `src/lib/__tests__/terminal-store.test.ts`,
  `user-terminal-store.test.ts`, `session-warm-pool.test.ts`,
  `user-terminal-warm-pool.test.ts`, `session-notification-store.test.ts`,
  `use-session-finish-notifications.test.ts` (+ `.integration`),
  `api.test.ts`, `agent-command.test.ts`, `optimistic-task.test.ts`,
  `shell-query-cache.test.ts`, `sort-projects.test.ts`,
  `ship-operations.test.ts`.

**Acceptance criteria.**
- `rg -i "worktree" src/lib src/queries src/routes src/components` returns
  hits only in (a) the session-finish notification chain
  (`session-notification-store.ts`, `use-session-finish-notifications.tsx`,
  `os-notifications.ts` + their tests) — those types mirror the electron
  contract and leave with it in AC-11-03 — and (b) transitional
  `worktreeId: null` / `worktreeSetupCommand: null` row literals, which are
  still Drizzle columns until AC-11-05.
- `rg "worktreesEnabled|gitDiffChangedFiles|selectedWorktreeByProject|SelectedWorktreeByProject" src/` returns zero hits.
- `rg "GitDiff|git\.diff|git\.status|git\.branches" src/` returns hits only
  in the server git service/controller + shared git-status (deleted in
  AC-11-04).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The scope-key format `${projectId}:main` is frozen in
`scoped-project.ts` — persisted grid layouts and active-session keys were
written under it, so the literal survives the concept (mirrors spec 10's
frozen home-bucket key). The server-side git / worktree API keeps serving
until AC-11-04; it is caller-less after this ticket.

---

## AC-11-03 — Strip worktree from electron + shared contracts

**Depends on:** AC-11-02

**Summary.** Remove `worktreeId` from the electron main process, the
session-finish notification path, the PTY spawn path, the preload bridge,
and the shared electron contract. The notification body simplifies to
project + task title. Audit confirms no `git:*` / worktree IPC channels
exist (the renderer talked HTTP) — the audit itself is the deliverable.

**Files touched (indicative).**
- Modify `electron/main.ts` — remove `worktreeId` extraction in the
  session-finish notification path; audit for any `git:*` handler.
- Modify `electron/session-finish-notification.ts` — remove `worktreeId`
  from the notification tag key and body composition.
- Modify `electron/pty-manager.ts` — strip `worktreeId`-aware spawn / cwd
  resolution.
- Modify `electron/preload.ts` — drop any `electron.git.*` /
  `electron.worktrees.*` namespace and worktree fields in type mirrors.
- Modify `electron/ipc-channels.ts` — audit; delete any git / worktree
  channel found.
- Modify `src/shared/electron-contract.ts` — remove `worktreeId` from
  `PtySpawnOptions` and any surviving payload type.
- Modify `src/shared/mission-control-hook-env.ts` — remove `worktreeId`
  from the hook-env interchange type (audit; may already be absent).
- Trim tests: `electron/__tests__/pty-manager.test.ts`,
  `electron/__tests__/session-finish-notification.test.ts`.

**Acceptance criteria.**
- `rg -i "worktree" electron/` returns zero hits.
- `rg "worktreeId" src/shared/electron-contract.ts src/shared/mission-control-hook-env.ts` returns zero hits.
- `electron/ipc-channels.ts` exports no git or worktree channel;
  `electron/preload.ts` exports no `electron.git` / `electron.worktrees`.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-11-04 — Remove the server worktree + git API, services, shared domain

**Depends on:** AC-11-03

**Summary.** Delete the worktree and git services, controllers, and
repository plus their tests; drop the three worktree routes and eleven git
routes from the API router; strip `worktreeId` from tasks / user-terminals
services, controllers, repos, and event shapes; strip `branch` /
`worktreeSetupCommand` from the projects service / controller; delete the
shared worktree and git-status domain modules. `schema.ts` still carries
the table / columns until AC-11-05; services simply stop reading and
writing them.

**Files touched (indicative).**
- Delete: `src/server/services/worktrees.ts`, `src/server/services/git.ts`,
  `src/server/controllers/worktrees.controller.ts`,
  `src/server/controllers/git.controller.ts`,
  `src/server/repositories/worktrees.repo.ts`.
- Delete tests: `src/server/services/__tests__/worktrees.test.ts`,
  `git.test.ts`, `git-repository.test.ts`.
- Delete: `src/shared/worktrees.ts`, `src/shared/git-status.ts`,
  `src/shared/__tests__/git-status.test.ts`.
- Modify `src/server/api-router.ts` — drop `worktreesController` /
  `gitController` imports, `PROJECT_WORKTREES_PATH` /
  `PROJECT_WORKTREE_PATH` regexes, and the git action dispatch (`status`,
  `branches`, `diff`, `stage`, `unstage`, `commit`, `push`, `fetch`,
  `pull`, `create-pr`, `checkout`).
- Modify services: `tasks.ts`, `user-terminals.ts` (drop `worktreeId`
  from create / update / spawn / list signatures, DB writes, query
  filters), `projects.ts` (drop `branch` / `worktreeSetupCommand`),
  `_spawn.ts` (strip worktree-path awareness).
- Modify controllers: `tasks.controller.ts`, `user-terminals.controller.ts`
  (drop `worktreeId` from Zod schemas + list queries),
  `projects.controller.ts` (drop `branch` / `worktreeSetupCommand`),
  `_helpers.ts` (remove worktree query helper),
  `project-file.controller.ts` (audit).
- Modify `src/server/events.ts` — delete `worktree:created` /
  `worktree:deleted` event types and the `worktreeId` field on the task
  event shape.
- Modify repos: `tasks.repo.ts`, `user-terminals.repo.ts`,
  `home-terminals.repo.ts` — strip `worktreeId` selects / filters.
- Modify `src/shared/projects.ts`, `src/shared/harness-mutations.ts`,
  `src/shared/core-link-frames.ts`, `src/shared/statusline-tap.ts` — strip
  worktree fields / stale comments.
- Trim tests (keep files): `src/server/services/__tests__/tasks.test.ts`,
  `user-terminals.test.ts`, `projects.test.ts`, `home-terminals.test.ts`,
  `path-security.test.ts`, `project-images.test.ts`,
  `src/server/__tests__/task-status-sweep.test.ts`, `settings-api.test.ts`,
  `task-title-api.test.ts`, `agent-hooks-api.test.ts`,
  `ask-user-question-api.test.ts`, `opencode-hooks-api.test.ts`,
  `src/shared/__tests__/harness-mutations.test.ts`.

**Acceptance criteria.**
- Every `/api/projects/:id/worktrees*` and `/api/projects/:id/git/*` route
  404s.
- `rg -i "worktree" src/server src/shared` returns zero hits.
- `rg "getGitStatus|listGitBranches|getGitDiff|stageFiles|unstageFiles|gitCheckout|gitPush|gitFetch|gitPull|gitCreatePullRequest" src/` returns zero hits.
- `POST /api/tasks` and `PATCH /api/projects` accept nothing named
  `worktreeId` / `branch` / `worktreeSetupCommand` (fields gone from the
  Zod schemas).
- `pnpm typecheck` and `pnpm test` green.

---

## AC-11-05 — Drop the worktree schema: table, columns, indexes + boot-time cleanup

**Depends on:** AC-11-04

**Summary.** The forward-only schema cutover. `schema.ts` loses the
`worktrees` table, its relations, `tasks.worktreeId`,
`user_terminals.worktreeId`, `projects.branch`,
`projects.worktreeSetupCommand`, and every index referencing them.
`schema-bootstrap.ts` is updated so fresh installs match, and gains an
idempotent `dropLegacyWorktreeSchema(sqlite)` boot-time helper
(pragma-guarded column drops + `DROP TABLE IF EXISTS worktrees` + index
drops + `DELETE` of the worktree / git `app_settings` rows under their
real snake_case keys) — the ADR-0007 replacement for the spec's sketched
`0027_remove_worktree_and_git.sql`.

**Files touched (indicative).**
- Modify `src/db/schema.ts` — drop the `worktrees` table + relations, the
  four columns, and their indexes (`worktrees_project_idx`,
  `worktrees_project_name_unique`, `tasks_project_worktree_idx`,
  `tasks_worktree_idx`, `user_terminals_project_worktree_idx`,
  `user_terminals_worktree_idx` — verify exact names at cut-time).
- Modify `src/db/schema-bootstrap.ts` — remove worktree DDL from the fresh
  bootstrap; add `dropLegacyWorktreeSchema(sqlite)` called from
  `ensureSchema` alongside the other `dropLegacy*` helpers; document the
  one-release retention.
- Modify / add `src/db/__tests__/` coverage for the cleanup helper
  (mirror the spec-10 pattern).

**Acceptance criteria.**
- Fresh DB from `schema-bootstrap.ts` has no `worktrees` table, no
  `worktree_id` on `tasks` / `user_terminals`, no `branch` /
  `worktree_setup_command` on `projects`.
- Booting against a pre-cutover SQLite drops the table, columns, indexes,
  and settings rows, idempotently.
- `rg "worktreeId|worktree_id" src electron` returns hits only inside
  `dropLegacyWorktreeSchema` and immutable historical migration files
  under `src/db/migrations/` (e.g. `0010_worktrees.sql` — migration
  history is never rewritten).
- `rg -i "worktree" src electron scripts` returns hits only in the cleanup
  helper and immutable migrations.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-10-06, the cleanup block stays in the tree for one
release, then is removed by a follow-up.

---

## AC-11-06 — Docs + divergence bookkeeping

**Depends on:** AC-11-05

**Summary.** Paperwork. Delete the worktree implementation plan, promote
the worktree + git-diff subsystem to a NON-EXISTENT axis in
`DIVERGENCE.md`, move the deleted files from UNTOUCHED to REMOVED in
`PROVENANCE.md`, and run the parent spec's full verification checklist.

**Files touched (indicative).**
- Delete: `docs/worktree-implementation-plan.md`.
- Modify `docs/upstream/DIVERGENCE.md` — NON-EXISTENT axis: upstream
  commits under `src/server/services/worktrees.ts`,
  `src/server/services/git.ts`, `src/components/views/GitDiffView/`,
  `BranchTypeahead.tsx`, `WorktreeSetupCommandDialog.tsx`, or migrations
  that create / extend the `worktrees` table are permanently ignored.
- Modify `docs/upstream/PROVENANCE.md` — worktree + git-diff files
  UNTOUCHED → REMOVED.
- Audit `package.json` `devDependencies` for git-diff parsing libraries
  (none found at inventory time — confirm).

**Acceptance criteria.**
- `rg -i "worktree" src electron scripts` returns hits only inside
  `dropLegacyWorktreeSchema` (+ its db test), immutable migration files,
  and the one documented exception: `src/lib/scoped-project.ts`'s comment
  explaining the frozen `${projectId}:main` scope-key literal.
- `rg "worktree_setup_command|worktreeSetupCommand" . -g '!node_modules' -g '!docs/**' -g '!.scratch/**'`
  returns hits only in immutable migrations and the cleanup helper.
- `DIVERGENCE.md` / `PROVENANCE.md` reflect the removal.
- `pnpm typecheck` and `pnpm test` green.
