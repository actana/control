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

- a **Docker image**, `ghcr.io/actana/panel` — built by CI on
  every release
- the same build as a **plain Node process**, for machines where containers
  are unavailable or unwanted

## Hosted with HTTPS — the reference compose

The copy-paste path. [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
pairs the Panel with [Caddy](https://caddyserver.com), which obtains and
renews a Let's Encrypt certificate automatically and forwards WebSocket
upgrades (the panel link) and `X-Forwarded-Proto` — the signal that makes the
Panel mark its session cookie `Secure`.

Prerequisites: a machine with Docker, a DNS record for your domain pointing
at it, and ports 80/443 reachable from the internet (Let's Encrypt issuance
needs them).

```bash
git clone https://github.com/actana/control
cd control/deploy
cp .env.example .env      # set AC_PANEL_DOMAIN; optionally AC_SECRETS_KEY
docker compose up -d
```

Open `https://<your domain>`: the first boot asks you to create the Operator
(name + password), and after logging in you pair your first Core with the
registration blob `actana setup` printed on that machine. Both cookies and the panel
link's `wss://` upgrade work behind the proxy out of the box.

Only `deploy/docker-compose.yml`, `deploy/Caddyfile`, and your `.env` matter
— copying those three files to a bare VM works just as well as cloning.

### Behind a proxy you already run

Skip the bundled Caddy and point your Traefik/Nginx/Caddy at the container's
port 7420. Two requirements: forward WebSocket upgrades, and set
`X-Forwarded-Proto: https` — without it the Panel issues a cookie the browser
will happily send over plain HTTP.

## Localhost — no proxy needed

`localhost` is a secure context without TLS, so a personal single-machine
setup is one command:

```bash
docker run -d --name actana-panel \
  -p 127.0.0.1:7420:7420 \
  -v actana-panel-data:/data \
  ghcr.io/actana/panel:latest
```

Open `http://localhost:7420`. Binding `127.0.0.1` keeps the plain-HTTP port
off the network; anything reaching the Panel from another machine should come
through a TLS proxy instead.

## The bare `node` path

The image's entry is an ordinary Node program, so the same build runs
anywhere Node 24 does:

```bash
pnpm install
pnpm build                                # builds the Harness bundle + the Panel
AC_PANEL_DATA_DIR=/var/lib/actana-panel pnpm start
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
| `AC_SECRETS_KEY` | generated at `<data dir>/secrets.key` | 32-byte key (hex or base64) sealing each Core's stored credentials. Set it to keep the key out of the data directory — then a copied volume or backup alone cannot open the fleet credentials. Losing whichever key is in use means re-pairing every Core. |

Generate a key with `openssl rand -hex 32`.

## Backup

Back up the data directory — under the reference compose that is the
`panel-data` volume:

```bash
docker run --rm -v deploy_panel-data:/data -v "$PWD":/backup debian \
  tar czf /backup/panel-data.tar.gz -C /data .
```

That archive is the whole Panel: Operator, sessions, Core registry, sealed
credentials, and (unless you set `AC_SECRETS_KEY`) the secrets key. Restore
by extracting into a fresh volume and starting the container. If you set
`AC_SECRETS_KEY`, the key is *not* in the backup — store it wherever you
store secrets, and provide it to the restored Panel.

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
