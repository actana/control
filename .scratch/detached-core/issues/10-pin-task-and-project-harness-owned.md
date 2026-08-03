# 10 — Pinning: Task pins + Project pins as Harness state

**What to build:** Pinning a Task or a Project becomes a Harness-owned fact — a boolean column on the Task / Project row, mutated through the core-link. Every Panel connected to a Core sees the same pin state; the pin toggle in `ProjectBar` and the pin control in the unified `SessionGrid` / `TerminalPane` header wire through the same `coreId`-parameterised mutation surface for every Core (Loopback included).

**Blocked by:** 08 — needs unified `ProjectBar` and `SessionGrid` mounted for every Core.

**Status:** ready-for-agent

- [ ] Task and Project tables on the Harness gain a `pinned` boolean column (nullable-false; the shape the local rows already carry today).
- [ ] `tasksList` / `projectsList` / snapshots in the core-link protocol include the `pinned` field for both entity kinds.
- [ ] New core-link mutation frames `taskPin` and `projectPin` on `HarnessMutationPort`; Loopback and remote Cores handle them identically via `src/shared/harness-mutations.ts`.
- [ ] Harness appends `task:pinnedChanged` and `project:pinnedChanged` to its event log for replay on reconnect.
- [ ] The pin control in `TerminalPane` header and `SessionGrid` cells sends its mutation through the `coreId`-parameterised API; no `coreId === LOOPBACK_CORE_ID` branch inside the pin component.
- [ ] `ProjectBar` pin/reorder interactions write through the same mutation surface for any Core; the "pinned" filter tab in `SessionGrid` scope toggle works identically for Loopback and remote Cores.
- [ ] Loopback flow: pin writes stop going through the local HTTP server for Tasks/Projects — they go through the in-process core-link mutation.
- [ ] Two Panels connected to the same remote Core see the same pin state after one toggles it.

**References:** `docs/adr/0005-singular-ui-across-cores.md`; `docs/adr/0004-harness-owns-write-path.md`; `CONTEXT.md` (Pinned Task / Pinned Project, Task metadata is Harness-side rule).
