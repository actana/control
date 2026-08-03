# Tickets — Spec 10 (Remove the managed sandbox / remote VM subsystem)

Parent spec: [`../specs/10-remove-sandbox.md`](../specs/10-remove-sandbox.md).
Decision record: [ADR 0009](../adr/0009-remove-managed-sandbox.md).

Seven tickets. Ordered top-down so each commit leaves `pnpm typecheck` and
`pnpm test` green: renderer mounts first, then client libs/stores/queries,
then the electron engine + IPC + preload contract, then the CLI + npm
dependency, then the server API + services + shared domain, then the DB
schema, and finally docs / divergence bookkeeping.

> **Migration convention.** The parent spec sketches
> `0026_remove_sandboxes.sql`. Per ADR 0007 and the cross-spec convention in
> [`README.md`](./README.md), that lands as an idempotent boot-time helper
> (`dropLegacySandboxSchema`) in `src/db/schema-bootstrap.ts` instead — same
> shape as `dropLegacyConvenienceSurfaces` (spec 07), guarded on
> `pragma_table_info` for the column drops. No numbered SQL migration files.

> **Beyond the spec's file list.** `scripts/golden-ami-manifest.json` is the
> offline AMI fallback consumed only by `scripts/remote-vm.mjs` — it is
> deleted with the CLI (AC-10-04). The `preremote-vm` package script and the
> build-files entry for `scripts/remote-vm.mjs` in `package.json` come out
> there too.

---

## AC-10-01 — Unmount sandbox UI from the renderer

**Depends on:** —

**Summary.** Take every sandbox surface off the screen without touching the
client data layer, electron, IPC, or the server. Deletes the eight sandbox
view components + `ScopeDropdown`, their component-only flow hooks, and
unmounts them from `__root.tsx` / `projects.$id.tsx`. The scope dropdown
disappears from the header; the project list becomes a flat single-scope
view. The backing libs (`sandbox-runtime`, `optimistic-sandbox`,
`queryKeys.sandboxes`, …) stay wired until AC-10-02.

**Files touched (indicative).**
- Delete: `src/components/views/SandboxProvisioningState.tsx`,
  `SandboxConfigModal.tsx`, `SandboxConfigPanel.tsx`,
  `SandboxCloneOfferBanner.tsx`, `SandboxResumingOverlay.tsx`,
  `ConnectSandboxDialog.tsx`, `ProjectSandboxDialog.tsx`,
  `ScopeDropdown.tsx`.
- Delete: `src/lib/use-project-sandbox-flow.tsx`,
  `src/lib/use-connect-sandbox-flow.tsx`,
  `src/lib/use-remote-vm-deploy-for-sandbox.ts`,
  `src/lib/use-sandbox-clone-confirm.ts`.
- Modify `src/routes/__root.tsx` — drop `useScopedProjects` /
  `useSandboxes` / `SandboxResumingOverlay` / `ScopeDropdown` imports, the
  `activeSandbox` / `activeResuming` derivations, the `<ScopeDropdown />`
  mount, and the `{activeResuming && …}` overlay render.
- Modify `src/routes/projects.$id.tsx` — remove `isDockerSandboxRuntime`,
  `useSandboxes`, `SandboxProvisioningState`, `useRemoteVmDeployForSandbox`,
  `activateSandboxScope` imports; delete the sandbox-state derivations
  (`activeRuntimeSandbox`, `sandboxUsableForProject`, `deploySandboxId`,
  `sandboxProvisioning`, `wasSandboxProvisioningRef`), the
  `activateSandboxScope()` call in the project-switch handler, the
  `isDockerSandboxRuntime()` branch, and the `<SandboxProvisioningState />`
  mount.
- Modify remaining views that render sandbox affordances:
  `ProjectBar.tsx`, `ProjectPicker.tsx`, `SessionGrid.tsx`,
  `TerminalPane.tsx`, `TerminalPanel.tsx`, `GitDiffView/index.tsx`,
  `BranchTypeahead.tsx`, `GroupFilterChips.tsx`, `Spinner.tsx`,
  `settings-panel-ids.ts` — strip sandbox props / branches / panel ids.
