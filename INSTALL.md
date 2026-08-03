# Harness Installation Guide

This guide covers turning a **Linux or macOS** machine into a **Core**:
downloading the Harness bundle, running `actana setup`, and pairing the machine
with your Panel. The Harness is the stateful daemon that runs agents and owns
the PTY layer; the Panel is the web app you drive it from.

Everything here runs **as your own user, without sudo** — a systemd *user* unit
on Linux, a *LaunchAgent* on macOS. The one exception is Linux's
`loginctl enable-linger`, which `actana setup` prompts for and explains, and
which most distributions let a user enable for themselves.

### The one difference between the two platforms

On **Linux**, lingering makes the daemon survive logout, so a Core keeps running
on a machine nobody is logged into.

On **macOS**, it does not. A LaunchAgent is tied to your login session: it
starts when you log in and stops when you log out. Surviving logout would mean a
root-owned LaunchDaemon in `/Library/LaunchDaemons`, and this install is
sudo-less by design. `actana status` says which you have, on its `Linger` /
`At login` row. In practice: a Mac Core wants to stay logged in — enable
automatic login, or leave the session open.

---

## Install in one command

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
```

That detects the machine's OS and CPU, downloads the matching Harness tarball
from the latest GitHub Release, **checks it against the release's `SHA256SUMS`
before extracting or running anything**, and hands over to `actana setup` —
which installs, writes the auto-start unit, starts the daemon, and prints your
pairing token.

The checksum catches a corrupted or truncated download: it proves the tarball
is the one that release's own checksum file describes. Releases are not signed
(see [ADR 0003](docs/adr/0003-harness-install-and-registration.md) and the
release workflow), so it is not a proof of origin — use `https` URLs, which the
defaults do.

Piped like that, the run is non-interactive: nothing prompts, and every choice
comes from a flag. Flags the installer does not own are passed straight through
to `actana setup`:

```bash
curl -fsSL <install-script-url> | bash -s -- --version 0.49.0 --public-host core1.example.com --yes
```

| Flag | Meaning |
|---|---|
| `--version <v>` | Install this exact release instead of the latest |
| `--repo <slug>` | Install from another GitHub repository |
| `--base-url <url>` | Fetch releases from somewhere else — how the tests run hermetically |
| *anything else* | Passed to `actana setup` (see the table below) |

`ACTANA_VERSION`, `ACTANA_REPO` and `ACTANA_BASE_URL` set the same three
options, for provisioning systems where flags are awkward.

**Re-running the one-liner on a machine that already has a Harness upgrades it
in place** — same install, same pairing token, one unit. It is always safe to
paste again.

If anything fails — an unsupported platform, a release without a build for it,
a checksum that does not match — the installer stops before extracting or
running a single byte of the download, and says what to do about it.

The rest of this page is the same install done by hand, and how to operate a
Core afterwards.

---

## Prerequisites

- **Linux x86_64 or arm64** with systemd user units available — `systemctl --user`
  must work. WSL counts as Linux (with systemd enabled). Or **macOS on Apple
  silicon or Intel**, where `actana` uses launchd instead and needs nothing
  enabled first.
- **A reachable port.** The Panel dials the Harness, so the port you choose
  (default `8443`) must be open from the Panel's machine:
  ```bash
  sudo ufw allow 8443/tcp
  ```
- **Nothing else.** The bundle carries its own Node runtime and native
  modules. Whether the machine has a system Node, and which version, does not
  matter.

---

## Install by hand

Use this when you want to inspect the artifact first, install from a tarball
you already have, or work on a machine with no outbound network to GitHub.

### Step 1 — Download and verify the bundle

Pick the tarball matching the machine's platform and architecture from the
GitHub Release — `linux-x64`, `linux-arm64`, `mac-arm64`, or `mac-x64` — plus
the `SHA256SUMS` asset from the same release.

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

On macOS, where `sha256sum` is not installed:

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS
```

That must print `OK`. If it does not, stop — do not extract or run anything.

### Step 2 — Extract and run setup

```bash
tar -xzf actana-harness-0.49.0-linux-x64.tar.gz
```

```bash
./actana-harness-0.49.0-linux-x64/bin/actana setup
```

`setup` does all of it:

- copies the tree to `~/.local/share/actana/versions/<version>` and points
  `~/.local/share/actana/current` at it,
- links the launcher into `~/.local/bin/actana` (and tells you if that
  directory is not on your `PATH`),
- generates the mTLS material and persists it to `~/.config/actana/material.json`,
- writes the auto-start service — the systemd user unit
  `~/.config/systemd/user/actana-harness.service` on Linux, or the LaunchAgent
  `~/Library/LaunchAgents/com.actana.harness.plist` on macOS,
- on Linux, offers to enable lingering so the daemon survives logout,
- offers to install any agent CLI (Claude Code, Codex, Cursor CLI, OpenCode)
  that is not already on the machine, using each vendor's own installer,
- registers and starts the service, then waits for the port to answer,
- prints your **pairing token**.

Useful flags:

| Flag | Meaning |
|---|---|
| `--port <n>` | Port the daemon listens on (default `8443`) |
| `--host <addr>` | Address the daemon binds (default `0.0.0.0`) |
| `--public-host <addr>` | Address your Panel dials. Defaults to the machine's first routable IPv4 — set it explicitly if the machine is behind NAT or reached by DNS name. |
| `--label <name>` | Alias shown in your Panel (default: the hostname) |
| `--with-<agent>` | Install this agent CLI without asking. Repeatable; takes an id or its command — `--with-claude-code`, `--with-claude`, `--with-codex`, `--with-cursor-cli`, `--with-opencode` |
| `--no-agents` | Do not install or offer any agent CLI |
| `--yes` | Take the recommended answer to every prompt (for unattended installs). That includes installing every missing agent CLI. |

### Agent CLIs

Your Core runs agents, so it needs their CLIs. On a terminal, `setup` offers
each missing one in turn and installs the ones you accept with the vendor's
official method — so the agent's own updater and `login` flow work normally
afterwards.

With **no terminal** (the piped one-liner, cloud-init, Ansible) `setup` never
prompts and installs nothing unless you say so: use `--with-<agent>` for
specific ones, `--yes` for all of them, or `--no-agents` to be explicit that
you want none.

Declining is not permanent — install one later with:

```bash
actana agents install opencode
```

The id is the agent's name or its command (`claude-code` and `claude` both
work). A vendor installer that fails is reported with the vendor's own docs
URL and never fails your Harness install. After an install the Harness
re-probes immediately, so a paired Panel sees the new agent without a restart.

Re-running `setup` is safe: it upgrades in place, keeps your existing pairing
token, and leaves exactly one unit (or one LaunchAgent). It issues a new token only when
`--public-host` changed, because the old server certificate would no longer
verify — and it says so when it does.

### Step 3 — Pair the Core in your Panel

Copy the base64 pairing token `setup` printed, then in the Panel go to
**Settings → Cores → Add Core** and paste it. The Panel dials
`wss://<public-host>:<port>`, verifies the certificate, and the Core appears in
the Fleet view.

Lost the token? `actana token` reprints it. It puts only the token on stdout,
so piping it into a clipboard tool works.

---

## Operating a Core

```bash
actana status
```

```bash
actana token
```

```bash
actana logs -f
```

```bash
actana agents install <id>
```

`start`, `stop` and `restart` control the daemon without you learning systemd or
launchctl incantations; `logs` takes `-f` / `--follow` and `-n` / `--lines <n>`.
On Linux `logs` reads the journal; on macOS it tails
`~/Library/Logs/Actana/harness.log`, which is where the LaunchAgent sends both
of the daemon's streams.

`actana status` exits non-zero when the Harness is not healthy, so it works as
a health check in scripts.

### Updating

```bash
actana update
```

`update` asks the release channel for the newest version, downloads the tarball
for this machine, **verifies it against the release's published `SHA256SUMS`**,
installs it beside the running one, and repoints `current` at it before
restarting the daemon. A download that fails its checksum aborts before
anything is touched — the Harness keeps running the version it was on.

Pair a Panel that reports "needs update" with the exact version it wants:

```bash
actana update --version 0.50.0
```

Old versions stay in `~/.local/share/actana/versions`, so going back is a
second `--version` away rather than a re-download. Your pairing credentials and
your data are untouched by an update: a paired Panel stays paired.

