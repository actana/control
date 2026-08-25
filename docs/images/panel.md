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

## With a Core, and behind your own proxy

The reference [`deploy/docker-compose.yml`](https://github.com/actana/control/blob/main/deploy/docker-compose.yml)
brings this image up beside a Core on one network, which is the whole product
in one command. It ships no TLS terminator: point your Traefik / Nginx / Caddy
at port 7420. Two requirements: forward WebSocket upgrades, and set
`X-Forwarded-Proto: https`. Without the latter the Panel issues a cookie the
browser will send over plain HTTP.

## Configuration

Environment variables only; there is no config file.

| Env | Default | Meaning |
| --- | --- | --- |
| `AC_PANEL_PORT` / `PORT` | `7420` | Port to listen on |
| `AC_PANEL_HOST` / `HOST` | `0.0.0.0` | Interface to bind |
| `AC_PANEL_DATA_DIR` | `/data` | The one directory all Panel state lives in |
| `AC_SECRETS_KEY` | generated at `<data dir>/secrets.key` | 32-byte key (hex or base64) sealing each Core's stored credentials |
| `ACTANA_UPDATE_CHECK` | on | Set to `0`, `false` or `off` to stop the daily release check behind the Panel's "a newer Actana is available" banner. |

Set `AC_SECRETS_KEY` (`openssl rand -hex 32`) to keep the key out of the data
directory — otherwise a copied volume or a backup carries both the sealed
credentials and the key that opens them. Losing whichever key is in use means
re-pairing every Core.

## State and backup

Everything the Panel must survive a restart with — the Operator, the Core
registry, sealed credentials, the secrets key — lives in `/data`. Back up that
volume and you have backed up the Panel. Schema migrations run on boot.

## You also need a Core

The Panel runs nothing itself — it is a connection broker. The work happens on a
**Core**, and every machine you want to work on needs one:

```bash
curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
actana setup
```

Two commands, because installing is not activating: the first places the Core
bundle and the `actana` CLI, the second turns the machine into a Core. See
[INSTALL.md](https://github.com/actana/control/blob/main/INSTALL.md). The
`actana/core` image is the other supported way to run one, and the reference
compose above brings both up together.

## Tags

| Tag | Moves |
| --- | --- |
| `latest` | on the release of the highest version — the default |
| `<version>`, e.g. `0.1.0` | never — pin deployments to this |
| `beta-<version>` | on every merge into that release's train — the next release, for testing |

`linux/amd64` and `linux/arm64`, each built on a native runner.

`<version>` is not a rebuild of `beta-<version>`: a release **re-points the
same digest** a person already pulled, ran and approved. The bytes under
`beta-0.1.0` and the bytes under `0.1.0` are identical, and the pipeline
refuses to publish when they are not.

Pre-merge builds of open pull requests live in a separate repository,
[`actana/panel-dev`](https://hub.docker.com/r/actana/panel-dev), along with the
`sha-<short>` commit pins. Nothing there is released, and nothing here is a
pre-merge build.

## Links

- [Source](https://github.com/actana/control) · [Deployment guide](https://github.com/actana/control/blob/main/DEPLOY.md) · [Security policy](https://github.com/actana/control/blob/main/SECURITY.md)

MIT licensed. A derivative work of Mission Control by AgentSystem Labs — see
[NOTICE](https://github.com/actana/control/blob/main/NOTICE).
