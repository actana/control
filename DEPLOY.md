# Panel Deployment Guide

This guide covers running the **Panel** — the self-hosted web service you
drive your Cores from. Its counterpart is [INSTALL.md](INSTALL.md), which
turns each work machine into a Core.

The Panel is one service with one rule: **plain HTTP out, all state in one
directory.** TLS belongs to a reverse proxy in front (the Panel never grows
certificate code — [ADR 0010](docs/adr/0010-panel-becomes-a-self-hosted-web-service.md)),
and everything the Panel must survive a restart with — the Operator, the Core
registry, sealed credentials, the secrets key — lives in a single data
directory. Back that directory up and you have backed up the Panel.

It ships two equivalent ways:

- a **Docker image**, [`actana/panel`](https://hub.docker.com/r/actana/panel)
  on Docker Hub — built by CI on every release
- the same build as a **plain Node process**, for machines where containers
  are unavailable or unwanted

## The reference compose — a Panel and a Core

The copy-paste path. [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
brings up a Panel and a Core on one network, from published images, in one
command. Prerequisite: a machine with Docker.

```bash
git clone https://github.com/actana/control
cd control/deploy
docker compose up -d
docker compose exec -u actana core actana pair new     # a one-time code and a fingerprint
```

Open `http://localhost:7420`: the first boot asks you to create the Operator
(name + password), and after logging in you give **Add Core** the address
`core:8443` and that code, checking the fingerprint the Panel shows against the
one `pair new` printed. The `-u actana` matters: the Core container has two users, `actana` (the daemon, uid 1001,
state in `/var/lib/actana`) and `core` (Sessions, uid 1000, home `/home/core`), and pairing belongs to the daemon's.
`pair` and `status` refuse any other user and print this command; a plain `docker compose exec` is root and has no access to
either directory. Use `-u core` for a shell as a Session would have it. See
[`deploy/README.md`](deploy/README.md#two-users-in-the-core).
The Panel dials `wss://core:8443` over the compose network — which is why the
Core's `ACTANA_PUBLIC_HOST` is the compose service name and not a DNS name,
and why the Core publishes no port to your machine at all.

Only `deploy/docker-compose.yml` matters — copying that one file to a bare VM
works just as well as cloning, plus `mkdir repos` beside it for the bind mount
the Core service names. (Swap that mount for a named volume and even the
directory goes away; the file says how.) A second Core is the same service
block again with a different name, host and volume; the file carries the block
to paste.

### TLS

There is no terminator in that file and none is coming. The Panel speaks plain
HTTP by design ([ADR 0010](docs/adr/0010-panel-becomes-a-self-hosted-web-service.md))
and the compose publishes port 7420 on loopback, so `localhost` — a secure
context without TLS — works as it stands, and anything reaching the Panel from
another machine should arrive through a proxy you run.

Point your Traefik / Nginx / Caddy at port 7420. Two requirements: forward
WebSocket upgrades (the panel link), and set `X-Forwarded-Proto: https` —
without it the Panel issues a cookie the browser will happily send over plain
HTTP.

None of this touches the core-link, which is mutually authenticated TLS with
material the Core mints itself ([ADR 0002](docs/adr/0002-core-link-auth-and-transport.md)).
It is not something you supply, renew, or put a proxy in front of.

## Localhost — no proxy needed

`localhost` is a secure context without TLS, so a personal single-machine
setup needs no proxy. The Panel needs a Postgres to start (see
[Configuration](#configuration)); the reference
[`deploy/docker-compose.yml`](deploy/docker-compose.yml) brings one, and is the
way to run it. With a Postgres of your own:

```bash
docker run -d --name actana-panel \
  -p 127.0.0.1:7420:7420 \
  -v actana-panel-data:/data \
  -e AC_PANEL_DATABASE_URL=postgres://user:password@host:5432/dbname \
  actana/panel:latest
```

Open `http://localhost:7420`. Binding `127.0.0.1` keeps the plain-HTTP port
off the network; anything reaching the Panel from another machine should come
through a TLS proxy instead.

### If you bind-mount the data directory instead of using a volume

The container runs as uid **65532** (the distroless `nonroot` account), so a
host directory mounted at `/data` has to be writable by it — `sudo chown -R
65532:65532 <dir>` before the first start. A *named* volume, as above, needs
none of this: Docker seeds a fresh volume with the ownership the image
carries, which is already 65532. Under rootless Docker or Podman the engine
maps container uids to host subuids, so use `podman unshare chown` or
`--userns=keep-id` rather than a plain `chown`.

There is also no shell in the image — it is distroless, which is what takes it
from 192 known CVEs to 14. `docker exec actana-panel sh` will not work; reach
for `docker exec actana-panel /nodejs/bin/node -e '…'`, `docker cp`, or a
debugging sidecar sharing the container's namespaces.

## The bare `node` path

The image's entry is an ordinary Node program, so the same build runs
anywhere Node 24 does:

```bash
pnpm install
pnpm build                                # builds the Core bundle + the Panel
AC_PANEL_DATA_DIR=/var/lib/actana-panel \
AC_PANEL_DATABASE_URL=postgres://user:password@localhost:5432/dbname pnpm start
```

`pnpm start` runs `packages/panel/bin/panel.mjs` — the exact file the
container starts. Supervise it with whatever you already use (systemd,
runit, a terminal); it logs to stdout/stderr and shuts down cleanly on
SIGTERM. The same reverse-proxy rules as above apply for non-localhost
access.

## Configuration

Everything is environment variables; there is no config file.

| Env | Default | Meaning |
| --- | --- | --- |
| `AC_PANEL_PORT` / `PORT` | `7420` | Port to listen on |
| `AC_PANEL_HOST` / `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` keeps a shared machine's loopback) |
| `AC_PANEL_DATA_DIR` | `/data` in the image; platform data dir otherwise | The one directory all Panel state lives in |
| `AC_PANEL_DATABASE_URL` | **required** | `postgres://user:password@host:5432/dbname`. The Panel's state is moving to Postgres ([#567](https://github.com/actana/control/issues/567)). At start it opens a connection, then runs its pending migrations under an advisory lock (two Panels starting at once migrate once), recording them in a `drizzle` schema of its own in that database. The role in the URL therefore needs `CREATE` on the database, which matters for an external server; the bundled one gives it. It exits with code 1 and the reason on stderr when this is unset, malformed, the server cannot be reached, a migration fails, or the database holds migrations this Panel does not ship (a newer Panel's, or an edited one). Percent-encode any `@`, `/` or `:` in the password. A URL with no host (libpq's `postgres://u@/db?host=/run/postgresql` socket form) is refused; give a host name. The reference compose sets it for you, from `AC_PANEL_DB_PASSWORD`. |
| `AC_SECRETS_KEY` | generated at `<data dir>/secrets.key` | 32-byte key (hex or base64) sealing each Core's stored credentials. Set it to keep the key out of the data directory — then a copied volume or backup alone cannot open the fleet credentials. Losing whichever key is in use means re-pairing every Core. |
| `ACTANA_UPDATE_CHECK` | on | Set to `0`, `false` or `off` to stop the daily release check. It reads `https://api.github.com/repos/actana/control/releases/latest`, caches the answer for 24h under the data directory, and only ever shows a banner — it never updates anything. |

Generate a key with `openssl rand -hex 32`.

## Optional: SeaweedFS for the Shared folder

The reference compose has one more service, `seaweedfs`, behind the `seaweedfs`
profile: SeaweedFS with its S3 gateway and STS enabled, and a role and policy
that limit a Core to `<prefix>/<core-id>/`. `docker compose up -d` does not
start it; `docker compose --profile seaweedfs up -d` does, once the
`SEAWEEDFS_*` values in `.env` are set (the OIDC issuer and JWKS URL name the
Panel's token signer). Setup, the pinned image, the policy and its Known gaps:
[`deploy/seaweedfs/README.md`](deploy/seaweedfs/README.md).

## Backup

Back up the data directory — under the reference compose that is the
`panel-data` volume:

```bash
docker run --rm -v deploy_panel-data:/data -v "$PWD":/backup debian \
  tar czf /backup/panel-data.tar.gz -C /data .
```

Nothing is stored in the database yet, so that archive is still the whole
Panel: Operator, sessions, Core registry, sealed credentials, and (unless you
set `AC_SECRETS_KEY`) the secrets key. As the Panel's state moves into
Postgres, a backup becomes that archive **plus** a dump of the database:

```bash
docker compose exec postgres pg_dump -U panel -d panel > panel-db.sql
```

A dump alone is not enough: the sealed credentials it will hold are opened by
the secrets key, which is in `panel-data` or your `AC_SECRETS_KEY`. Restore
by extracting into a fresh volume and starting the container. If you set
`AC_SECRETS_KEY`, the key is *not* in the backup — store it wherever you
store secrets, and provide it to the restored Panel.

If you opted in to [SeaweedFS](deploy/seaweedfs/README.md), its objects are in
the `seaweedfs-data` volume, which is not in that archive. Back it up the same
way (`-v deploy_seaweedfs-data:/data`, with the container stopped). The STS
signing key and the admin keys live in your `.env`, not in the volume.

## Upgrade

The Panel has no in-app updater; the image is the release artifact. The
container is disposable, the volume is not:

```bash
docker compose pull && docker compose up -d      # reference compose
```

or for the plain `docker run` case, `docker pull`, `docker rm -f`, and re-run
the same command. Schema migrations run automatically on boot. Running from
source, upgrade is `git pull && pnpm install && pnpm build` and a restart.

Cores are upgraded separately (`actana update` on each machine); the version
gate at the core-link handshake tells you in the UI when a Core and Panel
have drifted apart.
