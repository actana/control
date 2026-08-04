# Detach the harness from the panel over a stateful core-link

> _Written before the #33 rename. Read "Harness" as what is now a **Core**, and "agent"/"TaskAgent" as what is now a **Harness**; the wording is left as it was decided._

The agent-running layer (PTY manager, bundled server, SQLite, hooks API, project registry) is extracted from the Electron main process and packaged as a standalone **Harness** bundle installable on a remote VM. The local app becomes a **Panel**: a thin client that owns only a Core registry (endpoints, tokens, aliases) and a per-Core `lastEventId` cursor, and drives one-or-more Harnesses over a persistent bidirectional WebSocket **core-link**.

Each Harness is the single source of truth for all work on its machine — tasks, sessions, terminal logs, project folders, hook events — stored in its own SQLite. The Panel holds no task-shaped state; its Fleet view is a live fan-out query across connected Cores, never a cache. A Core's offline state is shown as "unreachable + last-seen," with no cached rows.

This was chosen over a stateless-harness alternative (state stays on the Mac, VM only relays PTY) because the whole point of placing harnesses on VMs is unattended operation: agents must keep making progress and emitting events while the Panel is asleep, and the operator must come back to a complete timeline. That requires the state to live where the work happens.

## Considered Options

- **Stateless Harness (rejected).** VM relays PTY only; SQLite/hooks/project registry stay on the Mac. Simpler (one DB, easy cross-VM views), but the laptop becomes a single point of failure for state and the design loses the unattended-operation property that justifies VMs.
- **Panel-cached read-model (rejected).** Panel mirrors each Core's tasks into local SQLite for an instant/offline dashboard. Reintroduces the cache-invalidation/sync surface the detached design exists to escape; violates "nothing task-shaped lives on the Panel."

## Consequences

- The bundled server (`src/server/`) must be extracted from Electron and made to run headless as the Harness process; `pty-manager.ts` moves into it.
- The existing `ws` frame protocol in `sandbox-agent-client.ts` is generalized from "project-sandbox runtime" to "arbitrary registered Core," carrying task/session/hook ops in addition to PTY.
- A new first-class spawn mode `shellSession: true` is added to the frame schema for VM Shell Sessions — gated by core-link auth, not project-root validation.
- The Panel's storage shrinks to a Core registry + `lastEventId` per Core; all existing task/session/project persistence moves to the Harness.
- Cross-Core views are eventual (parallel fan-out queries), never a single SQL query.