- Modify `src/router.tsx` — drop any sandbox-flagged route or preload.

**Acceptance criteria.**
- `rg "SandboxProvisioningState|SandboxConfigModal|SandboxConfigPanel|SandboxCloneOfferBanner|SandboxResumingOverlay|ConnectSandboxDialog|ProjectSandboxDialog|ScopeDropdown" src/` returns zero hits.
- `rg "use-project-sandbox-flow|use-connect-sandbox-flow|use-remote-vm-deploy-for-sandbox|use-sandbox-clone-confirm" src/` returns zero hits.
- `rg "useSandboxes|sandboxesQueryOptions|sandboxState" src/components src/routes` returns zero hits — no renderer surface reads sandbox state anymore.
- Header renders no scope dropdown; project detail renders no provisioning
  state.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The scope *threading* (`activeRuntimeScopeId`,
`LOCAL_SCOPE_ID` pinning into query keys / task caches / terminal
payloads) survives this ticket pinned to the local scope constant — the
data-layer parameter removal is AC-10-02. Only the sandbox *state* reads
and UI mounts go here.

---

## AC-10-02 — De-scope the client data layer

**Depends on:** AC-10-01

**Summary.** Delete the sandbox client libs and their tests, and strip
scope-awareness from every store / query / helper that survives. After this
ticket the renderer no longer knows what a scope or sandbox is: `api.ts`
loses the seven sandbox client methods, `queries/index.ts` loses
`queryKeys.sandboxes` / `sandboxesQueryOptions` / `useScopedProjects`, and
the terminal/session stores operate on the single implicit local scope.
The `window.electron.sandbox` / `remoteVm` / `remotePty` / `remoteFs` /
`remoteGit` bridges become caller-less (they come out in AC-10-03).

**Files touched (indicative).**
- Delete: `src/lib/activate-sandbox-scope.ts`, `optimistic-sandbox.ts`,
  `sandbox-busy.ts`, `sandbox-runtime.ts`, `project-sandbox-create.ts`,
  `project-scoped-sandboxes.ts`, `remote-vm-deploy.ts`,
  `remote-runtime-errors.ts`, `scoped-project.ts` (if nothing non-sandbox
  imports it).
- Delete tests: `src/lib/__tests__/activate-sandbox-scope.test.ts`,
  `optimistic-sandbox.test.ts`, `project-sandbox-create.test.ts`,
  `project-scoped-sandboxes.test.ts`, `remote-vm-deploy.test.ts`,
  `sandbox-busy.test.ts`, `sandbox-runtime.test.ts`.
- Modify `src/lib/api.ts` — remove the `SandboxPublicView` import and
  `listSandboxes`, `connectSandbox`, `updateSandbox`,
  `revealSandboxApiKey`, `deleteSandbox`, `setActiveScope`,
  `setSandboxSystemEnabled`; strip `scopeId` from `scopedWorktreeQuery`
  (or remove the helper if it becomes trivial).
- Modify `src/queries/index.ts` — drop `filterProjectsByScope` /
  `LOCAL_SCOPE_ID` imports, `queryKeys.sandboxes`, `sandboxId: null`
  defaults, `sandboxesQueryOptions`, `useScopedProjects` (or thin-wrap to
  `useProjects`).
- Modify (strip sandbox/scope awareness): `src/lib/core-pty-bridge.ts`,
  `terminal-store.tsx`, `user-terminal-store.tsx`, `terminal-surface-cache.ts`,
  `session-warm-pool.ts`, `user-terminal-warm-pool.ts`,
  `session-notification-store.ts`, `shell-query-cache.ts`,
  `archive-session.ts`, `use-session-finish-notifications.tsx`,
  `design-meta.ts`, `use-fleet.ts`, `optimistic-task.ts`, `active-group.ts`,
  `project-git.ts`, `project-fs.ts`, `use-diagram-events.tsx`,
  `src/queries/git.ts`, `src/routes/focus.$taskId.tsx`.
