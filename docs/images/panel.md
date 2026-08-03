# Actana Panel

The self-hosted web service at the centre of [Actana Control](https://github.com/actana/control)
— you open it in a browser, and it drives agentic coding work (Claude Code,
Codex, Cursor CLI) across every machine you have registered.

This image is **the** Panel release artifact. There is no installer and no
in-app updater: the container is disposable, the volume is not.

## Quick start

`localhost` is a secure context without TLS, so a personal setup is one command:

```bash
docker run -d --name actana-panel \
  -p 127.0.0.1:7420:7420 \
  -v actana-panel-data:/data \
  actana/panel:latest
```

Open `http://localhost:7420`. First boot asks you to create the Operator, then
you pair each machine with the token `actana setup` printed there.

Binding `127.0.0.1` is deliberate — the Panel speaks **plain HTTP** and leaves
TLS to a reverse proxy. Anything reaching it from another machine should arrive
through one.

## Hosted, with HTTPS

The reference [`deploy/docker-compose.yml`](https://github.com/actana/control/blob/main/deploy/docker-compose.yml)
pairs this image with Caddy, which gets and renews a Let's Encrypt certificate,
forwards WebSocket upgrades, and sets `X-Forwarded-Proto` — the signal that
makes the Panel mark its session cookie `Secure`.

Behind a proxy you already run, point it at port 7420. Two requirements:
forward WebSocket upgrades, and set `X-Forwarded-Proto: https`. Without the
latter the Panel issues a cookie the browser will send over plain HTTP.

## Configuration

Environment variables only; there is no config file.

| Env | Default | Meaning |
| --- | --- | --- |
| `AC_PANEL_PORT` / `PORT` | `7420` | Port to listen on |
| `AC_PANEL_HOST` / `HOST` | `0.0.0.0` | Interface to bind |
| `AC_PANEL_DATA_DIR` | `/data` | The one directory all Panel state lives in |
| `AC_SECRETS_KEY` | generated at `<data dir>/secrets.key` | 32-byte key (hex or base64) sealing each Core's stored credentials |

Set `AC_SECRETS_KEY` (`openssl rand -hex 32`) to keep the key out of the data
directory — otherwise a copied volume or a backup carries both the sealed
credentials and the key that opens them. Losing whichever key is in use means
re-pairing every Core.

## State and backup

Everything the Panel must survive a restart with — the Operator, the Core
registry, sealed credentials, the secrets key — lives in `/data`. Back up that
volume and you have backed up the Panel. Schema migrations run on boot.

## You also need a Core

The Panel bundles no agent runtime and runs nothing itself. Each machine you
want to work on needs a **Harness** installed on it, which the Panel then
registers as a **Core**:

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
```

See [INSTALL.md](https://github.com/actana/control/blob/main/INSTALL.md). The
`actana/core` image is a *development fixture* for trying the pairing flow on
one machine — it is not how you host a real Core.

## Tags

| Tag | Moves |
| --- | --- |
| `latest` | every non-prerelease version tag |
| `<version>`, e.g. `0.49.0` | never — pin deployments to this |
| `edge` | every push to `main` |
| `sha-<short>` | never — an exact commit |

`linux/amd64` and `linux/arm64`, each built on a native runner.

## Links

- [Source](https://github.com/actana/control) · [Deployment guide](https://github.com/actana/control/blob/main/DEPLOY.md) · [Security policy](https://github.com/actana/control/blob/main/SECURITY.md)
- Also published as `ghcr.io/actana/panel`

MIT licensed. A derivative work of Mission Control by AgentSystem Labs — see
[NOTICE](https://github.com/actana/control/blob/main/NOTICE).
