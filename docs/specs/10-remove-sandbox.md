# 10 — Remove the managed sandbox / remote VM subsystem

## Overview
Rip out the upstream "sandbox" feature end-to-end: the `sandboxes` table and every `scopeId` / `sandboxId` column layered on top of it, the Electron `SandboxManager` / `SandboxAgentClient` / `SandboxSettings` stack, the AWS EC2 provisioning CLI (`scripts/remote-vm.mjs`) and its `remoteVm:*` IPC surface, the remote-PTY / remote-FS / remote-Git RPC bridges (`remotePty:*`, `remoteFs:*`, `remoteGit:*`), the `@agentsystemlabs/mission-control-agent` runtime dependency installed on VMs, the scope dropdown in the header, and every UI mount that shows sandbox state. Managed remote work is replaced by the detached-core Harness (ADR 0001–0004): the operator stands up any machine they own, installs a Harness on it, and the Panel drives it over core-link. No feature flags, no data-migration path, hard forward-only cutover. See ADR 0009 for the decision.

## Files to delete

### Server — services / controllers / repositories
- `src/server/services/sandboxes.ts`
- `src/server/services/sandbox-scope.ts`
- `src/server/controllers/sandboxes.controller.ts`
- `src/server/repositories/sandboxes.repo.ts`
- `src/server/__tests__/sandboxes-api.test.ts`

### Shared domain
- `src/shared/sandbox.ts`
- `src/shared/sandbox-agent-upgrade.ts`
- `src/shared/sandbox-workspace.ts`
- `src/shared/__tests__/sandbox.test.ts`
- `src/shared/__tests__/sandbox-agent-upgrade.test.ts`
- `src/shared/__tests__/sandbox-workspace.test.ts`

### Client — components
- `src/components/views/SandboxProvisioningState.tsx`
- `src/components/views/SandboxConfigModal.tsx`
- `src/components/views/SandboxConfigPanel.tsx`
- `src/components/views/SandboxCloneOfferBanner.tsx`
- `src/components/views/SandboxResumingOverlay.tsx`
- `src/components/views/ConnectSandboxDialog.tsx`
- `src/components/views/ProjectSandboxDialog.tsx`
- `src/components/views/ScopeDropdown.tsx`

### Client — hooks / stores / helpers
- `src/lib/activate-sandbox-scope.ts`
- `src/lib/optimistic-sandbox.ts`
- `src/lib/sandbox-busy.ts`
- `src/lib/sandbox-runtime.ts`
- `src/lib/project-sandbox-create.ts`
- `src/lib/project-scoped-sandboxes.ts`
- `src/lib/remote-vm-deploy.ts`
- `src/lib/remote-runtime-errors.ts`
- `src/lib/use-project-sandbox-flow.tsx`
- `src/lib/use-connect-sandbox-flow.tsx`
- `src/lib/use-remote-vm-deploy-for-sandbox.ts`
- `src/lib/use-sandbox-clone-confirm.ts`
- `src/lib/remote-vm-script.test.ts`

### Client tests
- `src/lib/__tests__/activate-sandbox-scope.test.ts`
- `src/lib/__tests__/optimistic-sandbox.test.ts`
- `src/lib/__tests__/project-sandbox-create.test.ts`
- `src/lib/__tests__/project-scoped-sandboxes.test.ts`
- `src/lib/__tests__/remote-vm-deploy.test.ts`
- `src/lib/__tests__/sandbox-busy.test.ts`
- `src/lib/__tests__/sandbox-runtime.test.ts`

### DB
- `src/db/migrate-multi-sandbox.ts`
- `src/db/__tests__/bootstrap-existing-sandbox-id.test.ts`
- `src/db/__tests__/migrate-multi-sandbox.test.ts`

### Electron main-process
- `electron/sandbox-agent-client.ts`
- `electron/sandbox-manager.ts`
- `electron/sandbox-registry.ts`
- `electron/sandbox-settings.ts`
- `electron/sandbox-store.ts`
- `electron/sandbox-connect-errors.ts`
- `electron/sandbox-types.ts`

### Electron tests
- `electron/__tests__/sandbox-agent-client.test.ts`
- `electron/__tests__/sandbox-agent-creds.test.ts`
- `electron/__tests__/sandbox-manager.test.ts`
- `electron/__tests__/sandbox-registry.test.ts`
- `electron/__tests__/sandbox-connect-errors.test.ts`
- `electron/__tests__/sandbox-settings.test.ts`

