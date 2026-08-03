# 11 — Remove worktree management and git integration

## Overview

Rip out every worktree and git surface the Panel currently owns: the
`worktrees` table and its FK columns on `tasks` / `user_terminals`, the
worktree service / controller / repo, the git service / controller and its
diff, branch, status, stage/unstage, push/fetch/pull, and create-PR
endpoints, the `GitDiffView` modal + `BranchTypeahead` + `WorktreeSetupCommandDialog`
components, the header chip showing "current worktree / branch," the
worktree-scoped session / terminal routing, and the per-task `worktreeId`
binding. Actana Control is a Harness remote control (ADR 0007): source-control
decisions — which branch, which worktree, when to diff, when to push — belong
to whatever tool the operator uses on the machine that hosts the Harness
(their IDE, `git`, `jj`, whatever), not to a floating remote-control window.
The Harness itself may run `git` internally as part of a session; the Panel
does not need to observe or manipulate that.

Hard forward-only cutover: no feature flag, no dual-schema window, no
export-your-worktree-list migration path. Any task previously bound to a
non-default worktree collapses to the project's single implicit path after
migration.

## Ordering / prerequisites

Depends on **spec 10 (remove sandbox)** landing first. Spec 10 deletes
overlapping schema columns (`scope_id` on `tasks` / `user_terminals`) and the
`remoteGit:*` / `remoteFs:*` IPC bridges — sequencing this spec after 10
avoids merge conflicts on `src/db/schema.ts`, `electron/ipc-channels.ts`,
`electron/preload.ts`, and `src/server/api-router.ts`, and lets this spec's
migration piggyback cleanly on the schema shape spec 10 leaves behind.

## Files to delete

### Server — services / controllers / repositories

- `src/server/services/worktrees.ts`
- `src/server/services/git.ts` — every git operation (`getGitStatus`,
  `listGitBranches`, `getGitDiff`, `stageFiles`, `unstageFiles`,
  `gitCheckout`, `gitPush`, `gitFetch`, `gitPull`, `gitCreatePullRequest`)
  goes; nothing survives that would want a smaller `git.ts` around it.
- `src/server/controllers/worktrees.controller.ts`
- `src/server/controllers/git.controller.ts`
- `src/server/repositories/worktrees.repo.ts`
- `src/server/__tests__/worktrees-api.test.ts` (if present — verify at
  cut-time; otherwise the coverage lives under `services/__tests__/`)
- `src/server/services/__tests__/worktrees.test.ts`
- `src/server/services/__tests__/git.test.ts`
- `src/server/services/__tests__/git-repository.test.ts`

### Shared domain

- `src/shared/worktrees.ts` — `WorktreeInfo`, `WorktreeTaskCounts`,
  `MAIN_WORKTREE_ID`, `OPTIMISTIC_WORKTREE_ID_PREFIX`, `normalizeWorktreeId`,
  `worktreeScopeKey`.
- `src/shared/git-status.ts` — Panel no longer parses git status.
- `src/shared/__tests__/worktrees.test.ts` (if present)
- `src/shared/__tests__/git-status.test.ts` (if present)

### Client — components

- `src/components/views/WorktreeSetupCommandDialog.tsx`
- `src/components/views/BranchTypeahead.tsx`
- `src/components/views/GitDiffView/index.tsx`
- `src/components/views/GitDiffView/GitDiffModal.tsx`
- `src/components/views/GitDiffView/ChangedFilesList.tsx`
- `src/components/views/GitDiffView/DiffPane.tsx`
- (Delete the `src/components/views/GitDiffView/` directory outright — verify
  no other files remain before removal.)

### Client — hooks / stores / helpers

- `src/lib/git-diff-view-store.ts`
- `src/lib/use-worktrees-enabled.ts`
- `src/lib/worktree-live-activity.ts`
- `src/lib/project-git.ts` — folded away entirely. The one caller that still
  needs a project's on-disk path uses `project.path` directly; no worktree
  path resolution exists.

