# Core Installation Guide

This guide covers turning a **Linux or macOS** machine into a **Core**:
installing the Core bundle, running `actana setup` — a separate command, because
installing is not activating — and pairing the machine with your Panel. The Core
is the stateful daemon that runs harnesses and owns the PTY layer; the Panel is
the web app you drive it from.

**There is one `actana`.** The command that installs and operates a Core is the
same command that drives Cores — `actana core ls`, `actana session start` and
the rest — whether it arrived in the Core tarball or from
`npm i -g @actana/cli`. Two programs used to share this name and which one
answered depended on `PATH` order; see
[ADR 0032](docs/adr/0032-one-actana-cli.md). Two practical consequences on this
page: a machine that already has the CLI can install a Core with `actana
install`, and a Core installed on a machine is registered with that machine's
own `actana` — so `actana core ls` lists it with nothing pasted anywhere.

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

Two commands, and the first one prints the second:

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
actana setup
```

**Installing is not activating.** `install.sh` puts the Core bundle and the
`actana` CLI on this machine and stops. `actana setup` is what turns the machine
into a Core: it generates the mTLS material, writes the auto-start service,
offers to enable lingering, offers the harness CLIs, starts the daemon, and
registers the Core with this machine's own `actana`. They are two different acts
with two different audiences, and there is no flag that fuses them back into
one.

The installer prints the exact `actana setup` line to run — **run the line it
printed**. On a machine where `~/.local/bin` was not yet on your `PATH` when the
shell started, that line is an absolute path rather than a bare `actana`, and it
is the one that will actually be found.

**Or, if you already have the CLI**, `actana install` does both halves in one
go — it is the CLI's own front door, not the shell script's:

```bash
npm i -g @actana/cli
actana install
```

**A beta has an equivalent, and it is not a registry version** — the CLI is
attached to the beta prerelease as a packed tarball and installed from its asset
URL. See [The CLI on its own](#the-cli-on-its-own).

`install.sh` stays the door for a machine with no Node — the tarball carries its
own pinned runtime, so the script cannot be replaced by the CLI it installs.
Both fetch the same way: resolve the release, download it, check it against the
release's `SHA256SUMS`, extract it. A failed check leaves nothing installed
either way.

The one-liner detects the machine's OS and CPU, downloads the matching Core
tarball from the latest GitHub Release, **checks it against the release's
`SHA256SUMS` before extracting or running anything**, copies the bundle to
`~/.local/share/actana/versions/<version>`, points `~/.local/share/actana/current`
at it, and links `~/.local/bin/actana` — unless something else already answers
to `actana`, in which case it leaves that one alone and says so.

The checksum catches a corrupted or truncated download: it proves the tarball
is the one that release's own checksum file describes. Releases are not signed
(see [ADR 0003](docs/adr/0003-core-install-and-registration.md) and the
release workflow), so it is not a proof of origin — use `https` URLs, which the
defaults do.

Piped like that, the run is non-interactive — it asks nothing, because it
decides nothing. The four options it takes are its own:

```bash
curl -fsSL <install-script-url> | bash -s -- --version 0.1.0
actana setup
```

| Flag | Meaning |
|---|---|
| `--version <v>` | Install this exact version instead of the latest release. Takes a release (`0.4.0`) or a beta (`0.4.1-beta`) |
| `--repo <slug>` | Install from another GitHub repository |
| `--base-url <url>` | Fetch releases from somewhere else — how the tests run hermetically |
| `--help` | Show what the script does, the options it owns, and which line this copy installs from |

**Anything else is refused, not ignored.** `--yes`, `--port`, `--public-host`,
`--label`, `--with-<harness>` and `--no-harnesses` are `actana setup`'s options
and belong on the second command — an installer that accepted `--public-host`
and then did nothing with it would silently drop the one setting that decides
whether your Panel can reach this machine.

```bash
curl -fsSL <install-script-url> | bash
~/.local/bin/actana setup --public-host core1.example.com --yes
```

`ACTANA_VERSION`, `ACTANA_REPO` and `ACTANA_BASE_URL` set the same three
installer options, for provisioning systems where flags are awkward.
`ACTANA_HOME`, `ACTANA_BIN_DIR`, `ACTANA_CONFIG_DIR`, `ACTANA_DATA_DIR` and the
XDG variables move where things land; the script does not read them itself — the
CLI does — so the installer and `actana setup` cannot disagree about where
anything is.

**Re-running both commands on a machine that already has a Core upgrades it
in place** — same install, same identity, one unit, and every paired client
stays paired. It is always safe to paste again.

If anything fails — an unsupported platform, a release without a build for it,
a checksum that does not match — the installer stops before extracting or
running a single byte of the download, and says what to do about it. A failed
run leaves the machine as it found it: nothing under the install root, no
launcher, no half-placed tree.

**To install a beta instead of a release**, fetch the script from the train's
own ref rather than from `main`. It is the same two commands — see [Installing a
beta](#installing-a-beta).

The rest of this page is the same install done by hand, and how to operate a
Core afterwards.

---

## Prerequisites

- **Linux x86_64 or arm64** with systemd user units available — `systemctl --user`
  must work. WSL counts as Linux (with systemd enabled).
- **or macOS on Apple silicon** (M-series), where the auto-start unit is a
  LaunchAgent and no systemd is involved. See
  [macOS, on the machine itself](#macos-on-the-machine-itself) below for what
  differs.
- A release publishes those three builds and nothing else. **An Intel Mac has
  no on-device build** and will not get one: run its Core from the container
  image instead — the installer says so if you try. On Windows, run the Panel
  and host your Cores on a Linux machine.
- **A reachable port.** The Panel dials the Core, so the port you choose
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

Pick the tarball matching the machine's architecture from the GitHub Release —
`linux-x64`, `linux-arm64` or `mac-arm64` — plus the `SHA256SUMS` asset from
the same release. Those four files are the whole release.

A beta prerelease carries the same four plus a copy of `install.sh`, and **will
carry the CLI tarball once
[#320](https://github.com/actana/control/issues/320)'s attach step lands — a
cut made today does not attach it, so do not go looking for it on the Release
page**. The version in every asset name is `x.y.z-beta`. Verify it exactly as
below — `SHA256SUMS` covers the three Core tarballs there too.

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

On macOS, where `sha256sum` is not installed:

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS
```

