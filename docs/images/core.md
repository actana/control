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

## Quick start

The reference [`deploy/docker-compose.yml`](https://github.com/actana/control/blob/main/deploy/docker-compose.yml)
brings this image up beside a Panel on one network:

```bash
docker compose up -d
docker compose exec -u actana core actana pair new   # a code and a CA fingerprint
```

Then open the Panel and give **Add Core** the address `core:8443` and that code,
checking the fingerprint the Panel shows against the one `pair new` printed. The
Panel dials this container by its compose service name, so the Core publishes no port at all. A
second Core is the same service block again with a different name, host and
volume — nothing here is a singleton.

## Configuration

Three variables, and only the first is required.

| Variable | Default | What it does |
| --- | --- | --- |
| `ACTANA_PUBLIC_HOST` | — **required** | The host your Panel will dial, or a comma-separated list of the hosts this Core's clients dial. Every entry goes in the server certificate's SANs; the first is the primary, and it is the endpoint a pairing hands back unless that code chose another. |
| `ACTANA_PORT` | `8443` | The core-link port, and the port the image exposes. |
| `ACTANA_LABEL` | — | The name the Panel shows for this Core. |

The image never guesses the public host. A container's hostname is its container ID, so a guessing
default would silently change the certificate SAN every time you recreated the container, and every
paired Panel would stop trusting it.

One more variable exists, and it is not part of that contract: `ACTANA_UPDATE_CHECK=0` (or `false`,
or `off`) stops the daily release check behind the `actana status` availability line and the
daemon's once-a-day "a newer Actana is available" log line. The check reads
`https://api.github.com/repos/actana/control/releases/latest`, caches the answer for 24 hours, and
never updates anything — `docker compose pull && docker compose up -d` stays yours to run.

## State

Two volumes.

**`core-home`, at `/home/core`** — the home directory: your work and **each Harness's own
credentials** (`~/.claude`, `~/.codex`, `~/.config/opencode`, …). The mount is the whole home rather
than a narrower directory because Harnesses write all over `$HOME`: a narrower mount would log you
out of your coding CLIs on every `docker compose up`.

**`core-state`, at `/var/lib/actana`** (mode `0700`) — what only the daemon may hold: the identity
(CA, certificates, bearer secret, Core ID) in `config/material.json`, the pairings beside it, the
SQLite database and the update-check caches in `data/`, and, reserved for the Shared folder's key,
`shared/`. It is a volume of its own so that the home — the place Sessions work in — never holds
the Core's keys, and a copy of it carries none. It is owned by `actana` (1001:1001), the user the
daemon runs as, and **a Session, which runs as `core`, cannot read it**: not the identity, not the
database, not the pairings. That is why pairing is `docker compose exec -u actana core actana pair new`.

`docker compose down -v` destroys both and with them the pairing. Nothing else does — restarts,
upgrades and host changes keep it, and so does losing `core-home` alone: the Core is still the
same Core and every Harness has to be logged in again.

The one file a Session writes for the daemon is the hook miss log, `/run/actana/hook-misses.log`: a
hook that could not reach the Core appends a line there, and the daemon reads it back as untrusted
input (size-capped and tolerantly parsed). The file is mode 0622, so any Session can also truncate
it or overwrite another Session's lines; it is a diagnostic. It is outside the state directory on purpose.

### More than one address

One Core is often reachable two ways at once — as a compose service name inside the network, and as
a LAN address from outside it. Name both:

```yaml
- ACTANA_PUBLIC_HOST=core,192.168.1.20
```

One certificate covers both, and each client is paired to the one it can reach:

```bash
docker compose exec -u actana core actana pair new --label panel  --public-host core
docker compose exec -u actana core actana pair new --label laptop --public-host 192.168.1.20
```

`--public-host` picks from the configured list and can never add to it: an address that is not on
the list is refused, with the list printed. Omit it and the code hands back the first entry. A
single `ACTANA_PUBLIC_HOST` behaves exactly as it always has.

Editing `ACTANA_PUBLIC_HOST` re-signs the server certificate from the CA already in the volume. The
Core ID, the CA, the bearer secret and your Panel's client certificate are untouched either way, so a
Panel paired before the edit still trusts this Core. What differs is whether it can still reach it:

- **Adding an address** — every address this Core already answered to is still on the new
  certificate, and the new one has joined them. **Nothing is dialling an address the Core has left,
  so every paired client keeps working and none has to be re-paired.** Pair a client to the new
  address when you want one there: `actana pair new --public-host <the new address>`.
- **Replacing or removing an address** — a client paired to the address you took away is still
  dialling it, and that is the one thing re-signing cannot fix from here, because the client holds
  it. Point it at the new address, or pair it again:

  ```bash
  docker compose exec -u actana core actana pair new --label my-panel
  ```

Reordering the list is a replacement of sorts: the first entry is the endpoint a code hands back
when it names no address, so moving a different entry to the front changes where new pairings are
sent — though every address stays covered.

## Harness CLIs

Not baked in, on purpose. `claude-code`, `codex`, `cursor-cli` and `opencode` are about 1.15 GB
between them, they ship on their own cadences and are stale within days of any image build, and
they are four vendors' binaries under four licences.

Install them into the volume instead, where they persist across image upgrades and self-update in
place:

```bash
docker compose exec -u core core actana harnesses install claude-code
```

## What is inside

Ubuntu 24.04, pinned by digest, with `apt-get upgrade` in the same layer so a rebuild on that pinned
digest still collects Canonical's security fixes.

A real toolchain, because a Core exists to run coding agents against real repositories: `git`,
`curl`, `openssh-client`, `ripgrep`, `jq`, `lsof`, `vim-tiny`, and `build-essential` + `python3` so
that `npm install` on a project with a native addon can actually invoke node-gyp. The `core` user
(uid 1000, gid 1000) has **no sudo** — system packages are baked into the image, and an agent
cannot install more at run time.

Two users run in the container. **`actana`** (uid 1001, gid 1001, no login shell) is the daemon:
the entrypoint is the container's `ENTRYPOINT` and starts as root for one step only. It checks that
the bounding set is exactly `CAP_SETUID` and `CAP_SETGID` (what compose's `cap_drop: ALL` +
`cap_add: SETUID, SETGID` leaves; it refuses any other, because `setpriv` cannot narrow it without
`CAP_SETPCAP`) and that `/var/lib/actana` is `actana:actana` mode `0700` (it fails, and never
repairs, otherwise). It then `exec`s `setpriv` to `actana`, with `CAP_SETUID` and `CAP_SETGID` as
the only inheritable and ambient capabilities and `no-new-privs`, and that `exec`s **`tini`**, which
runs the daemon by absolute path (`/opt/actana/bin/actana daemon`). So `tini` is still PID 1, but
as `actana` with the same two capabilities: it can forward `SIGTERM` to the daemon, so `docker stop`
runs the daemon's shutdown (a root `tini` without `CAP_KILL` could not signal a uid-1001 process).
Those two capabilities are what let the daemon start every Session as **`core`**, with no
capabilities of its own. After the switch **no process of the container is root**. There is **no
setuid/setgid bit and no file capability** on any file in the image (stripped as the last root build
step, and scanned for by the smoke). What `actana` can do with `CAP_SETUID`: switch to any uid,
root included. That root has only those two capabilities, no DAC override, and under `no-new-privs`
cannot gain more; it owns what root owns in the container's writable layer, which is why the daemon
is not run as anything it does not need to be and why a Session (`core`) has neither capability.
`core` cannot become `actana` or root. The image `USER` is `0:0` for the entrypoint's step, and so a
plain `docker exec` is root — a root with no DAC override, which reads neither `/home/core` nor
`/var/lib/actana`. Use
`docker exec -u core` for a Session's view of the machine (a shell, `actana harnesses install`) and
`docker exec -u actana` for `actana pair`. Named volumes are seeded in the image: the home
`core:core`, the state `actana:actana`. A host
bind mount that Docker created as root is repaired by a separate root one-shot
(`core-init` in compose, or `docker run -u 0 --entrypoint
/usr/local/libexec/core-fs-prep.sh …`) that only chowns mount points — never
recursively, and never following a symlink. Compose gives that one-shot
`CHOWN` (to retarget ownership) and `DAC_OVERRIDE` (noble seeds `~/` as
`0750`, so without it uid 0 cannot search or `mkdir` under the home), keeps
`no-new-privileges` and `network_mode: none`, then exits; it also hands the state mount point to
`actana`. The main entrypoint refuses any uid but 0, because the switch to `actana` is the one thing
it does, and refuses a bounding set that is not exactly the two capabilities, so a bare `docker run`
needs `--cap-drop ALL --cap-add SETUID --cap-add SETGID`.

A system Node 24, taken from nodejs.org and SHA-256 verified against that release's own
`SHASUMS256.txt`, for `npm i -g` work. The daemon does not use it — it runs the Node bundled inside
its own release tarball.

`tini` is PID 1 and the daemon runs as its child. That is baked into the image rather than left to
`--init` / `init: true`, because a Core forks shells that fork agents, and a Node process running as
PID 1 does not reap the ones that get reparented to it.

### uid 1000, and bind-mounted repositories

The `core` user is pinned to uid 1000 and gid 1000 explicitly. If you bind-mount a repository from
your host and your login user is not uid 1000, files the Core writes will be owned by a uid that
does not exist on your host. Two supported answers: `chown -R 1000:1000` the directory, or use a
named volume and let the Core own the checkout. A missing host `./repos` that Docker creates as
root is fixed by `core-init` at the **mount point only** (contents are not walked).

Prep fails hard if `~/shared` is a symlink or a non-directory: `core` can make the next
`compose up` fail by replacing that path. That is intentional — the one-shot will not follow
or repair through a symlink.

Overriding `user:` on the main Core service is **not** supported — the entrypoint must start as root
to switch to `actana`, and refuses `user: "1000"` or `user: "1001"` with a message. Prep runs only in
the one-shot init service.

Without compose, run the prep one-shot once before the main container:

```bash
docker run --rm -u 0 --entrypoint /usr/local/libexec/core-fs-prep.sh \
  -v core-home:/home/core -v core-state:/var/lib/actana \
  -v "$PWD/repos:/home/core/repos" actana/core:latest
```

Under rootless Docker or Podman the engine maps container uid 1000 to a host subuid, so plain
`chown 1000` is the wrong advice there; use `podman unshare chown` or `--userns=keep-id`.

## Tags

| Tag | Moves |
| --- | --- |
| `latest` | on the release of the highest version — the default |
| `<version>`, e.g. `0.1.0` | never — pin deployments to this |
| `beta-<version>` | on every merge into that release's train — the next release, for testing |

`linux/amd64` and `linux/arm64`. Each architecture bakes in the Core release tarball built for *that*
architecture, so the two cannot be cross-built.

`<version>` is not a rebuild of `beta-<version>`: a release **re-points the same digest** a person
already pulled, ran and approved. The bytes under `beta-0.1.0` and the bytes under `0.1.0` are
identical, and the pipeline refuses to publish when they are not.

Pre-merge builds of open pull requests live in a separate repository,
[`actana/core-dev`](https://hub.docker.com/r/actana/core-dev), along with the `sha-<short>` commit
pins. Nothing there is released, and nothing here is a pre-merge build.

## Links

- [Source](https://github.com/actana/control) · [Installing on a machine you own](https://github.com/actana/control/blob/main/INSTALL.md) · [Security policy](https://github.com/actana/control/blob/main/SECURITY.md)

MIT licensed. A derivative work of Mission Control by AgentSystem Labs — see
[NOTICE](https://github.com/actana/control/blob/main/NOTICE).