### Reissuing the pairing token

```bash
actana token regenerate
```

This mints a fresh CA, certificates and bearer secret, then restarts the daemon
onto them — so **every token this Core printed before stops working**. That is
the one-command answer to a leaked pairing token; every Panel paired with this
Core shows it as unauthorized until you paste the new token into "Add Core".
Reprinting an unchanged token is `actana token`.

### Uninstalling

```bash
actana uninstall
```

Stops the daemon, removes the auto-start unit (or LaunchAgent), the `actana`
launcher, and the installed trees. Your sessions in
`~/.local/share/actana/data` and this Core's credentials in `~/.config/actana`
are **kept**, so reinstalling picks up where you left off with the same Panel
still paired.

```bash
actana uninstall --purge-data
```

Removes those too. This cannot be undone — the machine is left with no trace of
the Core, and reinstalling produces a new Core to pair from scratch.

Both forms ask for confirmation when run from a terminal; pass `--yes` in a
provisioning script.

---

## Troubleshooting

### `actana` is not found in a new shell

`setup` links the launcher into `~/.local/bin`, which some distributions leave
off `PATH`. Add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### The service started but nothing is listening

```bash
actana logs -n 200
```

The daemon logs its own startup failures there. A port already in use and an
unreachable `--public-host` are the two common causes.

### The daemon stops when I log out

**On macOS this is expected** — see the note at the top of this guide. A
LaunchAgent stops at logout and comes back at your next login. Keep the session
logged in (System Settings → Users & Groups → Automatic login) if the Core has
to stay reachable.

**On Linux** it means lingering is not enabled — `actana status` reports this on
its `Linger` row.

```bash
loginctl enable-linger "$(whoami)" && actana restart
```

If your distribution refuses that for a normal user, run it once with an
administrator:

```bash
sudo loginctl enable-linger "$(whoami)"
```

### The Core is unreachable from the Panel

Check each layer: is the daemon listening (`ss -tlnp | grep 8443` on Linux,
`lsof -iTCP:8443 -sTCP:LISTEN` on macOS), is the service active
(`actana status`), is the firewall open (`sudo ufw status`, or System Settings →
Network → Firewall), and can the Panel machine reach the port
(`nc -zv <public-host> 8443`)?

If the machine's address changed since setup, the certificate no longer covers
it. Re-run setup and re-pair with the new token it prints:

```bash
actana setup --public-host <new-address>
```

---

## File layout

| Path | Contents |
|------|----------|
| `~/.local/share/actana/versions/<version>/` | The installed bundle: `bin/actana`, `app/`, `node/`. |
| `~/.local/share/actana/current` | Symlink to the version the unit runs. |
| `~/.local/share/actana/data/missioncontrol.db` | SQLite: projects, tasks, sessions, event log. Never touched by setup. |
| `~/.config/actana/material.json` | CA, server cert/key, client cert/key, bearer secret, coreId. `chmod 0600`. |
| `~/.config/actana/actana.json` | What setup decided: version, port, host, public host, label. No secrets. |
| `~/.config/systemd/user/actana-harness.service` | Linux: the auto-start user unit. |
| `~/Library/LaunchAgents/com.actana.harness.plist` | macOS: the auto-start LaunchAgent. |
| `~/Library/Logs/Actana/harness.log` | macOS: the daemon's output — what `actana logs` tails. |
| `~/.local/bin/actana` | Symlink to `current/bin/actana`. |

The two service paths are fixed — systemd and launchd each read exactly one
directory. Everything else honours `XDG_DATA_HOME` and `XDG_CONFIG_HOME`
(macOS included, if you set them); `ACTANA_HOME`,
`ACTANA_CONFIG_DIR`, `ACTANA_DATA_DIR` and `ACTANA_BIN_DIR` override individual
slots.

---

## See also

- [ADR 0001 — Detach harness from panel](docs/adr/0001-detach-harness-from-panel.md)
- [ADR 0002 — Core-link auth and transport](docs/adr/0002-core-link-auth-and-transport.md)
- [ADR 0003 — Harness install and registration](docs/adr/0003-harness-install-and-registration.md)
- [macOS pre-release checklist](docs/harness-macos-prerelease-checklist.md) — the
  reboot and logout checks CI cannot run
