# 02 — `actana setup` + lifecycle verbs (Linux)

**What to build:** The `actana` CLI inside the tarball owns the machine-side lifecycle on Linux. `actana setup` installs user-level (no sudo): lays out install/data dirs under the user's home, writes the systemd user unit, prompts for `loginctl enable-linger` where needed, starts the daemon, and finishes by printing the pairing token with a one-line "paste this into your Panel" instruction. Companion verbs work from the same binary: `status` (daemon state, version, endpoint, agent availability), `token` (reprint), `start`, `stop`, `restart`, `logs`. All operator-facing strings say "pairing token."

**Blocked by:** 01 — Per-platform tarballs. Done.

**Status:** in-review (branch `wt-i02`)

- [x] In a fresh systemd container, extracting the tarball and running `actana setup` yields an active user unit, a running daemon, and a printed pairing token — no sudo used
- [x] The printed pairing token decodes as a valid Registration blob and a test client dials the core-link with it
- [x] `actana status` reports healthy state, versions, endpoint, and agent availability; `token` reprints; `start/stop/restart/logs` control and show the daemon
- [x] Setup is idempotent: re-running over an existing install upgrades in place without duplicating units or breaking state
- [x] Daemon persists across logout (linger) and container reboot

## How it landed

**The CLI.** `bin/actana` now execs `app/actana-cli.cjs` rather than the daemon
directly; the daemon is reached through a `daemon` verb, which is what the unit's
`ExecStart` runs. `runActanaCli` in `packages/harness/src/actana-cli.ts` takes
every side effect as a dependency and returns an exit code instead of calling
`process.exit`, so dispatch, flag validation, output and exit codes are all unit
tested. `actana-cli-entry.ts` is the only file that touches the real process.

**Split by testability.** The parts that are easy to get subtly wrong are pure and
covered directly: `actana-layout.ts` (where everything goes, XDG handling,
version-directory escaping), `actana-systemd.ts` (unit rendering with systemd
quoting, `systemctl show` / `loginctl` parsing), `actana-config.ts`,
`actana-status.ts` (health rules and the rendered report). `actana-setup.ts`
orchestrates against a temp home with only the command runner faked —
`actana-system.ts` is that port.

**Install layout.** `~/.local/share/actana/versions/<v>` with a `current`
symlink, `~/.local/bin/actana` linked through it, config and material in
`~/.config/actana`, data in `<root>/data`, unit in
`~/.config/systemd/user/actana-harness.service`. The unit's `ExecStart` goes
through `current`, so issue 06's `update` swaps one link and restarts — no unit
rewrite. `XDG_*` is honoured; `ACTANA_HOME` / `ACTANA_CONFIG_DIR` /
`ACTANA_DATA_DIR` / `ACTANA_BIN_DIR` override individual slots.

**Idempotency is about the pairing, not the bytes.** Re-running setup reuses the
existing material, so a paired Panel stays paired; the printed token differs each
run only because the bearer inside carries a fresh expiry, and setup says so in
words rather than claiming the token is identical. Material is reissued only when
`--public-host` changed, because the old server cert's SAN would no longer verify
— and that case is called out with "re-pair this Core in your Panel."

**Linger.** Prompted and explained on a TTY, attempted without sudo, and
downgraded to a printed `sudo loginctl enable-linger <user>` when the machine
refuses. Never fatal: an install that only survives while logged in is still an
install, and saying so beats aborting.

**The e2e** (`scripts/e2e-actana-setup-linux.mjs`, `pnpm harness:setup:e2e`) runs
the real tarball in a privileged systemd Ubuntu container and walks the whole
criteria list: setup, unit active+enabled, a core-link dial with the printed token
(the same `dialAndListProjects` the tarball smoke uses), linger, every lifecycle
verb, an idempotent re-run, and a machine reboot after which the Core comes back
with the same identity. Two details worth knowing: the operator is reached through
`machinectl shell`, because that is the only way to get a real logind session —
`docker exec --user` gives no user manager and no `XDG_RUNTIME_DIR`, so
`systemctl --user` would test a situation no operator is ever in; and
`machinectl shell` always exits 0, so the script carries its own exit-status
sentinel (without it every assertion would be vacuous). The image has no sudo on
it at all, which makes "no sudo used" structural rather than observed. Wired into
`ci.yml` as `actana-setup-e2e`, consuming the tarball the smoke job already built.
(Issue 07 later folded this job into the matrixed `installer-e2e`, which runs the
same script across distros and both architectures.)

**Retired.** `harness-install.ts`, `harness-install-entry.ts` and
`harness-autostart.ts` (the Electron-era `harness install`) are gone, along with
their esbuild entry. `actana setup` supersedes them, and leaving two install flows
that write two differently-named systemd units to the same machine is a live
hazard, not dead code. `INSTALL.md` is rewritten for the tarball + `actana setup`
path; CONTEXT.md gains an `actana` glossary entry and its "Registration blob" /
"Auto-start unit" entries now name the command that actually writes them.

**Left for later tickets, deliberately:** macOS/launchd (04) — `setup` refuses to
run anywhere but Linux and says why; the `install.sh` one-liner (03); agent CLI
offers (05); `update` / `token regenerate` / `uninstall` (06); the multi-distro
matrix and the human rehearsal container (07).
