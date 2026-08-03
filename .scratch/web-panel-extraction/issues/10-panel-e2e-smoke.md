# 10 — Black-box Panel e2e smoke (primary seam)

**What to build:** The spec's primary testing seam, in CI: a test boots the built Panel service (plain Node, temp data dir) and a real Harness, then drives the Panel exactly as a browser would — first-boot setup → login (cookie) → paste a real registration blob → assert dial connected → list projects/tasks → spawn a PTY and assert `coreId`-tagged output frames → drop the panel link → reconnect → assert replay from cursor. Process-spawning, sentinel-driven style (descendant of the packaged-Harness smoke). The Harness fixture runs as a local process where Docker is unavailable, but the harness boot is factored so the containerized Core-in-a-box (installer epic) can slot in as the fixture later.

**Blocked by:** 05 — Terminals in the browser; 06 — Writes.

**Status:** ready-for-agent

- [ ] One CI-runnable command executes the full flow above against freshly built artifacts and exits nonzero on any failed step
- [ ] Auth is exercised negatively too: pre-login API and WS-upgrade attempts are rejected
- [ ] Secrets round-trip is covered: registered Core's secrets unreadable without the key file; `AC_SECRETS_KEY` path exercised
- [ ] Reconnect assertion proves no event loss across a killed panel link
- [ ] Runs in CI on Linux and macOS runners; wired into the standard check suite