That must print `OK`. If it does not, stop — do not extract or run anything.

### Step 2 — Extract, place the bundle, and run setup

```bash
tar -xzf actana-core-0.1.0-linux-x64.tar.gz
```

```bash
./actana-core-0.1.0-linux-x64/bin/actana place
```

```bash
actana setup
```

**These are the same two commands the one-liner runs** — the only difference is
who downloaded the tarball. `place` copies the extracted tree into the install
layout and links the launcher; `setup` activates the machine. Run the
`actana setup` line `place` printed, for the same reason as above: on a machine
where `~/.local/bin` is not on your `PATH` it is an absolute path.

`place` does the install half:

- copies the tree to `~/.local/share/actana/versions/<version>` and points
  `~/.local/share/actana/current` at it,
- links the launcher into `~/.local/bin/actana` — **unless something else
  already answers to `actana` there or earlier on your `PATH`**, in which case
  it leaves that one alone and says so. Whoever installed a CLI owns its path;
  since there is one `actana` program, the one already there runs this Core's
  verbs too,
- prints the `actana setup` command to run next, and stops. Nothing is running
  and nothing is configured until you run it.

You can skip `place` and run `setup` straight out of the extracted directory —
`setup` places the tree it is standing in before it activates anything, which
is what it has always done. `place` exists so that installing and activating
can be two separate decisions.

`setup` does the rest:

- generates the mTLS material and persists it to `~/.config/actana/material.json`,
- writes the auto-start service — the systemd user unit
  `~/.config/systemd/user/actana-core.service` on Linux, or the LaunchAgent
  `~/Library/LaunchAgents/com.actana.core.plist` on macOS,
