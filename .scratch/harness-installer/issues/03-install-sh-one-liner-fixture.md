# 03 — `install.sh` one-liner + hermetic release fixture

**What to build:** The public front door: `curl -fsSL <script-url> | bash` detects OS + architecture, resolves the requested version (latest by default, `--version` to pin), downloads the matching tarball from GitHub Releases, verifies it against `SHA256SUMS`, extracts, and execs `actana setup`, passing through non-interactive flags (`--yes`, agent flags, version). The script stays a thin bootstrapper — every real decision lives in the CLI. For tests, a local fixture HTTP server impersonates GitHub Releases so the full one-liner path runs hermetically in CI against locally built artifacts.

**Blocked by:** 02 — `actana setup` + lifecycle verbs (Linux). Done.

**Status:** in-review (branch `wt-i03`)

- [x] The real one-liner, run in a fresh systemd Ubuntu container against the fixture server, ends with a running Harness and a printed pairing token
- [x] Wrong-checksum and unknown-platform paths abort cleanly before executing anything, with actionable messages
- [x] `--version` installs the exact pinned release; default resolves latest
- [x] Piped (non-TTY) runs make no interactive prompts; flags cover every choice
- [x] Re-running the one-liner on an installed machine upgrades in place safely

## How it landed

**`install.sh` at the repo root, and nothing else.** Detect the platform,
resolve the release, fetch `SHA256SUMS`, fetch the tarball, verify, extract,
exec `actana setup`. It owns three flags — `--version`, `--repo`, `--base-url`
(plus `ACTANA_VERSION` / `ACTANA_REPO` / `ACTANA_BASE_URL`) — and forwards
everything else verbatim, so the agent flags issue 05 adds work through it on
the day they exist without the script changing. POSIX `sh`, so `| bash`,
`| sh` and dash all behave the same.

**Order is the security property.** Checksums are fetched before the tarball,
because they name every asset in the release and therefore answer both "does
this release exist" and "does it have a build for this machine" before a byte
of tarball is downloaded. A platform we do not build for aborts before any
network call at all. A digest mismatch aborts before `tar`. Every abort the
script itself takes leaves an empty temp dir and an untouched machine, and the
tests assert that rather than assume it.

What the checksum proves is bounded, and both the script and INSTALL.md now say
so: the tarball and the checksums come over the same channel, so it catches
corruption and truncation, not a release channel someone else controls. The
spec rejects code signing outright, so this is the honest ceiling — not a gap
to close later. Interrupting `actana setup` half-way is likewise outside the
script's reach: setup owns what it has written by then, and is idempotent by
design (issue 02) so re-running is the recovery.

**Two hazards specific to `curl | bash`, both handled.** The script is one
`main "$@"` call after a wall of definitions, so the shell has read all of it
before any of it runs — a child cannot eat the tail of the script off stdin.
And `setup` is given `/dev/null` for stdin when there is no terminal, so a
piped run cannot consume the pipe either. With no TTY, `setup` prompts for
nothing and takes its answers from flags; run from a real terminal, the script
passes its stdin through and the prompts still work.

**The fixture release server** (`scripts/lib/fixture-release.mjs`,
`scripts/fixture-release-server.mjs`) serves a directory of tarballs as GitHub
Releases: the release API's `latest` and `tags/<tag>` shapes, asset downloads,
and `install.sh` itself. Releases come from the file names, so a directory
holding two versions is a two-release fixture with no manifest to maintain, and
`SHA256SUMS` is digested from the bytes on disk — which is what makes
`--corrupt` a real integrity failure rather than a hand-written wrong number.
It is also a command (`pnpm fixture:release --dir artifacts/harness`), so the
one-liner can be rehearsed against a local build with no release published.

**Two test seams, chosen for what each can prove.**
`scripts/__tests__/install-sh.test.mjs` runs the real script, piped to a real
shell, against the fixture — platform mapping (through a `uname` shim, so the
real branch runs), latest-vs-pinned, checksum refusal, flag passthrough,
exit-code propagation, temp-dir cleanup. It takes five seconds and runs on
every platform CI has. `scripts/e2e-install-sh-linux.mjs` runs the literal
one-liner in a privileged systemd container against a real tarball: a running
Harness, a printed pairing token a test client dials the core-link with, a
tampered download refused with the machine untouched, an unknown architecture
refused the same way, `--version` installing exactly what it names, and a
re-run upgrading in place to the latest with the paired credentials intact.
The "latest" of that pair is the same verified bytes repacked with a bumped
manifest version — enough to tell the two resolution modes apart without a
second twenty-minute build. Wired into `ci.yml` as `install-sh-e2e` (folded by
issue 07 into the matrixed `installer-e2e`), consuming
the tarball the smoke job already builds.

Review pass sharpened three of those tests. "Piped runs make no prompts" was
being proved by the harness rather than the script — the test spawned with no
stdin at all, so it would have passed even if `install.sh` handed the pipe
straight through. It now runs the installer with real data waiting on stdin and
asserts the child never sees it, and that assertion was mutation-checked
against a script with the `/dev/null` redirect removed. The abort paths now
assert an empty temp dir, not just that nothing ran. And `--version --yes` used
to pin a release called `--yes` and swallow the flag; flag values that look like
flags are refused, the way `scripts/lib/cli.mjs` already refuses them.

**The container machinery moved to `scripts/lib/systemd-container.mjs`** —
image, boot wait, `machinectl shell` with its exit-status sentinel, port
waiting, token extraction — and issue 02's e2e now runs on it too. Two
installer tests disagreeing about what a fresh machine looks like would be
worse than the duplication.

**Not this ticket:** macOS (04) — the installer maps Macs to `mac-*` targets
and downloads them, and `actana setup` is what still refuses; agent CLI offers
(05), whose flags already pass through; `actana update` (06), which will verify
against the same `SHA256SUMS` this script does; the multi-distro matrix and the
human rehearsal container (07), for which the fixture server command is the
missing half.
