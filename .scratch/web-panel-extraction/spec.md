# Spec — Web Panel extraction: Panel becomes a self-hosted web service, Electron removed

**Status:** ready-for-agent
**Date:** 2026-07-31
**Origin:** Grilling session 2026-07-31 — decisions recorded in ADR 0010 (self-hosted web service), ADR 0011 (Operator identity and auth), ADR 0012 (panel link), and the CONTEXT.md glossary rewrite of the same date.

---

## Problem Statement

The Panel is an Electron desktop app, and everything painful about the product's distribution flows from that one fact. Shipping it means four per-OS builds, macOS notarization ($99/yr, launch-blocking), Windows code signing, Electron-ABI rebuilds of native modules, and an auto-updater — all to deliver what is architecturally already a local web server with a browser window bolted on. The operator can only look at their fleet from the one machine the desktop app is installed on; there is no path to "open my fleet from my phone / another laptop / a colleague's machine." The bundled local Harness (Loopback Core) forces a second, trusted, no-auth code path through the whole stack, doubling the transport logic the team maintains. And the upcoming open-source launch would inherit all of this surface.

## Solution

Extract the Panel out of Electron into a **single self-hosted web service**: one deployable (Docker image, also runnable as a plain Node process) that terminates every core-link and serves the Panel UI (SSR + hydrated React, the existing stack) to any browser. The operator deploys it once — on a cloud VM behind their reverse proxy, or on their own machine — sets a password at first boot, and reaches their whole fleet from any browser as a single authenticated Operator. The Loopback Core is deleted: the Panel bundles no Harness, and every Core — including one on the operator's own machine — is installed separately and registered with a pairing token. Each browser tab holds one multiplexed **panel link** WebSocket carrying `coreId`-tagged frames for all Cores; the Panel routes frames between panel links and core-links. Electron, its seven dependent files, its IPC surface, and its distribution pipeline are removed entirely.

## User Stories

### Deploying and reaching the Panel

1. As an operator, I want to start the Panel with a single `docker run`/`docker compose up`, so that hosting my fleet manager takes one command on any machine.
2. As an operator, I want a reference compose file with a TLS-terminating proxy included, so that getting HTTPS is copy-paste rather than research.
3. As an operator, I want the Panel to also run as a plain `node` process without Docker, so that I can run it directly on a machine where containers are unavailable or unwanted.
4. As an operator, I want all Panel state (registry, settings, secrets) kept in one data directory/volume, so that backup, migration, and upgrade are a matter of preserving one path.
5. As an operator, I want to upgrade the Panel by pulling a new image and restarting, so that there is no in-app updater to babysit.
6. As an operator, I want the Panel reachable from any of my devices' browsers — laptop, second machine, phone — so that my fleet is not chained to one desktop.

### First boot and authentication

7. As an operator, I want the Panel's first boot to walk me through setting my password, so that the service is never reachable in an unauthenticated state.
8. As an operator, I want to log in with that password and stay logged in via a session cookie, so that day-to-day use doesn't feel like a login wall.
9. As an operator, I want to log out and to change my password, so that I can respond to a device loss or a shared-screen mistake.
10. As an operator, I want every Panel API and WebSocket endpoint to reject unauthenticated access, so that exposing the Panel to the network exposes a login page and nothing else.
11. As a future maintainer, I want the Operator modeled as a first-class entity that owns Cores, so that a multi-account product can later replace the auth gate without rewriting the registry.

### Registering and managing Cores

12. As an operator, I want first login to greet me with "add your first Core" and the install instructions, so that the empty Panel tells me exactly what to do next.
13. As an operator, I want to paste a pairing token into "Add Core" and see the Core appear with a live dial status, so that pairing a machine is one paste.
14. As an operator, I want Core secrets from the pairing token encrypted at rest in the Panel's data volume, so that a casual copy of my database doesn't leak fleet credentials.
15. As an operator, I want to supply the secrets encryption key from outside via environment variable if I choose, so that the key doesn't have to live next to the data.
16. As an operator, I want the Panel to keep dialing and watching all my Cores while no browser is open, so that reconnects, cursors, and (later) notifications don't depend on me having a tab open.
17. As an operator, I want a Core running an incompatible protocol version to show as "needs update" with the exact command to run, so that version drift is a clear chore, not silent breakage.

### Working the fleet from the browser