### CLI + docs
- `scripts/remote-vm.mjs`
- `docs/project-sandbox-aws-flow.md`
- `docs/digitalocean-sandboxes-plan.md`
- `docs/remote-vm-cli.md`
- `daytona-hosted-removal-plan.md` (root-level; historical hosted-SaaS removal note — verify no cross-references first)

## Files to modify

### Server / API
- `src/server/api-router.ts` — drop the `sandboxesController` import, the `SANDBOX_PATH` and `SANDBOX_API_KEY_PATH` regexes, and every sandbox route handler (`GET /api/sandboxes`, `POST /api/sandboxes/connect`, `PUT /api/sandboxes/active`, `PUT /api/sandboxes/enabled`, `GET /api/sandboxes/:id/api-key`, `PATCH /api/sandboxes/:id`, `DELETE /api/sandboxes/:id`).
- `src/server/services/projects.ts`, `tasks.ts`, `user-terminals.ts`, `home-terminals.ts`, `project-memory.ts` — remove `scopeId` / `sandboxId` from create/update signatures, DB writes, and query filters. Fall back to the single implicit local scope.
- `src/server/services/proactive-recall.ts`, `code-graph-*.ts`, `graph-watcher.ts`, `graph-auto-index.ts` — audit for `scopeId` filtering and strip.

### Electron main + preload
- `electron/main.ts` — remove `registerSandboxManager` / `disposeSandboxManager` wiring, the `remoteVm*` helpers (`remoteVmSpawnEnv`, `remoteVmScriptCandidates`, `remoteVmScriptPath`, `remoteVmSpawnCwd`, `remoteVmDeployInputWithSandboxId`), the `RemoteVmDeployJob` type / `remoteVmDeployJobs` Map, and every `remoteVm:*` and `sandbox:*` IPC handler.
- `electron/preload.ts` — drop the `electron.sandbox.*`, `electron.remoteVm.*`, `electron.remotePty.*`, `electron.remoteFs.*`, `electron.remoteGit.*` namespaces and every associated type mirror.
- `electron/ipc-channels.ts` — delete every channel enumerated in the IPC section below.
- `electron/pty-core-link-client.ts`, `pty-core-link-server.ts`, `pty-output-batch.ts`, `pty-hook-env.ts`, `preview-server.ts`, `core-registry-store.ts`, `app-settings-store.ts`, `api-token-store.ts` — audit for `sandboxId` / `scopeId` and strip. Anything that only exists to distinguish "sandbox PTY" from "local PTY" collapses to the local path.

### Shared contracts
- `src/shared/electron-contract.ts` — remove `SandboxRuntimeMode`, `SandboxGitAuthMode`, `SandboxImageStrategy`, `SandboxState`, `SandboxSettingsBridge`, `RemotePtySpawnOptions`, and any `remoteVm*` / `remoteFs*` / `remoteGit*` channel payload types.
- `src/shared/project-memory.ts`, `src/shared/git-status.ts`, `src/shared/mission-control-hook-env.ts` — drop any `scopeId` fields from the interchange types.

### Client API + queries
- `src/lib/api.ts` — remove the `SandboxPublicView` import and the `listSandboxes`, `connectSandbox`, `updateSandbox`, `revealSandboxApiKey`, `deleteSandbox`, `setActiveScope`, `setSandboxSystemEnabled` client methods. Strip `scopeId` from `scopedWorktreeQuery` (or remove the helper if it becomes trivial).
- `src/queries/index.ts` — drop the `filterProjectsByScope` / `LOCAL_SCOPE_ID` import, `queryKeys.sandboxes`, `sandboxId: null` defaults, `sandboxesQueryOptions`, and `useScopedProjects` (or thin-wrap to `useProjects`).
- `src/lib/core-pty-bridge.ts`, `terminal-store.tsx`, `project-git.ts`, `use-session-finish-notifications.tsx`, `design-meta.ts`, `archive-session.ts`, `use-diagram-events.tsx` — remove sandbox-awareness (grep shows sandbox references in each).

