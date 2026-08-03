# 01 — Per-platform Harness tarballs + checksums

**What to build:** CI builds the Harness release artifact for all four targets — mac-arm64, mac-x64, linux-x64, linux-arm64 — as tarballs containing a pinned Node runtime, the bundled Harness app, prebuilt normal-ABI native modules (node-pty, better-sqlite3), and the `actana` launcher entry. A tag push produces a GitHub Release carrying the four tarballs plus a `SHA256SUMS` asset. No signing anywhere. The tarball embeds its version and core-link protocol version.

**Blocked by:** web-panel-extraction 01 — Workspace restructure (standalone Harness package must exist). Done.

**Status:** in-review (branch `wt-i01`)

- [x] Extracting a tarball on its target platform and running the launcher boots a dialable Harness with no system Node and no network fetches
- [x] All four targets build in CI; linux-arm64 and mac-arm64 are real-architecture builds, not cross-compile guesses left unverified
- [x] `SHA256SUMS` covers every tarball and verifies
- [x] Release workflow runs on tag push and attaches all assets to a GitHub Release
- [x] No signing/notarization steps or secrets exist in the workflow

## How it landed

- `scripts/lib/harness-tarball.mjs` — the pure parts (target table, Node dist URLs, SHASUMS parse/format, manifest, dependency-layout planning), unit-tested in `scripts/__tests__/harness-tarball.test.mjs`.
- `scripts/build-harness-tarball.mjs` — builds the tarball for the host's own target. Refuses a `--target` its host cannot honestly build, because the natives are copied from the host's install. Downloads the pinned Node runtime and verifies it against that release's `SHASUMS256.txt`.
- `scripts/compose-harness-shasums.mjs` — the `SHA256SUMS` release asset, in the format `sha256sum -c` accepts. `--expect 4` refuses to ship a partial set.
- `scripts/smoke-harness-tarball.mjs` — extracts a tarball and boots it through `bin/actana` with every Node scrubbed from `PATH`, then dials the core-link. Shares its machinery with the standalone smoke via `scripts/lib/harness-smoke.mjs`.
- `.github/workflows/harness-release.yml` — four real-architecture runners on tag push, each smoking its own tarball; then compose + verify + attach. No secrets beyond `github.token`.
- `.github/workflows/ci.yml` — a `harness-tarball-smoke` job builds and smokes the linux-x64 tarball on every PR, so regressions surface before tag time.

`bin/actana` is a launcher only: it execs the bundled Node on the Harness entry. Issue 02 replaces the exec target with the `actana` CLI (`setup`, `status`, `token`, `update`, …); this file is the seam it slots into.