- on Linux, offers to enable lingering so the daemon survives logout,
- offers to install any harness CLI (Claude Code, Codex, Cursor CLI, OpenCode)
  that is not already on the machine, using each vendor's own installer,
- registers and starts the service, then waits for the port to answer,
- registers this Core with **this machine's own** `actana`, so `actana core ls`
  lists it and it is what `actana session start` means here by default,
- tells you to run `actana pair new` when you want to enroll a client — a
  Panel, or another machine you want to drive this Core from.

`setup` prints no credential of any kind. A client is enrolled one at a time,
by a one-time code, and the private key it ends up holding is generated on that
client and never crosses the wire.

Useful flags:

| Flag | Meaning |
|---|---|
| `--port <n>` | Port the daemon listens on (default `8443`) |
| `--host <addr>` | Address the daemon binds (default `0.0.0.0`) |
| `--public-host <addr>` | Address your Panel dials. Defaults to the machine's first routable IPv4 — set it explicitly if the machine is behind NAT or reached by DNS name. |
| `--label <name>` | Alias shown in your Panel (default: the hostname) |
| `--with-<harness>` | Install this harness CLI without asking. Repeatable; takes an id or its command — `--with-claude-code`, `--with-claude`, `--with-codex`, `--with-cursor-cli`, `--with-opencode` |
| `--no-harnesses` | Do not install or offer any harness CLI |
| `--yes` | Take the recommended answer to every prompt (for unattended installs). That includes installing every missing harness CLI. |

### Harness CLIs

Your Core runs harnesses, so it needs their CLIs. On a terminal, `setup` offers
each missing one in turn and installs the ones you accept with the vendor's
official method — so the harness's own updater and `login` flow work normally
afterwards.

With **no terminal** (the piped one-liner, cloud-init, Ansible) `setup` never
prompts and installs nothing unless you say so: use `--with-<harness>` for
specific ones, `--yes` for all of them, or `--no-harnesses` to be explicit that
you want none.

Declining is not permanent — install one later with:

```bash
actana harnesses install opencode
```

The id is the harness's name or its command (`claude-code` and `claude` both
work). A vendor installer that fails is reported with the vendor's own docs
URL and never fails your Core install. After an install the Core
re-probes immediately, so a paired Panel sees the new harness without a restart.

Re-running `setup` is safe: it upgrades in place, keeps this Core's identity, and
leaves exactly one unit (or one LaunchAgent). Paired clients stay paired. It
re-signs the server certificate only when `--public-host` changed, because the
old one would no longer verify for the new address — and it says so when it does.

### Step 3 — Pair the Core in your Panel

On the Core:

```bash
actana pair new --label my-panel
```

That prints three things: a one-time **pairing code** as `XXXX-XXXX`, this
Core's **CA fingerprint**, and when the code expires (five minutes by default,
`--ttl` moves it). Then in the Panel go to **Settings → Cores → Add Core**,
give it `<public-host>:<port>`, and check the fingerprint the Panel shows you
against the one on the Core's terminal *before* you enter the code. The Panel
generates its own key, has the Core sign it, and the Core appears in the Fleet
view.

The code is single-use, expires, and dies after five wrong guesses. There is no
way to look one up — `actana pair ls` stores a digest, not the code — so a lost
code is re-minted with another `actana pair new`.

From another machine's `actana`, the client end of the same exchange is:

```bash
actana core pair prod <public-host>:<port> XXXX-XXXX \
  --session <id> --fingerprint <sha256>
```

---

## macOS, on the machine itself

