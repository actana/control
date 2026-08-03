# 09 — Session icon: Harness-owned + Core-aware `SessionGrid` renders it

**What to build:** A Task's icon (the customisable per-Session glyph rendered in `SessionGrid` cells and the `TerminalPane` header) becomes a Harness-owned field. The Panel does not store icons; every icon lookup and every icon change routes through the core-link. Loopback and remote Cores accept the same mutation shape; the same `SessionIcon` component renders for every Core because the component is the same (issue 08).

**Blocked by:** 08 — needs unified `SessionGrid` and `TerminalPane` mounted for every Core.

**Status:** ready-for-agent

- [ ] Task table on the Harness gains an `icon` column (nullable string; the same shape the local Task row already uses today).
- [ ] `tasksList` / task snapshots in the core-link protocol include the `icon` field.
- [ ] New core-link mutation frame `taskSetIcon` on `HarnessMutationPort` (mirrors issue 04's mutation pattern); Loopback and remote Cores handle it identically via `src/shared/harness-mutations.ts`.
- [ ] Harness appends `task:iconChanged` to its event log so a reconnecting Panel replays the change through the existing `subscribe` / `event` / `eventsReplayed` flow (ADR-0004 consequence).
- [ ] `SessionIcon` in `SessionGrid` reads the icon from the Task snapshot the Core emits, not from any Panel-side store.
- [ ] The icon picker in `TerminalPane` / `SessionGrid` sends its mutation through the `coreId`-parameterised API so it works for any Core.
- [ ] Loopback flow: the icon picker no longer writes to the local HTTP server; it writes through the same in-process core-link mutation used for remote Cores — no branching on `coreId === LOOPBACK_CORE_ID` inside the icon component.
- [ ] Two Panels connected to the same remote Core see the same icon after one changes it (verified via the replay of `task:iconChanged`).

**References:** `docs/adr/0005-singular-ui-across-cores.md`; `docs/adr/0004-harness-owns-write-path.md`; `CONTEXT.md` (Session icon, Task metadata is Harness-side rule).
