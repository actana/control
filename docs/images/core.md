# Actana Core

The **Core** is the machine half of [Actana Control](https://github.com/actana/control): the daemon
that owns your projects, your sessions, the SQLite database and the PTYs, running on a machine that
actually has your code on it. The **Panel** (`actana/panel`) is a connection broker over your fleet
of Cores and stores nothing task-shaped; every write happens here.

This image is a Core you run, not a machine you install one on. There is no versioned tree, no
service unit and no `actana setup`: the image tag is the version, the entrypoint is the unit, and
`docker compose pull && up -d` is the upgrade. Installing on a machine you own —
[INSTALL.md](https://github.com/actana/control/blob/main/INSTALL.md) — remains fully supported and
is unrelated to this image.

## Configuration

Three variables, and only the first is required.

| Variable | Default | What it does |
| --- | --- | --- |
| `ACTANA_PUBLIC_HOST` | — **required** | The host your Panel will dial. It is in the server certificate's SAN and in the registration blob. |
| `ACTANA_PORT` | `8443` | The core-link port, and the port the image exposes. |
| `ACTANA_LABEL` | — | The name the Panel shows for this Core. |

The image never guesses the public host. A container's hostname is its container ID, so a guessing
default would silently change the certificate SAN every time you recreated the container, and every
paired Panel would stop trusting it.

## State

One volume, mounted at `/home/core` — the whole home directory.

It holds the identity (CA, certificates, bearer secret, Core ID), the recorded configuration, the
SQLite database, **and each Harness's own credentials** (`~/.claude`, `~/.codex`,
`~/.config/opencode`, …). The mount is the home rather than a narrower state directory precisely
because Harnesses write all over `$HOME`: a narrower mount would log you out of your coding CLIs on
every `docker compose up`. One mount, one backup target.

`docker compose down -v` destroys the pairing. Nothing else does — restarts, upgrades and host
changes all keep it.

Changing `ACTANA_PUBLIC_HOST` re-signs the server certificate for the new address, from the CA
already in the volume. The Core ID, the CA, the bearer secret and your Panel's client certificate
are untouched, so a Panel paired before the change still trusts this Core — but it is still dialling
the old address, so point it at the new one. `registration-blob.txt` in the volume is rewritten with
a token for the new address if you would rather re-pair:

```bash
docker compose exec core cat /home/core/.config/actana/registration-blob.txt
```

## Harness CLIs

Not baked in, on purpose. `claude-code`, `codex`, `cursor-cli` and `opencode` are about 1.15 GB
between them, they ship on their own cadences and are stale within days of any image build, and
they are four vendors' binaries under four licences.

Install them into the volume instead, where they persist across image upgrades and self-update in
place:

```bash
docker compose exec core actana harnesses install claude-code
```

## What is inside

Ubuntu 24.04, pinned by digest, with `apt-get upgrade` in the same layer so a rebuild on that pinned
digest still collects Canonical's security fixes.

A real toolchain, because a Core exists to run coding agents against real repositories: `git`,
`curl`, `openssh-client`, `ripgrep`, `jq`, `lsof`, `vim-tiny`, and `build-essential` + `python3` so
that `npm install` on a project with a native addon can actually invoke node-gyp. The `core` user
(uid 1000, gid 1000) has passwordless `sudo` for the same reason.

A system Node 24, taken from nodejs.org and SHA-256 verified against that release's own
`SHASUMS256.txt`, for `npm i -g` work. The daemon does not use it — it runs the Node bundled inside
its own release tarball.

`tini` is PID 1 and the daemon is PID 2. That is baked into the image rather than left to
`--init` / `init: true`, because a Core forks shells that fork agents, and a Node process running as
PID 1 does not reap the ones that get reparented to it.

### uid 1000, and bind-mounted repositories

The `core` user is pinned to uid 1000 and gid 1000 explicitly. If you bind-mount a repository from
your host and your login user is not uid 1000, files the Core writes will be owned by a uid that
does not exist on your host. Two supported answers: `chown -R 1000:1000` the directory, or use a
named volume and let the Core own the checkout.

Overriding `user:` is **not** supported — it half-works, which is worse. `sudo` is granted by name,
and npm's prefix points into `/home/core`, so an overridden uid gets neither.

Under rootless Docker or Podman the engine maps container uid 1000 to a host subuid, so plain
`chown 1000` is the wrong advice there; use `podman unshare chown` or `--userns=keep-id`.

## Tags

| Tag | Moves |
| --- | --- |
| `latest` | every non-prerelease version tag |
| `<version>`, e.g. `0.1.0` | never |
| `edge` | every push to `main` |
| `sha-<short>` | never |

`linux/amd64` and `linux/arm64`. Each architecture bakes in the Core release tarball built for *that*
architecture, so the two cannot be cross-built.

## Links

- [Source](https://github.com/actana/control) · [Installing on a machine you own](https://github.com/actana/control/blob/main/INSTALL.md) · [Security policy](https://github.com/actana/control/blob/main/SECURITY.md)
- Also published as `ghcr.io/actana/core`

MIT licensed. A derivative work of Mission Control by AgentSystem Labs — see
[NOTICE](https://github.com/actana/control/blob/main/NOTICE).