- Trim tests (keep files): `src/lib/__tests__/agent-command.test.ts`,
  `shell-query-cache.test.ts`, `sort-projects.test.ts`,
  `worktree-live-activity.test.ts`, `optimistic-task.test.ts`,
  `project-fs.test.ts`, `project-git.test.ts`, `session-warm-pool.test.ts`,
  `user-terminal-warm-pool.test.ts`, `session-notification-store.test.ts`,
  `terminal-store.test.ts`.

**Acceptance criteria.**
- `rg -i "sandbox" src/lib src/queries src/routes` returns zero hits.
- `rg "scopeId|LOCAL_SCOPE_ID|filterProjectsByScope" src/lib src/queries src/routes src/components` returns zero hits.
- `rg "remotePty|remoteFs|remoteGit|remoteVm" src/lib src/queries src/routes src/components` returns zero hits.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `src/lib/remote-vm-script.test.ts` is **not** deleted here — it
tests `scripts/remote-vm.mjs` and leaves with the CLI in AC-10-04.
Transitional `scopeId: "local"` / `sandboxId: null` literals survive where a
`Task` / `UserTerminal` / `Project` object is constructed — those fields are
still on the Drizzle schema until AC-10-06 drops the columns; the literals
leave with them.

---

## AC-10-03 — Delete the electron sandbox stack + 48 IPC channels + preload bridges + contract types

**Depends on:** AC-10-02

**Summary.** Cut the engine. Deletes the seven `electron/sandbox-*.ts`
modules and their six test files, every `sandbox:*` (19), `remoteVm:*` (11),
`remotePty:*` (9), `remoteFs:*` (6), `remoteGit:*` (3) channel from
`ipc-channels.ts`, the `electron.sandbox` / `remoteVm` / `remotePty` /
`remoteFs` / `remoteGit` preload namespaces, the `remoteVm*` helpers and
`RemoteVmDeployJob` plumbing in `main.ts`, and the sandbox types in
`src/shared/electron-contract.ts` — atomically, because the preload type
mirrors only reconcile if contract and bridge go together. Renderer callers
are already gone (AC-10-01/02).

**Files touched (indicative).**
- Delete: `electron/sandbox-agent-client.ts`, `sandbox-manager.ts`,
  `sandbox-registry.ts`, `sandbox-settings.ts`, `sandbox-store.ts`,
  `sandbox-connect-errors.ts`, `sandbox-types.ts`.
- Delete tests: `electron/__tests__/sandbox-agent-client.test.ts`,
  `sandbox-agent-creds.test.ts`, `sandbox-manager.test.ts`,
  `sandbox-registry.test.ts`, `sandbox-connect-errors.test.ts`,
  `sandbox-settings.test.ts`.
- Modify `electron/main.ts` — remove `registerSandboxManager` /
  `disposeSandboxManager` wiring, `remoteVmSpawnEnv`,
  `remoteVmScriptCandidates`, `remoteVmScriptPath`, `remoteVmSpawnCwd`,
  `remoteVmDeployInputWithSandboxId`, the `RemoteVmDeployJob` type +
  `remoteVmDeployJobs` Map, and every `remoteVm:*` / `sandbox:*` handler.
- Modify `electron/preload.ts` — drop the `sandbox`, `remoteVm`,
  `remotePty`, `remoteFs`, `remoteGit` namespaces and their type mirrors.
- Modify `electron/ipc-channels.ts` — delete all 48 channels enumerated in
  the parent spec's IPC section.
- Modify `src/shared/electron-contract.ts` — remove `SandboxRuntimeMode`,
  `SandboxGitAuthMode`, `SandboxImageStrategy`, `SandboxState`,
  `SandboxSettingsBridge`, `RemotePtySpawnOptions`, and any `remoteVm*` /
  `remoteFs*` / `remoteGit*` payload types.