18. As an operator, I want Fleet view, Per-Core navigation, SessionGrid, and TerminalPane to work in the browser exactly as they did in the desktop app, so that the extraction changes where the Panel runs, not what it is.
19. As an operator, I want live terminals (xterm) streaming over my panel link with keystroke-level responsiveness, so that remote sessions feel local.
20. As an operator, I want one WebSocket per tab no matter how many terminals and Cores I have open, so that reconnect behavior is single and predictable.
21. As an operator, I want a dropped panel link to reconnect and replay missed events from my cursor, so that a flaky network never costs me state I didn't see.
22. As an operator, I want two open tabs (or two devices) to both work and show consistent Harness-owned state, so that I can glance from my phone while my laptop has the grid open.
23. As an operator, I want to browse the Core's filesystem in a folder-picker dialog when adding a Project, so that I never have to type a VM path blind (typing one remains available and is validated by the Harness).
24. As an operator, I want browser notifications when a session finishes while my tab is open (even backgrounded), and clicking one to jump to that session, so that I don't watch the grid.
25. As an operator, I want VM Shell Sessions to keep requiring an explicit open gesture and authenticated access, so that the escape hatch stays deliberate.

### Contributor and maintainer stories

26. As a contributor, I want the repo split into harness / panel / shared workspace packages with the wire contract compile-time-shared, so that a frame change that breaks either side fails the build, not the fleet.
27. As a contributor, I want `node-pty` and `better-sqlite3` on the normal Node ABI with no Electron rebuild step, so that clone → install → dev works without native-module archaeology.
28. As a contributor, I want a dev loop that runs the Panel service + UI with hot reload against a local or containerized Harness, so that day-to-day development doesn't need a packaged build.
29. As a maintainer, I want the Panel release to be a Docker image (and the underlying Node build), so that the entire desktop pipeline — four OS targets, signing, notarization, updater feeds — disappears from the Panel's release story.
30. As a maintainer, I want the Electron dependency tree, IPC surface, preload contract, and dead code fully removed rather than stranded, so that the open-source repo presents one coherent architecture.
31. As a test author, I want a containerized Harness I can provision as a fixture, so that e2e and API tests run against a real Core in a disposable, reproducible ecosystem.

## Implementation Decisions

- **One deployable, two logical layers.** The Panel service serves SSR + static assets and owns all live connections; the Panel UI is the browser-side layer. No separate UI container. The existing TanStack Start server entry is the seed of the service — it already runs as a standalone HTTP server today; the work is promoting it from "child of Electron main" to "the process."
- **The bridge interface is the extraction seam.** All renderer access to platform capabilities already flows through a single typed bridge (the preload contract) behind one accessor. That contract is reshaped into the formal Panel-UI bridge with a web implementation backed by the panel link + HTTP; UI components keep their call sites. Electron-only bridge members (dialogs, clipboard-native, focus mode, updater, power, spellcheck, path-for-file, zoom) are deleted with their features per ADR 0010.
- **Core-link clients move wholly server-side.** The existing transport-agnostic core-link client class (zero Electron imports, injectable socket factory and cursor storage) is instantiated per registered Core inside the Panel service — the pattern the remote-core dialer already uses in Electron main. The renderer-held loopback client, the loopback/remote branches in fleet and CLI-availability code, and `LOOPBACK_CORE_ID` are deleted.
- **Panel link protocol.** One WebSocket per Panel session. Frames reuse core-link framing with a `coreId` envelope; the Panel is a router, not a translator. Server → browser: PTY output, Events, dial-status changes, availability snapshots. Browser → server: PTY spawn/write/resize/kill, task/project mutations, queries. Event replay to the browser uses the same cursor discipline as core-link replay. Panel-link auth is the session cookie presented at WS upgrade.
- **Auth.** First-boot setup creates the single Operator (name + password hash, modern KDF). Login issues an HTTP-only session cookie; sessions are server-side records so logout/password-change revokes them. The loopback-trust logic (host allow-lists, "no untrusted web runtime" assumption, IPC origin pinning) is removed, not bypassed. The existing bearer-token store for the local API dies with loopback.
- **Secrets at rest.** Core secrets are encrypted with a key from an auto-generated key file in the data directory, overridable via `AC_SECRETS_KEY`. The safeStorage backend and its "refuse plaintext" fallback are replaced by this scheme (ADR 0011).
- **Panel persistence.** The Panel keeps a single SQLite database in its data directory for: Operator + sessions, Core registry, encrypted Core secrets, per-Core `lastEventId` cursors (now Panel-service-owned, since the service dials whether or not a browser is open), and app settings that are genuinely Panel-wide. Browser-local view preferences (grid layout, collapsed groups, theme, zoom) stay in browser localStorage as today.
- **Folder browsing over the core-link.** New core-link frames for listing directories on the Harness (list, create), consumed by a folder-tree dialog in the Panel UI. Native dialog channels are deleted. The Harness validates all paths as today.
- **Notifications v1.** Session-finished Events already flow to the Panel; the web implementation surfaces them via the browser Notification API from open tabs, with click-through routing to the session. In-app toasts/sounds are unchanged. Web Push is out of scope (phase 2, ADR 0012).
- **Version lock.** The core-link handshake carries a protocol version; mismatch marks the Core "needs update" in the registry and suppresses its data paths. No feature detection (ADR 0005 upheld).
- **Repo restructure.** pnpm workspace packages: harness (standalone daemon), panel (service + UI), shared (frames, protocol, mutation/query contracts, registration-blob codec). Harness code already imports no Electron; the restructure relocates and de-Electronizes build tooling (normal Node ABI, no `ELECTRON_RUN_AS_NODE`, no asar).
- **Deletion list.** Electron main/preload/IPC channels/safe-handle, focus mode, update manager, session-finish native notifications, power/spellcheck/swipe/window plumbing, the dead PTY IPC registration, electron-builder config, Electron-ABI native tooling, and the desktop release matrix. The Harness smoke seam is re-pointed at the standalone Harness build rather than an AppImage.
- **Config surface.** Port, data directory, and secrets key via environment (documented defaults); the Panel listens plain-HTTP and trusts the reverse proxy for TLS (ADR 0010). The old userData port file and its consumers go away with Electron.

