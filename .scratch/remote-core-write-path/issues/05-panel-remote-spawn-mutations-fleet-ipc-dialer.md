# 05 — Panel: expose remote spawn + mutations through the fleet IPC / dialer surface

**What to build:** The renderer today can only *read* from a remote Core — `RemoteCoreDialer`'s client surface (`electron/remote-core-dialer.ts:36-44`) exposes `tasksList` / `projectsList` / auth / events, nothing else. Widen it to expose `projectsMutate`, `tasksMutate`, `sessionsList`, and `spawn` frames against the currently-selected Core, and thread those through the fleet section of `src/shared/electron-contract.ts` and the preload so `TerminalPane` and the Panel dialogs can call them just like they call the loopback `electron.pty` today. Ordering + backpressure semantics for remote spawn frames should match the loopback path (spawn → live events routed by `ptyId`, resumable from `lastEventId` on reconnect per issue 02). Ownership stays remote — the Panel never persists task-shaped state (CONTEXT.md rule).

**Blocked by:** 04 — the frames must exist before the dialer can call them.

**Status:** ready-for-agent

- [ ] `electron/remote-core-dialer.ts` client surface adds `projectsMutate`, `tasksMutate`, `sessionsList`, and `spawn` methods against the selected Core.
- [ ] `src/shared/electron-contract.ts` fleet section exposes those calls to the renderer through the preload with typed request/response shapes.
- [ ] `TerminalPane`'s spawn path can target a remote Core by Core id (not only loopback `electron.pty` or the legacy Docker sandbox), and receives streamed pty output over the core-link.
- [ ] Live events for a remote spawn arrive via the existing event replay path; a Panel reload/reconnect replays from `lastEventId` correctly (regression check on issue 02's guarantee).
- [ ] Errors from an unreachable Core surface with the existing "unreachable" treatment (no silent no-op).
- [ ] No task/session state is persisted on the Panel side — all reads still come from the Core's `projectsList`/`tasksList`/`sessionsList`.
