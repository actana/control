# 01 — Extract the stateful server into a separate process over a loopback core-link

**What to build:** The app works exactly as before, but the stateful server (`src/server/`) and the PTY manager (`pty-manager.ts`) run as a separate process the Electron app spawns and connects to over a loopback WebSocket (`ws://127.0.0.1`). The renderer/preload stop using in-process `electron.pty` and dial the loopback core-link instead. This is the expand step — it establishes the seam between Panel and Harness without changing any user-facing behaviour. No auth yet (loopback is trusted); the goal is a behaviour-preserving extraction, not new UX.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The bundled server and PTY manager run as a separate process (the Harness), spawned by the Electron app on startup.
- [ ] The renderer/preload reach PTY, task, and session operations over `ws://127.0.0.1` instead of in-process `ipcMain`/`ipcRenderer` calls.
- [ ] All existing terminal, task, and session behaviour is unchanged (full regression).
- [ ] A single WebSocket carries multiplexed frames keyed by `ptyId` (the seed of the core-link frame schema).
- [ ] The existing `ptyReplay` channel still works over the loopback link after a renderer reload.
