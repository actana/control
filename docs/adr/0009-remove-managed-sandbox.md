# Remove the managed sandbox / remote VM subsystem

> _Written before the #33 rename. Read "Harness" as what is now a **Core**, and "agent"/"TaskAgent" as what is now a **Harness**; the wording is left as it was decided._

Actana Control drops the upstream "sandbox" feature entirely: the `sandboxes` table, the scope dropdown, the AWS EC2 provisioner (`scripts/remote-vm.mjs` and the `remoteVm:*` IPC surface), the Electron-side `SandboxManager` / `SandboxAgentClient`, the `@agentsystemlabs/mission-control-agent` runtime dependency, and every `scopeId` column layered on top of `tasks`, `user_terminals`, `home_terminals`, and `project_memory`. Managed remote work is replaced by the detached-core Harness that already ships in the fork: the operator installs a Harness on any machine they own, and the Panel drives it over the core-link protocol (ADR 0001, 0002).

The upstream sandbox is a **thin remote-hands RPC** — a Node.js daemon (`@agentsystemlabs/mission-control-agent`, systemd-supervised) that exposes `fs.*`, `git.*`, `pty.spawn`, `creds.setup` over WSS+bearer, letting the desktop drive files and terminals on a provisioned VM. It owns no session state; if the desktop disconnects, the session dies. It is provider-specific in practice (AWS EC2, with a DigitalOcean plan that was never implemented) and lives entirely inside the Panel's own binary.

The detached-core Harness is the strict superset. It owns the Session (PTY, event log, replay via `lastEventId` cursor), survives Panel disconnects, allows a second client to attach, and speaks a versioned wire contract the fork already controls end-to-end. Keeping both means two remote stories in one product, two distinct provisioning UX flows, two dependency chains, and a naming clash (rebrand ships a fresh `@qcentic/actana-control-agent` package while the sandbox subsystem still expects the old `@agentsystemlabs/*` binary on the VM).

## Considered Options

- **Keep the sandbox subsystem alongside the Harness (rejected).** Two overlapping remote paths confuse operators ("is my VM a sandbox or a Core?"). The sandbox layer would need to be rebranded, its VM-side npm package republished under `@qcentic/*`, and its AWS/DigitalOcean stories maintained — all for a strictly weaker execution model than the Harness offers. Fails the operator-focus and maintenance-cost tests in ADR 0007.
- **Keep the sandbox but drop the AWS provisioner, leave manual "connect to agent URL" (rejected).** Preserves ~70 files and 48 IPC channels for a feature that duplicates Harness connect. The provisioner is the only unique capability sandboxes offer over Harnesses (one-click VM creation), and it is AWS-only. Without it, sandboxes are Harnesses with a worse protocol.
- **Delete the entire sandbox subsystem in one hard cutover (chosen).** Consistent with ADR 0007's forward-only stance and the nine prior removal specs. The Harness covers every real-world use case; the operator who wants a remote VM stands one up themselves (any provider) and installs a Harness on it. Provisioning is out of Actana Control's scope.

## Consequences

- Removal spec 10 lands as a single PR alongside the other scope-narrowing specs. Total removal count rises from nine to ten.
- The `sandboxes` table and every `scopeId` / `sandboxId` column dropped in one forward-only migration. No data-migration path — existing sandbox-scoped projects are gone with their sandbox (fresh-fork, no users to preserve).
- `@agentsystemlabs/mission-control-agent` npm dependency is removed. Rebrand spec 09's "publish `@qcentic/actana-control-agent` before rebrand can land" prerequisite is **dissolved** — the package no longer needs to exist because nothing in Actana Control installs an agent on a VM anymore. Spec 09 is updated to strike the agent-bridge rename from its checklist.
- Electron IPC surface shrinks by ~48 channels (`sandbox:*`, `remoteVm:*`, `remotePty:*`, `remoteFs:*`, `remoteGit:*`). Preload contract, `electron-contract.ts` shared types, and `ipc-channels.ts` all shrink correspondingly.
- `scripts/remote-vm.mjs` and the `pnpm remote-vm` CLI are removed. AWS CLI is no longer an implicit prerequisite for any Actana Control workflow.
- The `ScopeDropdown` in the header goes away; the project list becomes a flat single-scope view. All "active scope" plumbing (`queryKeys.sandboxes`, `useScopedProjects`, `activateSandboxScope`, `filterProjectsByScope`, `LOCAL_SCOPE_ID`) is removed.
- Docs `project-sandbox-aws-flow.md`, `digitalocean-sandboxes-plan.md`, `remote-vm-cli.md`, and `daytona-hosted-removal-plan.md` are deleted. `DIVERGENCE.md` gains a NON-EXISTENT entry: the entire sandbox / remote-VM axis is gone on the fork side, so upstream sandbox changes are permanently ignored.
- The spec-07 (convenience) follow-up "custom scripts / launch commands belong in the sandbox layer, not the harness remote" becomes moot — there is no sandbox layer. Custom scripts remain out of scope indefinitely.
- If Actana Control ever wants VM provisioning back, it belongs in the Harness installer (bootstrap-a-Harness-on-a-fresh-VM), not resurrected as a Panel-side subsystem. This ADR closes the door on the sandbox model, not on remote work.
- Any future feature that asks for a Panel-side remote execution surface parallel to the Harness must first justify itself against this ADR.
