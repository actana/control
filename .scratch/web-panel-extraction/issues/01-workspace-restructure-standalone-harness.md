# 01 — Workspace restructure: standalone Harness (prefactor)

**What to build:** Restructure the repo into pnpm workspace packages — harness (standalone daemon), panel (service + UI), shared (core-link frames, protocol types, mutation/query contracts, registration-blob codec) — so that the Harness builds and boots as a plain Node process with no Electron anywhere in its path. Native modules (node-pty, better-sqlite3) move to the normal Node ABI; the Electron-ABI tooling and the dead PTY IPC registration are deleted. This is the prefactor every other ticket in both epics stands on.

**Blocked by:** None — can start immediately.

**Status:** done — merged to main (0bac7e3, 2026-07-31)

- [x] `pnpm install && pnpm build` produces a Harness that boots via plain `node` (no `ELECTRON_RUN_AS_NODE`), listens, and accepts a core-link dial
- [x] harness/panel/shared package boundaries exist; harness and shared import nothing from Electron or from panel
- [x] node-pty and better-sqlite3 load via the standard Node ABI with no Electron rebuild scripts remaining
- [x] Existing Harness unit tests (stores, cert material, install, autostart) relocated and green
- [x] The Electron app still builds and runs against the relocated packages (teardown comes later, in ticket 08)
- [x] Dead loopback PTY IPC registration and its channels are gone
