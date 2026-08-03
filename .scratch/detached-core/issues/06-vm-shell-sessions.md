# 06 — VM Shell Sessions

**What to build:** A first-class VM Shell Session — a free-form interactive shell on the Harness's machine, distinct from agent workspaces. A new `shellSession: true` spawn mode is added to the core-link frame schema; the Harness skips the project-root validation it applies to agent spawns (a VM shell has no project folder). The Panel renders these with a distinct "VM shell" surface (clearly separated from agent terminals), and opening one requires an explicit gesture (never auto-spawned). It is the SSH-equivalent escape hatch: a live bash on the remote Core, streamed over the same core-link, replayable on reconnect. VM Shell Sessions are privileged — gated by the same core-link mTLS auth, so anyone with the Core's credentials can run arbitrary shell on that machine.

**Blocked by:** 04 — needs the authenticated remote core-link to be meaningful (a VM shell on a loopback-only Core adds little).

**Status:** ready-for-agent

- [ ] The core-link frame schema supports `shellSession: true` spawns with no `agent` field and no project-root requirement.
- [ ] The Harness spawns a real shell PTY for these, streamed back over the same multiplexed core-link.
- [ ] The Panel renders VM Shell Sessions with a distinct surface (badge/label), separate from agent workspaces.
- [ ] Opening a VM Shell requires an explicit open gesture; it is never auto-spawned on Connect.
- [ ] A VM Shell Session survives Panel reconnect (PTY replay from the event log restores its output).