### Client tests

- `src/lib/__tests__/git-diff-view-store.test.ts`
- `src/lib/__tests__/worktree-live-activity.test.ts`
- `src/lib/__tests__/project-git.test.ts`

### Docs

- `docs/worktree-implementation-plan.md`

## Files to modify

### Server / API

- `src/server/api-router.ts` — drop `worktreesController` and `gitController`
  imports; delete every worktree route (`GET/POST/DELETE
  /api/projects/:id/worktrees[/:worktreeId]`) and every git route (`/api/git/status`,
  `/api/git/branches`, `/api/git/diff`, `/api/git/stage`, `/api/git/unstage`,
  `/api/git/checkout`, `/api/git/push`, `/api/git/fetch`, `/api/git/pull`,
  `/api/git/create-pull-request` — verify exact paths at cut-time).
- `src/server/services/tasks.ts` — remove `worktreeId` from create / update
  signatures, DB writes, and query filters. Tasks scope by `projectId` only.
- `src/server/services/user-terminals.ts` — remove `worktreeId` from spawn /
  list signatures; route by `projectId` only.
- `src/server/services/projects.ts` — remove `branch` and
  `worktreeSetupCommand` from create / update payloads.
- `src/server/services/_spawn.ts` — strip any worktree-path awareness from
  shell env / cwd resolution.
- `src/server/controllers/tasks.controller.ts` — strip `worktreeId` from
  create-body Zod schema and list-query params.
- `src/server/controllers/user-terminals.controller.ts` — strip `worktreeId`
  from spawn payload and list query.
- `src/server/controllers/projects.controller.ts` — strip `branch` and
  `worktreeSetupCommand` from project-update payload schema.
- `src/server/controllers/_helpers.ts` — remove any `getWorktreeIdFromQuery`
  or similar helper.

### Electron main + preload

- `electron/main.ts` — remove `worktreeId` extraction in the session-finish
  notification path; simplify the notification body to project + task title.
  Delete any local-git IPC handlers registered here (there should be none
  after `remoteGit:*` goes with spec 10, but audit).
- `electron/preload.ts` — drop any `electron.git.*` / `electron.worktrees.*`
  namespace and its type mirror.
- `electron/ipc-channels.ts` — delete every channel enumerated in the IPC
  section below.
- `electron/pty-manager.ts` — audit for `worktreeId`-aware spawn or cwd
  resolution; strip if present.
- `electron/session-finish-notification.ts` — remove `worktreeId` from the
  notification tag key and body composition.

### Shared contracts

- `src/shared/electron-contract.ts` — remove `worktreeId` from
  `PtySpawnOptions` (and any surviving payload types after spec 10).
