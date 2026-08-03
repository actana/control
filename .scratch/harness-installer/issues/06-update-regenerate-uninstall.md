# 06 — `actana update`, `token regenerate`, `uninstall`

**What to build:** The remaining lifecycle: `actana update` queries the Releases API (fixture in tests) for the latest — or a pinned — version, downloads, checksum-verifies, swaps the install atomically, and restarts the daemon; running agents' state survives per Harness event-log semantics. `actana token regenerate` mints fresh Registration-blob credentials and invalidates the old ones — a client dialing with old credentials is rejected until re-paired. `actana uninstall` stops the daemon, removes the auto-start unit and install directory, and keeps data unless `--purge-data` is passed.

**Blocked by:** 03 — `install.sh` one-liner + hermetic release fixture.

**Status:** in-review (branch `wt-i06`)

- [x] Fixture serves a newer version: `actana update` lands it, daemon restarts on the new version, `status` confirms; failed checksum aborts leaving the old install untouched
- [x] After `token regenerate`, the old blob's credentials are rejected on dial and the new blob works
- [x] `uninstall` leaves no unit, launcher, or install files; data dir preserved by default, removed with `--purge-data`
- [x] `update` honors `--version` for deliberate pinning (Panel↔Core version-lock recovery)
- [x] All three verbs behave on both Linux (systemd) and macOS (launchd)