### Routes
- `src/routes/__root.tsx` — remove `useScopedProjects` / `useSandboxes` imports, the `SandboxResumingOverlay` and `ScopeDropdown` imports, the `activeSandbox` / `activeResuming` derivations, the `<ScopeDropdown />` mount, and the `{activeResuming && …}` overlay render.
- `src/routes/projects.$id.tsx` — remove `isDockerSandboxRuntime`, `useSandboxes`, `SandboxProvisioningState`, `isSandboxProvisioning`, `useRemoteVmDeployForSandbox`, `activateSandboxScope` imports; delete all sandbox-state derivations (`activeRuntimeSandbox`, `sandboxUsableForProject`, `deploySandboxId`, `sandboxProvisioning`, `wasSandboxProvisioningRef`), the `activateSandboxScope()` call in the project-switch handler, the `isDockerSandboxRuntime()` branch, and the `<SandboxProvisioningState />` mount.
- `src/router.tsx` — audit for any sandbox-flagged route or preload.

## Schema changes

Confirmed via `src/db/schema.ts`:

- `sandboxes` table (lines ~52–75): `id`, `name`, `kind`, `color`, `imageTag`, `dockerfilePath`, `buildArgs`, `gitAuthMode`, `copyAgentCreds`, `declaredPorts`, `env`, `hostAgentPort`, `portMap`, `pairingToken`, `remoteConfig`, `createdAt`, `updatedAt` → **DROP TABLE**.
- `sandboxesRelations` (~line 525) → remove.
- `projects.sandbox_id` (FK to `sandboxes.id`, ~line 91) and index `projects_sandbox_idx` (~line 121) → **DROP INDEX + DROP COLUMN**.
- `tasks.scope_id` (~line 152) and index `tasks_scope_idx` (~line 177) → **DROP INDEX + DROP COLUMN**.
- `user_terminals.scope_id` (~line 230) and index `user_terminals_scope_idx` (~line 246) → **DROP INDEX + DROP COLUMN**.
- `home_terminals.scope_id` (~line 263) and index `home_terminals_scope_idx` (~line 271) → **DROP INDEX + DROP COLUMN**.
- `project_memory.scope_id` (~line 363) and index `project_memory_project_scope_idx` (~line 385) → **DROP INDEX + DROP COLUMN**.
- `app_settings`: sandbox-related keys (sandbox system enabled toggle, active scope pointer) → clear via migration (or leave as orphan JSON keys the new bootstrap ignores; the app-settings reader should silently drop unknown keys — verify).

`src/db/schema-bootstrap.ts` must be updated so fresh installs match the post-migration shape.

## Migration