- Audit + strip `sandboxId` / `scopeId`: `electron/pty-core-link-client.ts`,
  `pty-core-link-server.ts`, `pty-output-batch.ts`, `pty-hook-env.ts`,
  `core-registry-store.ts`, `app-settings-store.ts`, `api-token-store.ts`,
  `electron/tsconfig.json`. Anything that only distinguishes "sandbox PTY"
  from "local PTY" collapses to the local path.

**Acceptance criteria.**
- `rg "sandbox:|remoteVm:|remotePty:|remoteFs:|remoteGit:" electron/ src/shared/` returns zero feature hits — the only survivors are Electron's own Chromium `sandbox: false` webPreference and comments about it (an unrelated concept that stays).
- `rg -i "sandbox" electron/` returns only the Chromium-sandbox hits above and the `electron/tsconfig.json` include for `../src/shared/sandbox.ts` (the file is still imported by server/db code until AC-10-05/06; the include leaves with it).
- `rg "remoteVm|RemoteVm|remotePty|RemotePty|remoteFs|RemoteFs|remoteGit|RemoteGit" electron/ src/` returns hits only in `src/lib/remote-vm-script.test.ts` (leaves in AC-10-04) and `src/shared/sandbox.ts` (leaves in AC-10-05).
- `electron/ipc-channels.ts` exports no `sandbox:*` / `remoteVm:*` /
  `remotePty:*` / `remoteFs:*` / `remoteGit:*` channel;
  `window.electron.sandbox` etc. no longer exist at runtime.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-10-04 — Remove the remote-VM CLI + `@agentsystemlabs/mission-control-agent`

**Depends on:** AC-10-03

**Summary.** Delete the AWS EC2 provisioning CLI, its offline AMI manifest,
its test, and the npm dependency the sandbox installed on VMs. AWS CLI
stops being an implicit prerequisite for any workflow. This also dissolves
spec 09's "publish `@qcentic/actana-control-agent` first" blocker (struck
in AC-10-07).

**Files touched (indicative).**
- Delete: `scripts/remote-vm.mjs`, `scripts/golden-ami-manifest.json`,
  `src/lib/remote-vm-script.test.ts`.
- Modify `package.json` — drop the `remote-vm` and `preremote-vm` scripts,
  the `scripts/remote-vm.mjs` build-files entry, and
  `"@agentsystemlabs/mission-control-agent"` from `dependencies`; refresh
  `pnpm-lock.yaml`.

**Acceptance criteria.**
- `rg "remote-vm|remoteVm|RemoteVm" src electron scripts package.json` returns hits only inside the sandbox server/db/shared files that AC-10-05 and AC-10-06 delete (`src/server/**`, `src/db/**`, `src/shared/sandbox*`).
- `rg "@agentsystemlabs/mission-control-agent" . -g '!node_modules' -g '!pnpm-lock.yaml' -g '!docs/upstream/**'` returns zero hits (docs/upstream historical notes excepted; lock refreshed).
- `rg "golden-ami" . -g '!node_modules'` returns zero hits outside deleted docs (which leave in AC-10-07).
- `pnpm remote-vm` is no longer a script; `pnpm install` succeeds without
  the agent package.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-10-05 — Remove the server sandbox API + de-scope services + shared domain

**Depends on:** AC-10-04

**Summary.** Delete the server sandbox stack (service, scope service,
controller, repository, API tests) and the shared sandbox domain modules,
drop the seven `/api/sandboxes*` routes, and strip `scopeId` / `sandboxId`
from every surviving service, controller, repository, Zod schema, and
interchange type. Queries fall back to the single implicit local scope.
`schema.ts` still carries the columns until AC-10-06; services simply stop
reading and writing them.

**Files touched (indicative).**
- Delete: `src/server/services/sandboxes.ts`, `sandbox-scope.ts`,
  `src/server/controllers/sandboxes.controller.ts`,
  `src/server/repositories/sandboxes.repo.ts`,
  `src/server/__tests__/sandboxes-api.test.ts`.