A Mac with Apple silicon is a Core like any other: the same two commands at the
top of this page install it, both run without sudo, and the machine pairs with
your Panel the same way. What differs is the auto-start mechanism, and one
property that follows from it.

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
actana setup
```

The first command maps the machine to the `mac-arm64` release asset, places the
bundle and links the launcher — and stops. Nothing is running yet. Run the
`actana setup` line it printed; that is what writes the **LaunchAgent** at
`~/Library/LaunchAgents/com.actana.core.plist`, labelled `com.actana.core`, and
loads it. On a Mac that has never had `~/.local/bin` on its `PATH`, the printed
line is an absolute path rather than a bare `actana` — run it as printed.

**An Intel Mac stops here, deliberately.** There is no `mac-x64` build and
there will not be one; the installer refuses at detection — before it downloads
anything — and points you at the container image, which is the supported way to
run a Core on that machine.

### The LaunchAgent is tied to your login session

This is the one thing to understand before you rely on a Mac Core:

- It starts **when you log in**, not when the machine boots.
- It stops **when you log out**. Locking the screen is fine; logging out is not.
- **There is no `loginctl enable-linger` equivalent.** That is not a gap in the
  CLI — surviving logout on macOS means a root-owned LaunchDaemon in
  `/Library/LaunchDaemons`, and this install is sudo-less by design. `setup`
  offers you no such prompt on macOS because there is no such choice to offer.

So a Mac Core wants to stay logged in. Enable automatic login (System Settings
→ Users & Groups → Automatic login) if the Core has to be reachable after a
reboot, and keep the session open. `actana status` states which of the two
regimes you are on, on its `Linger` / `At login` row — on macOS it reads
`At login`.

### `status` and `logs` on macOS

```bash
actana status
```

Reports `Core: healthy`, the LaunchAgent as `com.actana.core`, and the
`At login` row above. It exits non-zero when the Core is not healthy, on macOS
as on Linux, so it works as a health check in scripts.

```bash
actana logs -f
```

There is no journal to read, so `logs` tails
`~/Library/Logs/Actana/core.log` — where the LaunchAgent sends both of the
daemon's streams. `-n` / `--lines <n>` and `-f` / `--follow` work as they do on
Linux. `start`, `stop` and `restart` drive `launchctl` for you.

That log directory is the one thing `actana uninstall --purge-data` leaves
behind. Remove it by hand if you want the machine spotless:

```bash
rm -rf ~/Library/Logs/Actana
```

### Gatekeeper, and downloading the tarball in a browser

Releases are **not code-signed or notarized**. That is fine for the paths above:
`curl` and `wget` do not set the `com.apple.quarantine` attribute, so the
one-liner — and a by-hand `curl` of the tarball — installs without Gatekeeper
intervening.

A browser *does* set it. If you downloaded the tarball in Safari or Chrome and
macOS refuses to run the launcher or the bundled `node`, clear the attribute
from the extracted tree and try again:

```bash
xattr -dr com.apple.quarantine ./actana-core-0.1.0-mac-arm64
```

### The firewall prompt

The first time the daemon binds its port, macOS may ask whether to allow
incoming connections. Allow it, or the Panel cannot dial the Core. It is under
System Settings → Network → Firewall → Options if you dismissed it.

---

## Installing a beta

A beta train installs on metal exactly the way a release does — same two
commands, same checksum verification, same layout — and the model is [ADR
0036](docs/adr/0036-the-beta-release-channel.md). The only thing that changes is
which URL you fetch the script from.

**The ref you fetch from is the channel.** A script read off a pipe cannot see
the URL it came from, so what it installs is decided by the copy of the file on
that ref rather than by a flag. There is no `--channel` option and no
environment variable that selects one — which copy you fetched is the whole of
the choice:

| Want | Fetch `install.sh` from | Installs |
| --- | --- | --- |
| the latest release | `raw.githubusercontent.com/actana/control/main/install.sh` | the release of the line `main` carries — in steady state, the newest release |
| a specific release | `raw.githubusercontent.com/actana/control/v0.4.0/install.sh` | that line's release. A release tag never moves, so this is a pin |
| the current beta of a line | `raw.githubusercontent.com/actana/control/beta/0.4.1/install.sh` | that line's current beta — **or the newest release, if nobody has cut one yet** |
| the same beta, by tag | `raw.githubusercontent.com/actana/control/v0.4.1-beta/install.sh` | the same thing as the row above — an alias, **not** a pin |

`install.sh --help` names the line the copy you fetched carries and the rule it
resolves by, so if you are unsure which door you have, ask it.

**A train with no cut yet falls through to the newest release, quietly.** A beta
cut is dispatched by a person and never happens on a merge, so *no cut yet* is
the ordinary state of a young train, not an edge case. The script asks for that
line's release, then for that line's beta, and if neither exists it installs the
newest release — a correct answer to *"the line you asked about has published
nothing"*, but not the beta you went to that URL for. **The script tells you
which it is before it downloads anything**: its first line is `Installing the
Actana Core <version> for <target>.`, and a bare `x.y.z` there where you expected
`x.y.z-beta` is the fall-through. Nothing is wrong with the machine; that line
has not been cut.

So installing the open train is the two commands you already know, from the
train's own ref:

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/beta/0.4.1/install.sh | bash
actana setup
```