- `src/shared/mission-control-hook-env.ts` — remove `worktreeId` from the
  hook-env interchange type (if present after spec 10's `scopeId` strip).

### Client API + queries

- `src/lib/api.ts` — remove `WorktreeInfo` and `SelectedWorktreeByProject`
  imports; delete `listWorktrees`, `createWorktree`, `deleteWorktree`,
  `getProjectPathStatus` (if worktree-scoped), and every git client method
  (`getGitStatus`, `getGitBranches`, `getGitCheckout`, `getGitDiff`,
  `stageFiles`, `unstageFiles`, `gitPush`, `gitFetch`, `gitPull`,
  `gitCreatePullRequest`). Delete the `worktreeQuery()` helper.
  Delete `selectedWorktreeByProject` from the settings payload and the
  `SelectedWorktreeByProject` type.
- `src/queries/index.ts` — drop worktree query keys, `useWorktrees`, the
  worktree option types, and any git query hook.
- `src/lib/terminal-store.tsx` — strip `worktreeId` from spawn payload; keep
  session / task routing.
- `src/lib/use-session-finish-notifications.tsx` — remove `worktreeId` from
  the notification render; toast title becomes `Session finished — {projectName}`.
- `src/lib/ui-preference-cache.ts` — remove `selectedWorktreeByProject` key
  and its accessor exports.
- `src/lib/archive-session.ts` — audit for `worktreeId` in the archive
  payload; strip.
- `src/lib/core-pty-bridge.ts` — audit for `worktreeId` in the remote-PTY
  path; strip.

### Routes

- `src/routes/projects.$id.tsx` — delete `worktreesQuery`,
  `useWorktreesEnabled()`, `useGitDiffViewOpen()`, `showWorktreeSetupConfig`
  state, every worktree-state derivation, the header chip that renders the
  current worktree / branch, and the `<WorktreeSetupCommandDialog />`,
  `<BranchTypeahead />`, and `<GitDiffModal />` mounts.
- `src/routes/__root.tsx` — audit for any header worktree / branch chip and
  remove.
- `src/components/views/ProjectDialog.tsx` — remove `worktreeSetupCommand`
  state, input field, and mutation payload.
- `src/components/views/TaskCard.tsx` — remove worktree / branch badge from
  task row.
- `src/components/views/SessionGrid.tsx` — remove worktree scope label from
  session rows.
- `src/components/views/TerminalPanel.tsx` — remove worktree / branch context
  from terminal header.
- `src/components/views/TerminalPane.tsx` — remove `worktreeId` from spawn
  options and cwd hints.

## Schema changes

Confirmed via `src/db/schema.ts` (line numbers approximate — verify at
cut-time; post-spec-10 layout may shift them):

- `worktrees` table (~lines 101–118): `id`, `projectId`, `name`, `path`,
  `branch`, `createdAt`, `updatedAt` → **DROP TABLE**.
- Indices `worktrees_project_idx`, `worktrees_project_name_unique` →
  dropped by the table drop.
- `tasks.worktree_id` (~line 127, FK to `worktrees.id`) → **DROP COLUMN**.
- Indices on `tasks` referencing `worktree_id` (`tasks_project_worktree_idx`,
  `tasks_worktree_idx`, and any surviving `tasks_project_worktree_scope_idx`
  after spec 10) → **DROP INDEX**.
- `user_terminals.worktree_id` (~line 183) → **DROP COLUMN**.
- Indices on `user_terminals` referencing `worktree_id`
  (`user_terminals_project_worktree_idx`, `user_terminals_worktree_idx`) →
  **DROP INDEX**.
- `projects.branch` (~line 72) → **DROP COLUMN**. Projects no longer track a
  primary branch.
- `projects.worktree_setup_command` (~line 74) → **DROP COLUMN**.
- `app_settings`: `selectedWorktreeByProject` and any worktree / git-related
  keys (e.g. `gitDiffViewOpen`) → clear via the same schema-bootstrap DELETE
  pattern used by specs 04 / 05 / 07 / 10.

`src/db/schema-bootstrap.ts` must be updated so fresh installs match the
post-migration shape.

## Migration

`src/db/migrations/0027_remove_worktree_and_git.sql` (next number after
spec 10's `0026_remove_sandboxes.sql`):

```sql
-- Actana Control: remove worktree management and git-integration surface.
-- Every task / terminal previously bound to a non-default worktree
-- collapses to the project's single implicit path.

DROP INDEX IF EXISTS worktrees_project_idx;
DROP INDEX IF EXISTS worktrees_project_name_unique;
DROP INDEX IF EXISTS tasks_project_worktree_idx;
DROP INDEX IF EXISTS tasks_worktree_idx;
DROP INDEX IF EXISTS user_terminals_project_worktree_idx;
DROP INDEX IF EXISTS user_terminals_worktree_idx;

ALTER TABLE tasks DROP COLUMN worktree_id;
ALTER TABLE user_terminals DROP COLUMN worktree_id;
ALTER TABLE projects DROP COLUMN branch;
ALTER TABLE projects DROP COLUMN worktree_setup_command;

DROP TABLE IF EXISTS worktrees;

DELETE FROM app_settings WHERE key IN (
  'selectedWorktreeByProject',
  'gitDiffViewOpen'
);
```

If Drizzle rejects `DROP COLUMN` under SQLite mode, fall back to the standard
SQLite pattern (create shadow table without the column, copy, drop, rename)
— `schema.ts` is the source of truth, so `pnpm db:generate` should produce
the correct dialect-appropriate migration.

## IPC channels

All of these come out of `electron/ipc-channels.ts` and their handlers in
`electron/main.ts`.

**Worktrees**: none — worktrees never had a first-class IPC surface; the
renderer talked to the server over HTTP.

**Git (local)**: none currently registered on the Electron side — the
renderer hits the Panel HTTP API for git operations, which is deleted with
`git.controller.ts` above. Audit `electron/main.ts` at cut-time for any
`git:*` handler that may have been added post-inventory; delete if present.

**Remote git / remote FS**: covered by spec 10 (`remoteGit:*`, `remoteFs:*`)
— nothing new to remove here.

## HTTP routes

Remove from `src/server/api-router.ts`:

- `GET /api/projects/:id/worktrees`
- `POST /api/projects/:id/worktrees`
- `DELETE /api/projects/:id/worktrees/:worktreeId`
- `GET /api/git/status`
- `GET /api/git/branches`
- `GET /api/git/diff`
- `POST /api/git/stage`
- `POST /api/git/unstage`
- `POST /api/git/checkout`
- `POST /api/git/push`
- `POST /api/git/fetch`
- `POST /api/git/pull`
- `POST /api/git/create-pull-request`

(Verify each path against `git.controller.ts` at cut-time — the list above
is what the inventory found; exact route strings win.)

`POST /api/tasks` and `PATCH /api/projects` payloads: drop `worktreeId`,
`branch`, and `worktreeSetupCommand` from their Zod schemas.

## Keybindings

Audit `src/lib/keybindings/` for `git.diff.open`, `worktree.switch`, or
similar entries. Remove any that reference deleted UI. Also remove any
`gitDiffOpen` / `worktreeMenuOpen` entries from the hideable-elements list
in `src/lib/hideable-elements.ts` and the settings UI.

## Dependencies

`package.json`:

- No git-only npm dep exists — the Panel shells out to the operator's `git`
  binary. Nothing to drop from `dependencies`.
- Audit `devDependencies` for any git-diff parsing library (e.g.
  `parse-diff`, `unidiff`, `diff2html`) — remove any that were only used by
  `GitDiffView`.

## Rebrand-spec interaction

Spec 09 (rebrand-and-auto-update) is unaffected by this removal — nothing in
the rebrand ticket set touches worktree or git strings meaningfully. If
spec 09's user-facing string sweep (AC-09-03) has already landed by the
time this spec runs, verify no "worktree" / "branch" strings under `src/`
survive after this spec's UI deletions.

## Divergence bookkeeping

Update `docs/upstream/DIVERGENCE.md`: promote the worktree + git-diff
subsystem to a NON-EXISTENT axis on the fork side. Any upstream commit
under `src/server/services/worktrees.ts`, `src/server/services/git.ts`,
`src/components/views/GitDiffView/`, `src/components/views/BranchTypeahead.tsx`,
`src/components/views/WorktreeSetupCommandDialog.tsx`, or migrations that
create or extend the `worktrees` table is permanently ignored on the fork.

Update `docs/upstream/PROVENANCE.md`: worktree + git-diff files move from
UNTOUCHED to REMOVED.

## Tests to remove

- `src/server/services/__tests__/worktrees.test.ts`
- `src/server/services/__tests__/git.test.ts`
- `src/server/services/__tests__/git-repository.test.ts`
- `src/server/__tests__/worktrees-api.test.ts` (if present)
- `src/lib/__tests__/git-diff-view-store.test.ts`
- `src/lib/__tests__/worktree-live-activity.test.ts`
- `src/lib/__tests__/project-git.test.ts`
- `src/shared/__tests__/worktrees.test.ts` (if present)
- `src/shared/__tests__/git-status.test.ts` (if present)

## Tests to trim (remove worktree fixtures, keep the file)

- `src/server/services/__tests__/tasks.test.ts` — drop `worktreeId`
  fixtures.
- `src/server/services/__tests__/user-terminals.test.ts` — drop
  `worktreeId` from spawn fixtures.
- `src/server/services/__tests__/projects.test.ts` — drop `branch` and
  `worktreeSetupCommand` fixtures.
- `src/lib/__tests__/terminal-store.test.ts` — drop `worktreeId` from spawn
  mock payloads.
- `src/lib/__tests__/session-notification-store.test.ts` — update
  notification title-format assertions to exclude the worktree name.
- `src/lib/__tests__/user-terminal-warm-pool.test.ts` — drop `worktreeId`
  from spawn payloads.
- `src/lib/__tests__/session-warm-pool.test.ts` — drop worktree-scoped
  fixtures.
- `src/queries/__tests__/git.test.ts` (if present) — delete outright, since
  every git query hook is gone.

## Verification checklist

- [ ] `rg -i "worktree" src electron scripts` returns zero hits (this spec
      excepted).
- [ ] `rg "WorktreeInfo|worktreeId|worktree_id" src electron` returns zero
      hits.
- [ ] `rg "GitDiff|BranchTypeahead|git\\.diff|git\\.status|git\\.branches"
      src electron` returns zero hits.
- [ ] `rg "worktree_setup_command|worktreeSetupCommand" .` returns zero
      hits outside migrations.
- [ ] `pnpm tsc --noEmit` passes.
- [ ] `pnpm test` passes; deleted test files gone, trimmed tests green.
- [ ] Fresh DB from `schema-bootstrap.ts` has no `worktrees` table and no
      `worktree_id` on `tasks` / `user_terminals`, no `branch` /
      `worktree_setup_command` on `projects`.
- [ ] Existing DB upgrades cleanly via `0027_remove_worktree_and_git.sql`.
- [ ] `electron/ipc-channels.ts` no longer exports any git or worktree
      channel.
- [ ] `electron/preload.ts` no longer exports `electron.git` or
      `electron.worktrees`.
- [ ] Header renders no worktree / branch chip; project view is a flat
      single-path surface.
- [ ] Project detail page has no `<WorktreeSetupCommandDialog />`, no
      `<BranchTypeahead />`, and no `<GitDiffModal />` mount.
- [ ] Task create / edit flow has no branch or worktree picker; task rows
      show no worktree badge.
- [ ] Settings page has no "worktree setup command" input and no
      hideable-element toggle referencing git-diff or worktree UI.
- [ ] `docs/upstream/DIVERGENCE.md` and `PROVENANCE.md` reflect the removal.

## Follow-ups / out of scope

- **Harness-side git remains untouched.** The Harness may run `git` inside
  a session (for a coding agent, a CI step, whatever) — that is the
  Harness's concern, not the Panel's. This spec removes Panel visibility
  into that git state; it does not constrain what the Harness does with git.
- **No "read-only git status pill" is preserved.** The scope decision here
  was ALL git surface (per Q3 answer). If a lightweight "session is on
  branch X" pill is ever wanted later, it re-enters as a session-metadata
  string reported by the Harness over core-link, not as a Panel-owned git
  probe.
- **No per-task branch field.** A task is a Harness session request; branch
  selection happens Harness-side or in the operator's shell. If specific
  branch routing is ever needed, it belongs in the Harness's session-spawn
  contract, not on the Panel's Task row.
- **`docs/worktree-implementation-plan.md`** is deleted rather than moved
  to `docs/upstream/` — it was a Panel-owned design doc, not upstream
  provenance material.