- Delete: `src/shared/sandbox-agent-upgrade.ts`, `sandbox-workspace.ts` +
  the three sandbox tests in `src/shared/__tests__/`. `src/shared/sandbox.ts`
  itself survives until AC-10-06 — `src/db/schema.ts` / `schema-bootstrap.ts` /
  `migrate-multi-sandbox.ts` still import its type + scope constants until the
  columns drop.
- Modify `src/server/api-router.ts` — drop the `sandboxesController`
  import, `SANDBOX_PATH` / `SANDBOX_API_KEY_PATH` regexes, and all seven
  sandbox route handlers.
- Modify services: `projects.ts`, `tasks.ts`, `user-terminals.ts`,
  `home-terminals.ts`, `project-memory.ts` — remove `scopeId` / `sandboxId`
  from create/update signatures, DB writes, and query filters. Audit
  `proactive-recall.ts`, `code-graph-*.ts`, `graph-watcher.ts`,
  `graph-auto-index.ts`, `claude-usage-limits.ts`, `git.ts` for scope
  filtering.
- Modify controllers + repos: `projects.controller.ts`,
  `tasks.controller.ts`, `user-terminals.controller.ts`,
  `home-terminals.controller.ts`, `_helpers.ts`, `projects.repo.ts`,
  `tasks.repo.ts`, `user-terminals.repo.ts`, `home-terminals.repo.ts`,
  `events.ts`, `auth.ts` — drop `sandboxId` / `scopeId` from Zod schemas,
  payloads, and event shapes.
- Modify shared interchange types: `src/shared/project-memory.ts`,
  `git-status.ts`, `mission-control-hook-env.ts` — drop `scopeId` fields;
  trim `src/shared/__tests__/mission-control-hook-env.test.ts`.
- Trim tests (keep files): `src/server/services/__tests__/projects.test.ts`,
  `tasks.test.ts`, `user-terminals.test.ts`, `home-terminals.test.ts`,
  `proactive-recall.test.ts`, `src/server/__tests__/origin-gate.test.ts`,
  `task-status-sweep.test.ts`.

**Acceptance criteria.**
- `GET/POST/PUT/PATCH/DELETE /api/sandboxes*` all 404.
- `rg -i "sandbox" src/server src/shared` returns hits only in `src/shared/sandbox.ts` (leaves in AC-10-06), `src/shared/harness-mutations.ts` (raw `scope_id` INSERT column, reconciled with the schema drop in AC-10-06), generic-English "sandboxed iframe" comments in `auth.ts` / `origin-gate.test.ts`, and the transitional `scopeId: "local"` / `sandboxId: null` row literals.
- `rg "scopeId|LOCAL_SCOPE_ID|filterProjectsByScope" src electron` returns hits only in `src/db/` and the transitional literals above (all removed in AC-10-06).
- `POST/PATCH /api/projects` and `/api/tasks` reject nothing and accept
  nothing named `sandboxId` / `scopeId` (fields gone from the Zod schemas).
- `pnpm typecheck` and `pnpm test` green.

---

## AC-10-06 — Drop the sandbox schema: table, columns, indexes + boot-time cleanup

**Depends on:** AC-10-05

**Summary.** The forward-only schema cutover. `schema.ts` loses the
`sandboxes` table, `sandboxesRelations`, `projects.sandboxId`,
`tasks.scopeId`, `user_terminals.scopeId`, `home_terminals.scopeId`,
`project_memory.scopeId`, and their five indexes. `schema-bootstrap.ts` is
updated so fresh installs match, and gains an idempotent
`dropLegacySandboxSchema(sqlite)` boot-time helper (pragma-guarded column
drops + `DROP TABLE IF EXISTS sandboxes` + `DELETE` of sandbox-related
`app_settings` keys) — the ADR-0007 replacement for the spec's sketched
`0026_remove_sandboxes.sql`.

**Files touched (indicative).**
- Delete: `src/db/migrate-multi-sandbox.ts`,
  `src/db/__tests__/bootstrap-existing-sandbox-id.test.ts`,
  `src/db/__tests__/migrate-multi-sandbox.test.ts`.