`install.sh` places the bundle and the `actana` launcher and stops, exactly as
it does for a release, and prints the `actana setup` line to run next. **Run the
line it printed** — on a machine where `~/.local/bin` is not on your `PATH` it
is an absolute path rather than a bare `actana`. Nothing about a beta activates
anything on its own.

**A beta lands beside the release of its line, not on top of it.** The bundle
goes to `~/.local/share/actana/versions/0.4.1-beta` and `current` points at it;
`versions/0.4.1` is a different directory and is untouched. The machine reports
`0.4.1-beta` and cannot report `0.4.1` — the tarball carries its own version in
its name, its archive root and its manifest, and the CLI installs into whatever
the manifest says.

**A beta version is `x.y.z-beta`, exactly.** The beta of the 0.4.1 line is
`0.4.1-beta`, and it stays that string however many times that line is cut.
There is no counter, no dotted suffix, no run number and no short sha after
the word `beta`, on the git tag, the Release, the tarball names, the image tags
or anywhere else. Anything with something appended after `beta` is not a version
this project publishes, and `--version` will not find it.

**That train branch stops existing when the line promotes.** It is deleted by
the promotion rather than left to quietly change meaning, so a URL that worked
yesterday and 404s today is the line having shipped — install the release from
`main`.

### The only way to pin a beta is `--version`

The two beta rows in the table above are **not pins, and cannot be**. The
`vx.y.z-beta` tag moves to a new commit on every cut, and the file at that ref
carries the *line* rather than the beta, so once the line has a release both
rows install the release. That is the design, not a wrinkle in it.