`src/db/migrations/0026_remove_sandboxes.sql` (next number after spec 07's 0025):

```sql
-- Actana Control: remove managed sandbox / remote VM subsystem.
-- Every sandbox-scoped project cascades away with its sandbox.

DROP INDEX IF EXISTS projects_sandbox_idx;
DROP INDEX IF EXISTS tasks_scope_idx;
DROP INDEX IF EXISTS user_terminals_scope_idx;
DROP INDEX IF EXISTS home_terminals_scope_idx;
DROP INDEX IF EXISTS project_memory_project_scope_idx;

ALTER TABLE projects DROP COLUMN sandbox_id;
ALTER TABLE tasks DROP COLUMN scope_id;
ALTER TABLE user_terminals DROP COLUMN scope_id;
ALTER TABLE home_terminals DROP COLUMN scope_id;
ALTER TABLE project_memory DROP COLUMN scope_id;

DROP TABLE IF EXISTS sandboxes;
```

If Drizzle rejects `DROP COLUMN` under SQLite mode, fall back to the standard SQLite pattern (create shadow table without the column, copy, drop, rename) — schema.ts is the source of truth, so `pnpm db:generate` should produce the correct dialect-appropriate migration.

## IPC channels

All of these come out of `electron/ipc-channels.ts` and their handlers in `electron/main.ts` / `electron/sandbox-*.ts`. Total: **48 channels**.

**Sandbox management (19)**: `sandbox:get-state`, `sandbox:get-settings`, `sandbox:update-settings`, `sandbox:up`, `sandbox:rebuild`, `sandbox:down`, `sandbox:destroy`, `sandbox:set-active`, `sandbox:connect`, `sandbox:disconnect`, `sandbox:status`, `sandbox:validate-dockerfile`, `sandbox:diagnostics`, `sandbox:state-change`, `sandbox:log`, `sandbox:setup-git-auth`, `sandbox:upgrade-agent`, `sandbox:reveal-api-key`, `sandbox:detect-remote`.

**Remote VM deploy (11)**: `remoteVm:deploy`, `remoteVm:startDeploy`, `remoteVm:listDeployJobs`, `remoteVm:getDeployLogs`, `remoteVm:cancelDeploy`, `remoteVm:pause`, `remoteVm:resume`, `remoteVm:reconcile`, `remoteVm:destroy`, `remoteVm:deployUpdate`, `remoteVm:deployLog`.

**Remote PTY (9)**: `remotePty:spawn`, `remotePty:write`, `remotePty:resize`, `remotePty:kill`, `remotePty:replay`, `remotePty:data`, `remotePty:exit`, `remotePty:spawned`, `remotePty:spawnError`. These mirror local PTY only for sandbox-scoped tasks — with sandboxes gone, only `pty:*` remains.

**Remote FS (6)**: `remoteFs:list`, `remoteFs:read`, `remoteFs:write`, `remoteFs:watch`, `remoteFs:unwatch`, `remoteFs:change`. Spec 06 preserved these for sandbox mode; that reason evaporates.

**Remote Git (3)**: `remoteGit:status`, `remoteGit:diff`, `remoteGit:clone`. Same rationale as remoteFs.

## HTTP routes

Remove from `src/server/api-router.ts`:
- `GET /api/sandboxes`
- `POST /api/sandboxes/connect`
- `PUT /api/sandboxes/active`
- `PUT /api/sandboxes/enabled`
- `GET /api/sandboxes/:id/api-key`
- `PATCH /api/sandboxes/:id`
- `DELETE /api/sandboxes/:id`

`POST/PATCH /api/projects` and `/api/tasks` payloads: drop the `sandboxId` / `scopeId` fields from their Zod schemas.

## Keybindings

No sandbox-specific keybindings exist. Nothing to remove from `src/lib/keybindings/`.

## Dependencies

`package.json`:
- Drop `"@agentsystemlabs/mission-control-agent": "0.3.1"` from `dependencies`. This is the only sandbox-only npm dep — no AWS SDK is bundled (the provisioner shells out to the `aws` CLI installed on the operator's machine, which now also becomes irrelevant).

`package.json` scripts: drop the `"remote-vm"` script if defined.

## Rebrand-spec interaction

Spec 09 (rebrand-and-auto-update) currently blocks on publishing `@qcentic/actana-control-agent` because the sandbox subsystem installs it on VMs. **That prerequisite dissolves** with this spec: no VM install path exists anymore, so no fork of the agent package needs to be published. Update spec 09 to strike the agent-bridge rename from its checklist and note the dependency-on-spec-10 in its "Prerequisites" section.

Env-var rename `MC_*` → `AC_*` (spec 09) still applies to the Harness ↔ Panel core-link contract — that is unaffected by sandbox removal.

## Divergence bookkeeping

Update `docs/upstream/DIVERGENCE.md`: promote the sandbox subsystem to a NON-EXISTENT axis on the fork side. Any upstream commit under `src/server/services/sandboxes.ts`, `src/shared/sandbox*`, `electron/sandbox-*.ts`, `scripts/remote-vm.mjs`, or `@agentsystemlabs/mission-control-agent` version bumps is permanently ignored on the fork.

Update `docs/upstream/PROVENANCE.md`: sandbox files move from UNTOUCHED (~96%) to REMOVED.

## Tests to remove
- `src/server/__tests__/sandboxes-api.test.ts`
- `src/shared/__tests__/sandbox.test.ts`
- `src/shared/__tests__/sandbox-agent-upgrade.test.ts`
- `src/shared/__tests__/sandbox-workspace.test.ts`
- `src/lib/__tests__/activate-sandbox-scope.test.ts`
- `src/lib/__tests__/optimistic-sandbox.test.ts`
- `src/lib/__tests__/project-sandbox-create.test.ts`
- `src/lib/__tests__/project-scoped-sandboxes.test.ts`
- `src/lib/__tests__/remote-vm-deploy.test.ts`
- `src/lib/__tests__/sandbox-busy.test.ts`
- `src/lib/__tests__/sandbox-runtime.test.ts`
- `src/lib/remote-vm-script.test.ts`
- `src/db/__tests__/bootstrap-existing-sandbox-id.test.ts`
- `src/db/__tests__/migrate-multi-sandbox.test.ts`
- `electron/__tests__/sandbox-agent-client.test.ts`
- `electron/__tests__/sandbox-agent-creds.test.ts`
- `electron/__tests__/sandbox-manager.test.ts`
- `electron/__tests__/sandbox-registry.test.ts`
- `electron/__tests__/sandbox-connect-errors.test.ts`
- `electron/__tests__/sandbox-settings.test.ts`

## Tests to trim (remove sandbox fixtures, keep the file)
- `src/server/services/__tests__/projects.test.ts` — drop `sandboxId` from create/update fixtures.
- `src/server/services/__tests__/tasks.test.ts` — drop `scopeId` fixtures.
- `src/server/services/__tests__/user-terminals.test.ts` — drop `scopeId` fixtures.
- `src/server/services/__tests__/home-terminals.test.ts` — drop `scopeId` fixtures.
- `src/server/services/__tests__/proactive-recall.test.ts` — drop scope filtering assertions.
- `src/lib/__tests__/agent-command.test.ts` — trim sandbox-scoped mocks.
- `src/lib/__tests__/shell-query-cache.test.ts` — remove scope-scoped query mocks.
- `src/lib/__tests__/sort-projects.test.ts` — drop sandbox fixtures.
- `src/lib/__tests__/worktree-live-activity.test.ts` — drop scope-scoped activity expectations.

## Verification checklist
- [x] `rg -i "sandbox" src electron scripts` returns zero feature hits. Documented exceptions (see the ticket file): the one-release `dropLegacySandboxSchema` boot cleanup in `schema-bootstrap.ts`, Electron's Chromium `sandbox: false` webPreference (+ comments about it), and generic-English "sandboxed iframe" comments in the origin gate.
- [ ] `rg "remote-vm|remoteVm|RemoteVm" src electron scripts` returns zero hits.
- [ ] `rg "remotePty|remoteFs|remoteGit" src electron scripts` returns zero hits.
- [ ] `rg "@agentsystemlabs/mission-control-agent" .` returns zero hits (outside `docs/upstream/` historical notes).
- [x] `rg "scopeId|LOCAL_SCOPE_ID|filterProjectsByScope" src electron` returns zero hits (immutable historical migration files under `src/db/migrations/` excepted).
- [ ] `pnpm tsc --noEmit` passes.
- [ ] `pnpm test` passes; deleted test files gone, trimmed tests green.
- [ ] Fresh DB from `schema-bootstrap.ts` has no `sandboxes` table and no `sandbox_id` / `scope_id` columns on `projects`, `tasks`, `user_terminals`, `home_terminals`, `project_memory`.
- [ ] Existing DB upgrades cleanly via `0026_remove_sandboxes.sql`.
- [ ] `electron/ipc-channels.ts` no longer exports any `sandbox:*`, `remoteVm:*`, `remotePty:*`, `remoteFs:*`, `remoteGit:*` channel.
- [ ] `electron/preload.ts` no longer exports `electron.sandbox`, `electron.remoteVm`, `electron.remotePty`, `electron.remoteFs`, `electron.remoteGit`.
- [ ] Header renders no `ScopeDropdown`; the project list is a flat single-scope view.
- [ ] Project detail page has no `SandboxProvisioningState`, no scope switcher, no "connect to agent URL" affordance.
- [ ] Settings page has no sandbox / Docker / remote-VM section.
- [ ] `package.json` no longer lists `@agentsystemlabs/mission-control-agent`; `pnpm remote-vm` CLI is gone.
- [ ] `docs/upstream/DIVERGENCE.md` and `PROVENANCE.md` reflect the removal.
- [ ] Spec 09 (rebrand) is updated to strike `@qcentic/actana-control-agent` from its blocker list.

## Follow-ups / out of scope
- **No VM provisioning replacement in the Panel.** If VM provisioning ever comes back, it belongs in the Harness installer story (bootstrap-a-Harness-on-a-fresh-VM), not resurrected as a Panel-side subsystem. ADR 0009 closes the door on the sandbox model, not on remote work.
- **Spec 07 follow-up dissolves.** "Custom scripts / launch commands belong in the sandbox layer" is moot — there is no sandbox layer. Custom scripts remain permanently out of scope.
- **`user_terminals.start_command`**: already dropped by spec 07. No further work.
- **Docker Desktop dependency**: if any developer-onboarding docs mention Docker as a prerequisite for sandbox mode, remove those mentions in the same PR.