- Modify `src/db/schema.ts` — drop the `sandboxes` table,
  `sandboxesRelations`, the five columns and five indexes listed above.
- Modify `src/db/schema-bootstrap.ts` — remove sandbox DDL from the fresh
  bootstrap; remove any `migrate-multi-sandbox` call; add
  `dropLegacySandboxSchema(sqlite)` called from `ensureSchema` alongside
  the other `dropLegacy*` helpers; document the one-release retention.
- Modify `src/db/client.ts` — audit for sandbox bootstrap references.

**Acceptance criteria.**
- Fresh DB from `schema-bootstrap.ts` has no `sandboxes` table and no
  `sandbox_id` / `scope_id` columns on `projects`, `tasks`,
  `user_terminals`, `home_terminals`, `project_memory`.
- Booting against a pre-cutover SQLite drops the table, the five columns,
  the five indexes, and the sandbox `app_settings` rows, idempotently.
- `rg -i "sandbox" src/db` returns hits only inside
  `dropLegacySandboxSchema` (the boot-time cleanup itself).
- `rg "scopeId|scope_id" src electron` returns hits only inside
  `dropLegacySandboxSchema` and immutable historical migration files under
  `src/db/migrations/` (0017_prompts.sql ships a `scope_id` column on the
  prompts table that spec 07's boot cleanup already drops — migration
  history is never rewritten).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-06-05, the cleanup block stays in the tree for one
release, then is removed by a follow-up (tracked as AC-CLEANUP-01 in the
rebrand set).

---

## AC-10-07 — Docs, divergence bookkeeping, spec 09 unblock

**Depends on:** AC-10-06

**Summary.** Paperwork. Delete the four sandbox docs, promote the sandbox
subsystem to a NON-EXISTENT axis in `DIVERGENCE.md`, move the deleted files
from UNTOUCHED to REMOVED in `PROVENANCE.md`, and update spec 09 to strike
the `@qcentic/actana-control-agent` publish blocker (the VM install path no
longer exists) while noting the dependency on this spec.

**Files touched (indicative).**
- Delete: `docs/project-sandbox-aws-flow.md`,
  `docs/digitalocean-sandboxes-plan.md`, `docs/remote-vm-cli.md`,
  `daytona-hosted-removal-plan.md` (verify no cross-references first).
- Modify `docs/upstream/DIVERGENCE.md` — NON-EXISTENT axis: upstream
  commits under `src/server/services/sandboxes.ts`, `src/shared/sandbox*`,
  `electron/sandbox-*.ts`, `scripts/remote-vm.mjs`, and
  `@agentsystemlabs/mission-control-agent` bumps are permanently ignored.
- Modify `docs/upstream/PROVENANCE.md` — sandbox files UNTOUCHED → REMOVED.
- Modify `docs/specs/09-rebrand-and-auto-update.md` — strike the
  agent-bridge rename / package-publish prerequisite; note spec-10
  dependency.
- Audit developer-onboarding docs for Docker-as-sandbox-prerequisite
  mentions and remove them.

**Acceptance criteria.**
- All four docs gone; `rg -il "sandbox" docs/ *.md` returns only content
  that intentionally describes the removal (specs / tickets / ADRs /
  upstream history / `domain-model.md`'s removal note), the annotated
  historical `refactor-plan.md`, upstream `CHANGELOG.md`, and INSTALL.md's
  Electron/Chromium `--no-sandbox` guidance (an unrelated concept).
- `rg -i "sandbox" src electron scripts` returns hits only inside the
  `dropLegacySandboxSchema` cleanup block in `src/db/schema-bootstrap.ts`,
  Electron's Chromium `sandbox: false` webPreference (+ comments about it),
  and generic-English "sandboxed iframe" comments in the origin gate.
- Spec 09 no longer lists the agent package publish as a blocker.
- `pnpm typecheck` and `pnpm test` green.