The pinned form is the explicit version flag, which wins over everything and is
unaffected by any of the above:

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash -s -- --version 0.4.1-beta
actana setup
```

`ACTANA_VERSION=0.4.1-beta` does the same thing for a provisioning system where
flags are awkward. A beta's own immutable record is what it has always been —
the commit sha, the image digest and the published `SHA256SUMS`.

### `actana update` will not move a beta machine off its line

A bare `actana update` on a machine running `0.4.1-beta` **does not** replace
the tree, and this is worth knowing before you install one. `update` resolves
the newest *release*, and a machine on a prerelease that is newer than every
release is left where it is and told so rather than being quietly moved
backwards onto an older version.

What does happen is the notice: when `0.4.1` — the release of the line this
machine is on — is published, `actana status` says so, once, on its usual
throttle. That is the moment to move, and the ordinary `actana update` is what
moves you.

Two consequences worth stating plainly:

- **`actana update` is not a way to follow a beta line.** There is no "update me
  to the newest beta of my train". To take a newer cut of the same beta, run the
  install one-liner again from the train's ref — re-running is always safe, and
  every paired client stays paired.
- **An explicit pin is still honoured.** `actana update --version 0.4.0` on a
  beta machine does exactly what you asked, including going backwards. An
  operator's explicit decision is not second-guessed.

### The CLI on its own

A machine that only *drives* Cores — no daemon, no Core on the box — installs
the CLI from npm, and a beta has an equivalent. It is **not** a registry
version: nothing is published to registry.npmjs.org by a beta cut, and `latest`
and `next` on `@actana/cli` are untouched by one. The CLI is packed and attached
to the beta prerelease, and npm installs a tarball URL exactly as it installs a
registry spec:

```bash
npm i -g https://github.com/actana/control/releases/download/v0.4.1-beta/actana-cli-0.4.1-beta.tgz
```

> **Not yet, on a real cut.** The pack and the name are shipped and asserted, and
> the beta cut does not attach the tarball to its prerelease yet
> ([#320](https://github.com/actana/control/issues/320)). Until it does, that URL
> is a 404 on any beta you cut today. The form is the one it will take.

Compare that with the release path, which is the ordinary one:

```bash
npm i -g @actana/cli
```

The reason for the asymmetry is npm's, not this project's: a version number is
burned by its first publish and cannot be reused, and a beta string is fixed for
the life of its line and is designed to be cut repeatedly. A registry publish
would work once per train and fail every time after it.

### What a beta ships, and what it does not

A beta cut is requested by a person — it never happens on a merge — and it
publishes a prerelease GitHub Release on the `vx.y.z-beta` tag, never marked
latest, with every asset replaced in place on each cut:

- the same **three Core tarballs** a release builds — `linux-x64`,
  `linux-arm64`, `mac-arm64` — at version `x.y.z-beta`,
- **`SHA256SUMS`** over exactly those three,
- a copy of **`install.sh`**, so the script and the bytes it fetches ship
  together. It is a copy and not a door: the install URLs are the ones in the
  table above,
- the **CLI tarball** described above — **not attached by a cut yet
  ([#320](https://github.com/actana/control/issues/320))**,
- **`x.y.z-beta` container images** in `actana/panel` and `actana/core`,
  retagged from the train's own `beta-x.y.z` digest with nothing rebuilt —
  **not published by a cut yet
  ([#319](https://github.com/actana/control/issues/319)); pull `beta-x.y.z` for
  a container until it lands**.

And what it does not:

- **No Intel Mac build.** There is no `mac-x64` asset on a beta for the same
  reason there is none on a release — there is no such target, and an Intel Mac
  runs its Core from the container image.
- **No signing and no notarization**, exactly as a release. Integrity is the
  published checksums, which `install.sh` verifies before it extracts anything.
- **No provenance attestation of any kind.** A release's npm packages carry one;
  a beta publishes nothing to the registry, so there is nothing attested on this
  path. `SHA256SUMS` is what stands in its place, and nothing here should be
  read as more than that.

---

## Operating a Core

```bash
actana status
```

```bash
actana pair new      # enroll a client — prints a code, a fingerprint, an expiry
actana pair ls       # pending codes, and the clients already paired
actana pair revoke <target>   # unpair a client, or cancel a pending code
```

```bash
actana logs -f
```

```bash
actana harnesses install <id>
```

`start`, `stop` and `restart` control the daemon without you learning systemd or
launchctl incantations; `logs` takes `-f` / `--follow` and `-n` / `--lines <n>`.
On Linux `logs` reads the journal; on macOS it tails
`~/Library/Logs/Actana/core.log`, which is where the LaunchAgent sends both
of the daemon's streams.

`actana status` exits non-zero when the Core is not healthy, so it works as
a health check in scripts.

### Updating

```bash
actana update
```

`update` asks the release channel for the newest **release**, downloads the
tarball for this machine, **verifies it against the release's published
`SHA256SUMS`**, installs it beside the running one, and repoints `current` at it
before restarting the daemon. A download that fails its checksum aborts before
anything is touched — the Core keeps running the version it was on.

A machine running a beta is left alone by a bare `update` rather than moved back
onto an older release, and is told when its own line's release arrives — see
[`actana update` will not move a beta machine off its
line](#actana-update-will-not-move-a-beta-machine-off-its-line).

Pair a Panel that reports "needs update" with the exact version it wants:

```bash
actana update --version 0.2.0
```

Old versions stay in `~/.local/share/actana/versions`, so going back is a
second `--version` away rather than a re-download. Your pairing credentials and
your data are untouched by an update: a paired Panel stays paired.

#### Knowing there is one

You do not have to go looking. Once a day this Core asks
`https://api.github.com/repos/actana/control/releases/latest` whether a newer
release exists; if there is one, `actana status` gains an availability line
naming it and the command above, and the daemon writes the same fact to its log
once. That endpoint excludes prereleases, so a beta never shows up here as
something to move to — but the release of a beta machine's own line does, which
is exactly the notice an operator running a beta needs. Nothing else happens —
there is no updater running in the background, and nothing is downloaded until
you type `actana update` yourself.

