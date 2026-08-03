# Spec — Harness one-liner installer and `actana` CLI

**Status:** ready-for-agent
**Date:** 2026-07-31
**Origin:** Grilling session 2026-07-31 (follow-up to the Web Panel extraction spec). Parallel to `.scratch/web-panel-extraction/spec.md`; depends on its harness/panel/shared package restructure (standalone Harness daemon, normal Node ABI). Supersedes the scrapped install-distribution effort's decisions where they conflict; re-confirms them where they don't.

---

## Problem Statement

Turning a machine into a Core is the product's front door, and today it's a locked service entrance: manually download the right artifact, extract it, run an incantation with environment variables, hand-write the auto-start setup, then fish the registration blob out of the logs. A semi-technical operator — the exact person the Panel now serves from any browser — cannot do this. Installing a Core must feel like installing any modern developer tool: paste one command, answer a prompt or two, get a pairing token.

## Solution

A single command:

```
curl -fsSL <install-script-url> | bash
```

The script detects OS and architecture (macOS arm64/x64, Linux x64/arm64), downloads the matching Harness tarball from GitHub Releases, verifies its checksum, and hands off to the bundled CLI — which installs user-level (no sudo), writes the auto-start unit (systemd user unit + linger on Linux, LaunchAgent on macOS), offers to install any missing agent CLIs, starts the daemon, and prints the **pairing token** to paste into the Panel. Afterwards, one command — `actana` — owns the whole machine-side lifecycle: `status`, `token`, `token regenerate`, `update`, `start|stop|restart|logs`, `agents install`, `uninstall`.

## User Stories

### Installing

1. As an operator, I want to turn a fresh VM into a Core by pasting one command, so that provisioning a machine takes under a minute of my attention.
2. As an operator, I want the installer to detect my OS and CPU (Mac Apple-silicon/Intel, Linux x64/arm64) and fetch the right build, so that I never think about artifacts.
3. As an operator, I want the install to run entirely under my user account without sudo, so that I can install on machines where I'm not root (the one exception, enabling linger on some distros, is prompted and explained).
4. As an operator, I want the installer to verify the download against published checksums before running anything, so that a corrupted or tampered artifact never executes.
5. As an operator, I want the Harness to bundle its own pinned Node runtime and native modules, so that nothing about my system's Node (or absence of one) matters.
6. As an operator, I want the install to end by printing my pairing token with a one-line "paste this into your Panel" instruction, so that pairing is the obvious next step, not a treasure hunt.
7. As an operator, I want the installed Harness to start on boot and keep running when I log out, so that my Core is reachable without me SSHing in to babysit it.
8. As an operator, I want to re-run the installer on a machine that already has a Harness and have it upgrade in place rather than duplicate or break, so that the one-liner is always safe to run.
9. As a provisioning script author, I want non-interactive flags (`--version`, `--with-<agent>`, `--no-agents`, `--yes`), so that cloud-init or Ansible can install Cores unattended.
10. As an operator, I want to install a specific pinned version, so that I can match my Panel's protocol version deliberately.

### Agent CLIs

11. As an operator, I want the installer to detect which agent CLIs (claude, opencode, …) are missing and offer to install each, so that my first session doesn't fail with "command not found."
12. As an operator, I want `actana agents install <id>` available after install, so that declining at install time isn't a permanent choice.
13. As an operator, I want each agent installed via its vendor's official method, so that the agent's own updater and login flow work normally afterwards.

### Operating a Core

14. As an operator, I want `actana status` to show daemon state, version, endpoint, and agent availability at a glance, so that "is my Core healthy?" is one command.
15. As an operator, I want `actana token` to reprint my pairing token, so that pairing a second Panel or re-pairing doesn't require reinstalling.
16. As an operator, I want `actana token regenerate` to mint fresh credentials and invalidate the old ones, so that a leaked token is a one-command fix.
17. As an operator, I want `actana update` to fetch, verify, and swap in the latest release and restart the daemon, so that the "needs update" chore the Panel shows me is minutes, not an afternoon.
18. As an operator, I want the Panel's "needs update" state to display the exact `actana update` command, so that version drift resolves by copy-paste.
19. As an operator, I want `actana start|stop|restart|logs`, so that I control and inspect the daemon without learning systemd/launchd incantations.
20. As an operator, I want `actana uninstall` to stop the daemon, remove the auto-start unit, and delete the install cleanly (with an explicit flag for wiping data), so that leaving is as clean as arriving.

### Maintainer stories

21. As a maintainer, I want CI to build all four platform tarballs and attach them plus checksums to a GitHub Release, so that cutting a Harness release is tag-and-push.
22. As a maintainer, I want no code-signing secrets anywhere in the pipeline, so that releases have zero external signing dependencies (curl-fetched binaries carry no macOS quarantine flag, so Gatekeeper never intervenes).
23. As a maintainer, I want the install script to be a thin bootstrapper with all real logic in the unit-testable CLI, so that the bash surface stays too small to rot.
24. As a test author, I want systemd-enabled container images that run the real one-liner end to end, so that installer regressions are caught in CI — and the same images double as the "Core-in-a-box" fixture for Panel e2e tests.

## Implementation Decisions

