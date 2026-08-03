# 06 — Panel UI: Core selector in Add Project + per-Core / Fleet creation affordances + TerminalPane per-Core spawn routing

**What to build:** The final UX layer. The global Add Project dialog (`ProjectDialog`) gains a Core selector, defaulting to the currently-selected Core (loopback when no fleet exists). Per-Core navigation and Fleet view (issue 07) gain "Add Project" and "New Task" affordances that route mutations over the selected Core's core-link instead of the loopback API. `TerminalPane` spawns route to the Core that owns the task rather than always using loopback `electron.pty`. Creating a project on an unreachable Core fails honestly with the existing "unreachable" treatment; results appear via live events streamed back from that Core (no Panel-side persistence).

**Blocked by:** 05 — needs the widened IPC/dialer surface to call from the UI.

**Status:** ready-for-agent

- [ ] `ProjectDialog` gains a Core selector; default is the currently-selected Core (loopback when no fleet exists).
- [ ] Per-Core navigation (issue 07) surfaces "Add Project" / "New Task" affordances that call `projectsMutate` / `tasksMutate` on the selected Core.
- [ ] Fleet view gains equivalent creation affordances scoped to the highlighted Core.
- [ ] The global Add Project hotkey routes creation to the selected Core, not silently to loopback.
- [ ] `TerminalPane` spawn routing chooses `electron.pty` (loopback) vs remote-Core `spawn` frame based on which Core owns the task.
- [ ] Creating a project on an unreachable Core surfaces the existing "unreachable" treatment (no silent no-op, no local fallback).
- [ ] Created projects appear in that Core's `projectsList` (and *not* in the local Core's) via live events, without a full refresh.
- [ ] No new task-shaped state persists on the Panel — the UI is a view of Core-owned state.