## Testing Decisions

- **A good test drives the system from outside a seam and asserts observable behavior** — HTTP responses, WS frames, emitted Events, rows visible through queries — never internal wiring.
- **Primary seam (new): black-box Panel service test.** Boot the built Panel service as a plain Node process with a temp data directory; boot a real Harness; drive the Panel exactly as a browser would: first-boot setup → login → cookie → open panel link → add Core from a real registration blob → list projects/tasks → spawn a PTY → assert `coreId`-tagged frames stream → drop the link → reconnect → assert replay from cursor. One seam covers auth, registry, secrets, the router, and a live core-link. Prior art: the packaged-Harness smoke script (same sentinel-driven, process-spawning style).
- **Canonical test ecosystem: containerized Harness.** A Docker-provisioned Core ("Core-in-a-box") is the standing fixture for e2e/API tests — tests provision the container, pair it with the Panel under test via its registration blob, and run against a real, disposable Core. The v1 smoke may spawn the Harness as a local process where Docker isn't available (CI macOS), but the container fixture is the direction all future e2e/API testing builds on. Prior art: the Docker systemd-container matrix explored in the previous (scrapped) distribution effort.
- **Unit level:** shared frame codecs, panel-link router fan-out/fan-in, secrets encryption round-trip, session/auth logic — plain vitest. Existing Harness unit tests (stores, cert material, install, autostart) survive relocation unchanged. Prior art: the existing electron `__tests__` suites.
- **UI:** no browser-automation layer in this spec. The React/xterm surface keeps its components and swaps transports behind the bridge; verification is the service seam plus a manual pre-release checklist.

## Out of Scope

- **Web Push / service worker notifications** (phase 2 of ADR 0012) — v1 is tab-open Notification API only.
- **Multi-user accounts, permissions, tenancy** — the closed-source product in a separate repo (ADR 0011). Nothing tenancy-shaped lands here.
- **A web replacement for focus mode** — intentionally sacrificed (ADR 0010); the compact-route idea is parked.
- **Harness distribution re-plan** — installer UX, curl|bash, binary packaging, and any code-signing questions for the Harness are a separate planning effort on top of this extraction.
- **Panel data migration from the Electron app** — pre-launch, no users to migrate.
- **Mobile apps** — the phone story is "the Panel in a mobile browser" for now.
- **VM provisioning** — unchanged stance from ADR 0009.

## Further Notes

- The extraction is with the grain, not against it: the window already loads `http://127.0.0.1`, the SSR server and API router already exist, the core-link client is already portable, and only seven files import Electron. The hard, genuinely new work is auth, the panel-link router, and the folder-browse frames — the rest is relocation and deletion.
- ADR 0004's tension resolves itself: with loopback gone, the mutation-frame path is the only write path, and the Panel-side HTTP write API dies rather than needing the "bundle the server onto the Harness" exit ramp.
- The glossary (CONTEXT.md, rewritten 2026-07-31) is authoritative for all naming in this spec: Panel, Panel UI, Operator, Panel session, Panel link, Core, Harness, Registration blob ("pairing token" in UI strings only).