- **Artifact = tarball with bundled runtime.** Per-platform archive containing a pinned Node runtime, the bundled Harness app, prebuilt native modules (node-pty, better-sqlite3 — normal Node ABI), and the `actana` launcher/CLI. No single-file executable (native modules defeat the purity), no reliance on system Node.
- **Install layout: user-level, sudo-less.** Everything under the operator's home (install dir, data dir, unit files). Linux: systemd *user* unit + `loginctl enable-linger` (prompted; the only possible privilege touch). macOS: LaunchAgent. Daemon runs as the installing user — agents need that user's projects, dotfiles, and CLI logins.
- **`install.sh` is a bootstrapper only:** detect platform → resolve version (latest or `--version`) → download from GitHub Releases → verify SHA-256 → extract → exec `actana setup` with the interpreted flags. Idempotent: re-running upgrades in place. All prompts, unit-writing, agent offers, and token printing live in `actana setup` (Node, unit-testable).
- **`actana` CLI verbs:** `setup` (installer entry), `status`, `token` / `token regenerate`, `update`, `start`, `stop`, `restart`, `logs`, `agents install <id>`, `uninstall [--purge-data]`. `token regenerate` reissues the Registration blob material and invalidates prior credentials; the Panel shows the affected Core as unauthorized until re-paired.
- **Agent CLI offers:** interactive per-agent Y/n on a TTY; `--with-<agent>` / `--no-agents` / `--yes` non-interactively. Each install shells to the vendor's official installer. The Harness's own CLI-availability probing is the source of truth for what's missing.
- **Distribution channel: GitHub Releases.** Tarballs + `SHA256SUMS` as release assets, built by the Actions release workflow (four targets: mac-arm64, mac-x64, linux-x64, linux-arm64 — no Windows Core; Windows operators use the web Panel and Linux/mac machines or WSL for Cores). `actana update` queries the Releases API, verifies checksums, swaps atomically, restarts. The install script lives in the repo; a vanity domain may alias it later without changing mechanics.
- **No code signing.** No Apple notarization (the curl path never sets the quarantine attribute), no Windows signing (no Windows artifact). Integrity = published checksums verified by both `install.sh` and `actana update`. Revisit only if a browser-download distribution is ever added.
- **Version lock integration.** The tarball embeds the core-link protocol version; `actana status` displays it; the Panel's "needs update" affordance (ADR 0005 gate, upheld in the extraction spec) renders the copy-paste `actana update` command.
- **Pairing-token language.** All operator-facing strings say "pairing token" per the glossary UI note; code and frames keep "Registration blob."

## Testing Decisions

- **A good test runs the real installer path and asserts operator-observable outcomes** — exit codes, unit active, `actana` verb output, a successful authenticated core-link dial — not script internals.
- **Primary seam: containerized end-to-end install matrix.** systemd-enabled Ubuntu and Debian images run the actual `install.sh` (against locally built artifacts served by a fixture HTTP server standing in for GitHub Releases): assert user unit active, `actana status` healthy, `actana token` emits a decodable Registration blob, and a test client dials the core-link with it. Exercise `token regenerate` (old credentials rejected, new accepted), `update` (fixture serves a newer version), and `uninstall` (unit gone, files gone). linux-arm64 runs on CI arm runners. These images are the same "Core-in-a-box" family the Panel spec names as its canonical e2e fixture.
- **Human rehearsal seam:** the same container images are runnable by hand — `docker run` a fresh systemd Ubuntu, paste the real one-liner inside it, answer the prompts, take the pairing token to a live Panel, and work the Core like an operator would. A documented `pnpm` script (or doc page) spins this "fake remote VM" up in one command so the rehearsal is routine before releases, not an expedition.
- **macOS seam:** GitHub Actions macOS runners execute `install.sh` and the full verb set headlessly (LaunchAgent loaded, daemon dialable). Reboot persistence can't run in CI — it lives on a short manual pre-release checklist.
- **Unit level:** platform/arch detection mapping, checksum verification, release resolution (latest vs pinned), unit-file generation, flag parsing — all in the Node CLI via vitest. Existing Harness install/autostart/cert-material unit tests carry over. Prior art: the existing electron-era `__tests__` install suites and the sentinel-driven smoke-script style.

## Out of Scope

- **Panel deployment and pairing UX** — the Web Panel extraction spec owns "Add Core," dial status, and needs-update rendering.
- **Windows Cores** — Panel-in-browser is the Windows story; Cores are macOS/Linux (WSL counts as Linux and gets no special handling in v1).
- **VM provisioning** (ADR 0009 stance unchanged) — the operator brings the machine.
- **Package-manager distributions** (Homebrew, apt/deb, AUR) — possible later aliases for the same tarballs; not v1.
- **Code signing / notarization** — explicitly rejected above; only revisited if a click-to-download path appears.
- **Agent CLI version management** — we install agents; keeping them updated is their vendors' updaters' job.

## Further Notes

- The scrapped install-distribution effort validated most of this shape (detect → fetch → unit → token, CLI shim, container matrix). What changed with the web Panel decision: no Electron runtime to smuggle, normal Node ABI, no Panel-side installer counterpart at all, and the signing escalation dissolves entirely.
- Dependency ordering: buildable per-platform Harness tarballs require the extraction spec's package restructure. The installer spec can proceed in parallel up to the point of producing real artifacts; the container matrix lands once `packages/harness` builds standalone.
- The fixture HTTP server pattern (local stand-in for GitHub Releases) keeps CI hermetic — no test depends on a published release existing.
