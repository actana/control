# 04 — macOS support: LaunchAgent + CI runner coverage

**What to build:** The full install story on macOS (Apple-silicon and Intel): `actana setup` writes and loads a LaunchAgent instead of a systemd unit, the daemon starts and survives logout per launchd semantics, and every lifecycle verb (`status/token/start/stop/restart/logs`) works against launchd. The one-liner path (detect mac + arch → fetch → verify → setup) runs headlessly on GitHub Actions macOS runners in CI. Reboot persistence, which CI can't exercise, lands on a short written pre-release checklist.

**Blocked by:** 02 — `actana setup` + lifecycle verbs (Linux).

**Status:** in-review (branch `wt-i04`)

- [ ] **Partial.** On a macOS CI runner, extracting the tarball and running `actana setup` ends with a loaded LaunchAgent, running daemon, and printed pairing token, with no sudo asked for and nothing blocked by Gatekeeper. The *one-liner* half — detect platform, fetch, verify checksum — is not covered, because `install.sh` and the fixture server are issue 03 and do not exist yet (see below).
- [x] All lifecycle verbs behave equivalently to Linux; `logs` surfaces daemon output via launchd's mechanism
- [x] Both mac architectures covered (native `macos-15` and `macos-15-intel` runners)
- [x] Reinstall over an existing LaunchAgent is idempotent — over a loaded one and over an unloaded one. *Uninstall* is not covered: there is no `actana uninstall` verb yet, it is issue 06. Until then the checklist spells out the manual teardown.
- [x] The manual reboot-persistence checklist exists in docs

## How it landed

**The seam.** `actana-service.ts` is where the init system lives and stops:
`ActanaServiceManager` has the six operations setup and the verbs actually need
— write the definition, register it, make it persist, start it, read its state,
show its logs — and `actana-setup.ts` / `actana-cli.ts` now know about that,
not about `systemctl` or `launchctl`. The rendering and parsing each platform
needs stays pure and directly covered: `actana-systemd.ts` as before, and the
new `actana-launchd.ts` (plist rendering with XML escaping, `launchctl print`
parsing, domain selection). What is left in `actana-service.ts` is command
sequencing, which runs through the existing `ActanaSystem` port — so the whole
launchd path is exercised on a machine with no launchd, and the setup/CLI tests
drive the *real* manager over a fake system rather than a second fake of the
init system asserting that it matches itself.

**The plist.** `~/Library/LaunchAgents/com.actana.harness.plist`, `RunAtLoad` +
`KeepAlive` (the launchd half of `Restart=always`), `ProcessType=Interactive`
so a Core running the operator's agents is not throttled as housekeeping, and
both streams to `~/Library/Logs/Actana/harness.log`. `ProgramArguments` goes
through `current` exactly as `ExecStart` does, so issue 06's `update` is still
one symlink swap on both platforms.

**`KeepAlive` is why `stop` unloads.** `launchctl stop` would kill the daemon
and launchd would restart it a second later, so `actana stop` boots the agent
out of the domain and `actana start` bootstraps it back; `restart` is
`kickstart -k`. Stopping an already-stopped Core exits 0, matching systemd,
because an operator scripting a redeploy will do exactly that. `start` treats
*loaded* and *running* as different states — review caught a first cut that
no-op'd on any loaded job, which would have left a crash-looping daemon
unstartable where `systemctl start` would have acted; it now kickstarts a job
that is loaded but not running.

**The domain is probed, not assumed.** `gui/<uid>` is where a logged-in Mac's
agents live, but a machine reached over SSH — or a CI runner — may have no Aqua
session, so `chooseLaunchdDomain` falls back to `user/<uid>`. Probed once per
process and remembered.

**macOS does not survive logout, and says so.** A LaunchAgent is bound to the
login session; outliving it would take a root-owned LaunchDaemon, and this
install is sudo-less by design. Rather than paper over that, the status report
lost its systemd-shaped `linger` field for a platform-supplied persistence row —
`Linger: yes` on Linux, `At login: yes — starts when you log in, stops when you
log out` on macOS — and setup's summary line says `loaded, starts at login`.
INSTALL.md and CONTEXT.md's "Auto-start unit" entry were corrected to match;
the old glossary text claimed macOS survived logout, which it never did.

**Gatekeeper — nothing added, deliberately.** The first cut had setup run
`xattr -dr com.apple.quarantine` over the install tree, defending against a
tarball that arrived by browser or AirDrop. Review caught that as scope creep
against a decision the spec has already made: "No code signing… (the curl path
never sets the quarantine attribute)… Revisit only if a browser-download
distribution is ever added." So it is gone. The criterion is met by the e2e
execing the bundled `node` through launchd on both architectures and getting a
running daemon — if Gatekeeper intervened, that is where it would show. The
manual checklist carries an explicit "no Gatekeeper dialog" box for the case CI
cannot see (a human double-clicking a downloaded tarball).

**The e2e** (`scripts/e2e-actana-setup-macos.mjs`, `pnpm harness:setup:e2e:macos`)
runs the real tarball against the host's own launchd — no container, because a
Mac's launchd *is* the host's launchd and an agent bootstrapped into any other
domain would not be the thing under test. It uses a scratch `HOME` (so the
plist, install tree, material and log all land there), refuses to run if a real
Core is already loaded, and boots the agent out on the way out. It walks setup,
the loaded-and-running agent, a core-link dial with the printed token, every
lifecycle verb, `logs` through the log file, a re-run over a loaded agent, and a
re-run over an unloaded one. Wired into `ci.yml` as `actana-setup-e2e-macos`,
matrixed over `macos-15` (arm64) and `macos-15-intel` (x64), each building its
own tarball because the natives are copied from the build host. Verified green
on a real Apple-silicon Mac during development, not only in CI.

**The reboot checklist** is `docs/harness-macos-prerelease-checklist.md`: the
Gatekeeper-dialog check, reboot-and-log-back-in, the logout claim the `At login`
row makes, and how to leave the machine clean until `uninstall` (issue 06)
exists.

**Deliberately not done — the one-liner's fetch half.** The criterion as written
says "the one-liner (against the fixture server)", but `install.sh` and the
fixture server are issue 03 and are not built yet — issue 04 lists only 02 as
its blocker. Everything downstream of the download is covered here on both
architectures: extract → verify the tree → `actana setup` → running Core. When
03 lands, its fixture-server e2e should gain a mac leg reusing this job's
tarball step; the platform detection it needs (`mac-arm64` / `mac-x64`) is
already in `HARNESS_TARGETS`.
