# 08 — Unified shell for every Core (mount `SessionGrid` + `ProjectBar` per Core, delete `FleetView` drill)

**What to build:** The Panel's per-Core work surface becomes the *same* shell used for Loopback today — `ProjectBar` + `SessionGrid` + `TerminalPane` — with a `coreId` prop threaded through. Clicking a Core card in Fleet view navigates *out* of Fleet view into that standard shell route, scoped to the picked Core. `FleetView`'s current embedded drill (`CoreProjects`, `CoreProjectTasks`, `TaskRowMini`, `ProjectCardMini`, `NewTaskDialog`) is deleted; `FleetView` retains only the aggregate dashboard (`FleetDashboard`, `FleetTaskRow`, `CorePicker`, unreachable-Core surface). `NewAgentDialog` gains a `coreId` prop and replaces `NewTaskDialog` as the single "start a Session" modal for every Core. UI strings for a Task are labelled "Session" everywhere the local shell already labels them that way — the label is the same because the component is the same.

This is the foundational slice for the Singular-UI invariant (ADR-0005). Icons, pins, and availability checks land in follow-up issues (09, 10, 11) — this issue is only about getting the *right* components mounted for a remote Core so those follow-ups have a home.

**Blocked by:** 07 — needs `coreId`-parameterised `TerminalPane` and the fleet IPC surface.

**Status:** ready-for-agent

- [ ] `SessionGrid` accepts a `coreId` prop and fans every internal API call through the transport layer selected by that `coreId` (Loopback → in-process; remote → `electron.fleet.*`).
- [ ] `ProjectBar` accepts a `coreId` prop; its project list, ordering, and drag interactions all read/write against the picked Core.
- [ ] `NewAgentDialog` accepts a `coreId` prop; its "create Task" call routes to the picked Core (Loopback keeps its HTTP path; remote uses the core-link mutation surface established in issue 04).
- [ ] `FleetView.tsx` is reduced: `CoreProjects`, `CoreProjectTasks`, `TaskRowMini`, `ProjectCardMini`, `NewTaskDialog` deleted. `FleetDashboard`, `FleetTaskRow`, `CorePicker`, unreachable-Core surface retained.
- [ ] Clicking a Core in `FleetDashboard` / `CorePicker` navigates to the standard per-Core shell route (not to an embedded FleetView drill).
- [ ] The shell has no in-shell Core switcher; switching Cores requires returning to Fleet view (per Q5 in the parity grilling).
- [ ] Loopback and every remote Core render through the exact same component tree — no `FleetSessionGrid`, no `FleetProjectBar`, no branching on `coreId === LOOPBACK_CORE_ID` inside a UI component. Transport branching lives inside the `api.*` layer and inside `TerminalPane`.
- [ ] The `NewAgentDialog` title continues to read "Start a new session"; remote Cores show the same modal, not a different "New task" one.
- [ ] Cross-Core aggregate rows in Fleet view stay minimal (no session icons, no pin toggles) per Q7.

**References:** `docs/adr/0005-singular-ui-across-cores.md`; `CONTEXT.md` (Loopback Core, Singular UI, Per-Core navigation, Fleet view).
