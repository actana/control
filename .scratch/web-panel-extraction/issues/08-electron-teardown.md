# 08 — Electron teardown

**What to build:** Delete the desktop shell and every Electron-only surface, leaving one coherent web architecture. Gone: Electron main/preload, the IPC channel surface and its contract mirror, the Loopback Core (`LOOPBACK_CORE_ID` and every branch on it), focus mode, the update manager, native notifications, power/spellcheck/swipe/window plumbing, native dialogs and clipboard, electron-builder config, and the Electron dependency tree itself. The bridge interface keeps only its web implementation. Dropped features match ADR 0010's deliberate-sacrifice list exactly — nothing else quietly disappears.

**Blocked by:** 05 — Terminals in the browser; 06 — Writes; 07 — Version gate + notifications.

**Status:** ready-for-agent

- [ ] No `electron`/`electron-builder`/updater packages remain in any manifest; install and build succeed from clean
- [ ] Zero references to the loopback Core id, the IPC channels, or the preload contract survive outside git history
- [ ] Full check suite (typecheck, lint, unit, build) green after deletion
- [ ] The browser Panel retains every behavior delivered by tickets 02–07 (spot-check flows post-teardown)
- [ ] ADR 0010's dropped-feature list is the complete diff of lost functionality
