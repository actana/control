# Panel becomes a self-hosted web service (drop Electron)

The Electron Panel forced a per-OS distribution story — mac/win/linux builds, code signing, notarization, native-module ABI rebuilds, an auto-updater — for what is, underneath, already a local web server: the renderer loads `http://127.0.0.1:<port>` from a bundled TanStack Start server, and only seven files in `electron/` actually import Electron. We drop Electron entirely. The Panel ships as **one self-hosted web service** — a single deployable (Docker image; also runnable as a plain Node process) that serves the Panel UI to any browser. The operator's browser is the client; there is no desktop app.

Shape of the decision:

- **One deployable, two logical layers.** The Panel service terminates every core-link and serves the UI (SSR + hydrated React, the existing stack). "Backend" and "UI" are layers inside one container, not two containers — splitting them would double the ops surface for zero benefit since the UI is static assets + SSR from the same codebase.
- **The Loopback Core is deleted.** The Panel bundles no Harness. First boot shows "add your first Core"; a Core on the operator's own machine is installed separately and registered with a pairing token like any other. This removes the in-process transport, the trusted no-auth loopback path, the `LOOPBACK_CORE_ID` branches, and the dual write path tolerated by ADR 0004 — every Core now takes the mutation-frame path.
- **TLS belongs to the reverse proxy.** The Panel listens on plain HTTP; Traefik/Nginx/Caddy in front provides HTTPS (a reference compose file with automatic Let's Encrypt ships in docs). `localhost` is a secure context without TLS. The Panel never grows ACME/cert-management code.
- **One repo, workspace packages.** `packages/harness` (standalone Node daemon), `packages/panel` (service + UI), `packages/shared` (core-link/panel-link frames, protocol types). Lockstep versioning (ADR 0005's version gate survives, enforced at the core-link handshake) requires the shared contract to be compile-time-checked across both sides, which separate repos would break.
- **Native modules return to normal Node ABI.** With Electron gone, `node-pty` and `better-sqlite3` need no Electron-ABI rebuilds anywhere; the `native:electron:*` script family and `ELECTRON_RUN_AS_NODE` child-process trick disappear.

## Considered Options

- **Keep Electron and add a web build (rejected).** Two runtime surfaces, two notification/dialog/clipboard paths, and the entire signing/updater burden retained — the burden was the reason to move.
- **Two containers (UI service + backend service) (rejected).** The user-visible "two services" are the browser and the Panel; a separate UI container serves files the backend can serve itself.
- **Server-driven thin client (LiveView-style) (rejected).** Would discard a working React/xterm frontend; xterm and the PTY frame stream are already browser-shaped.

## Consequences

- Electron-only features are dropped deliberately: **focus mode** (always-on-top mini window — the one real loss; a compact `/focus` route in a small pinned browser window is parked as future work), the auto-updater (already disabled; replaced by pulling a new image), "reveal in Finder"/open-path, battery-saver throttling, the spellcheck toggle, swipe-back navigation, native window background color.
- Folder picking becomes Harness-side: the native dialog dies, replaced by `fs.listFolders`-style core-link frames rendered as a folder-tree dialog in the Panel UI (typed path stays as fallback, validated by the Harness). Drag-a-folder-from-Finder dies with it — `webUtils.getPathForFile` has no web equivalent, and it only ever made sense for loopback.
- OS notifications are replaced per ADR 0012 (browser Notification API now, Web Push later).
- The `ElectronBridge` preload contract becomes the formal Panel-UI bridge interface with a web implementation over the panel link; the ~140 renderer call sites behind `getElectron()` are the extraction seam.
- The `127.0.0.1`-trust security model (`auth.ts` loopback hosts, IPC origin allow-list, no-auth loopback core-link) is void; browser access is authenticated per ADR 0011.
- Desktop distribution planning (installers, macOS notarization, Windows signing for the *Panel*) is void. Signing questions may still apply to the Harness binary and must be re-raised in Harness distribution planning.
- ADR 0001's "local application" phrasing and ADR 0004's loopback write-path carve-out are amended by this ADR; their core decisions (detached Harness, Harness owns writes) stand.
