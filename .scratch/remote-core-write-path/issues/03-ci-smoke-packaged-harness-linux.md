# 03 — CI smoke test: packaged Harness boots clean on Linux

**What to build:** A CI step (on the Linux leg of `release.yml`, plus a matrix job that cross-builds Linux from macOS) that unpacks the packaged artifact, runs the Harness headlessly under `ELECTRON_RUN_AS_NODE=1` against a temp `HOME`, waits for the `@@MC_HARNESS_LISTENING@@` marker, then asserts zero `open-failed` / `db-missing` lines and that `projectsList` returns `[]` (real schema, not stub). The test guards tickets 01 and 02 from regressing — if a future change ships a Harness that can't open SQLite or migrate its schema, this fails loudly instead of surfacing as spam on someone's VM weeks later.

**Blocked by:** 02 — the assertion "clean boot, `projectsList` returns `[]` against a real schema" only holds once 02 lands.

**Status:** ready-for-agent

- [ ] A CI job (Linux) launches the packaged Harness from `dist-electron-out/linux-unpacked/` under `ELECTRON_RUN_AS_NODE=1`, waits for `@@MC_HARNESS_LISTENING@@`, then dials the core-link over loopback.
- [ ] The job asserts zero `event-log.open-failed`, zero `harness-query.open-failed`, zero `project-roots.open-failed`, zero unthrottled `db-missing` in the captured logs.
- [ ] The job dials the core-link, sends `projectsList`, and asserts a well-formed empty response (proves the schema exists — not the `db-missing` degradation path).
- [ ] A second matrix leg cross-builds Linux from macOS (`pnpm dist:linux` on a mac runner) and runs the same smoke on the resulting AppImage — guards ticket 01's cross-target prebuilds.
- [ ] Job fails within ~30s if the marker never appears (no indefinite hang).
- [ ] Failure output includes the tail of Harness stdout/stderr so triage doesn't need a rerun.