The answer is cached for 24 hours under your data directory, so asking `status`
a hundred times costs one request. If the check fails — no network, the request
times out, or the release channel has published nothing yet — `status` prints
exactly what it printed before the check existed, and its exit code is
unchanged. A Core one release behind is not an unhealthy Core.

Set `ACTANA_UPDATE_CHECK=0` (or `false`, or `off`) to turn it off entirely.

### Rotating this Core's identity

```bash
actana token regenerate
```

This mints a fresh CA, certificates and bearer secret, then restarts the daemon
onto them — so **every credential this Core ever issued stops working**. That is
the one-command answer to a compromised Core: every client paired with it shows
as unauthorized until you pair it again with a fresh `actana pair new`.

**Remove the Core from a Panel before pairing it again.** Rotation does not move
the endpoint, so the Panel's registry row is still there, and pairing refuses at
an address that is already registered — before it spends your code, so you have
to mint another. `actana core pair` needs no such step: it replaces the stored
credential in place.

`token regenerate` hands nothing out and there is nothing to reprint.

To take back one client without touching the rest, use `actana pair revoke`.

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

The install links the launcher into `~/.local/bin`, which some distributions
leave off `PATH` — and which a shell that started before the install will not
have picked up in any case. Add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

This is why the installer prints an absolute path rather than a bare `actana`
when it can see that `~/.local/bin` is not on your `PATH`. Running the line it
printed always works, `PATH` or no `PATH`.

### The install finished and nothing is running

That is the install working. `install.sh` places the bundle and stops;
`actana setup` is the command that makes this machine a Core. Run the line the
installer printed — `actana status` before that says there is no Core
installed for this user, which is true until setup has run.

### It said it left the launcher alone

Something else already answers to `actana` — usually `npm i -g @actana/cli`,
whose global shim lands in the same directory. Nothing is broken: it is the same
program, so it runs this Core's `status`, `logs` and `update` as well. The
message names where this install's own launcher is if you would rather run that
one directly, and the `actana setup` command it prints goes through that
launcher rather than through the other program. To hand the path over, remove
the other install (`npm rm -g @actana/cli`) and re-run the install.

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
| `~/.config/actana/actana.json` | What setup decided: version, port, host, public host, label. No secrets. Absent until setup runs. |
| `~/.config/systemd/user/actana-core.service` | Linux: the auto-start user unit. |
| `~/Library/LaunchAgents/com.actana.core.plist` | macOS: the auto-start LaunchAgent. |
| `~/Library/Logs/Actana/core.log` | macOS: the daemon's output — what `actana logs` tails. |
| `~/.local/bin/actana` | Symlink to `current/bin/actana`, written by the install unless somebody else owns the name. |

The two service paths are fixed — systemd and launchd each read exactly one
directory. Everything else honours `XDG_DATA_HOME` and `XDG_CONFIG_HOME`
(macOS included, if you set them); `ACTANA_HOME`,
`ACTANA_CONFIG_DIR`, `ACTANA_DATA_DIR` and `ACTANA_BIN_DIR` override individual
slots.

---

## See also

- [ADR 0001 — Detach core from panel](docs/adr/0001-detach-core-from-panel.md)
- [ADR 0002 — Core-link auth and transport](docs/adr/0002-core-link-auth-and-transport.md)
- [ADR 0003 — Core install and registration](docs/adr/0003-core-install-and-registration.md)
- [macOS release checklist](docs/core-macos-prerelease-checklist.md) — the
  reboot, logout and Gatekeeper checks a person runs on real hardware before
  any release carrying a `mac-arm64` tarball can publish
