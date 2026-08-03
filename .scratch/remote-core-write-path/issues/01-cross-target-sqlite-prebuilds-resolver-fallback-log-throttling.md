# 01 — Cross-target Electron sqlite prebuilds + resolver unpacked fallback + log throttling

**What to build:** Stop shipping Harness artifacts that can't open SQLite. Extend the native prebuild pipeline so that when packaging for a non-host target (e.g. `pnpm dist:linux` on macOS, `dist:all`), the correct Electron-ABI `better-sqlite3.node` for every target platform/arch is fetched via `prebuild-install -r electron -t <electronVersion> --platform <p> --arch <a>` and staged at `bin/<p>-<a>-<electronAbi>/better-sqlite3.node` before electron-builder packs. Missing prebuilds must hard-fail the pack, not silently ship. Additionally harden `better-sqlite3-native-binding.ts` (both copies — `electron/` and `src/db/`) to probe the `app.asar.unpacked` sibling path before throwing, and include the expected `platform-arch-abi` in the error so field reports self-diagnose. Finally, throttle `event-log.open-failed` (and sibling `*.open-failed` logs) with the same first-verbatim / 1-per-60s summary pattern the existing `db-missing` path uses, so a boot failure logs once instead of twice a second.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `scripts/ensure-electron-sqlite.mjs` (or a new `native:electron:sqlite:targets` script wired into `dist:*`) downloads Electron-ABI prebuilds for every declared target platform/arch and stages them at `bin/<platform>-<arch>-<abi>/better-sqlite3.node`.
- [ ] A macOS-built `pnpm dist:linux` AppImage contains `bin/linux-x64-145/better-sqlite3.node` inside `app.asar` (verified in `dist-electron-out/linux-unpacked/`).
- [ ] A missing target prebuild fails the pack with a clear error naming the missing target — never a silently broken artifact.
- [ ] Both `electron/better-sqlite3-native-binding.ts` and `src/db/better-sqlite3-native-binding.ts` probe `app.asar.unpacked` before throwing.
- [ ] The binding-missing error message names the expected `platform-arch-abi` (e.g. `linux-x64-145`) and the two paths probed.
- [ ] `event-log.open-failed`, `harness-query-store.open-failed`, `project-roots.open-failed` (and any peers) are throttled: first occurrence logged verbatim, subsequent within 60s collapsed to a `{count, error}` summary.
- [ ] Existing `db-missing` throttling still fires as before (no regression on the missing-file path).
