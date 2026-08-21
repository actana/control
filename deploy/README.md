# The reference deployment

[`docker-compose.yml`](docker-compose.yml) brings up the whole product on one
host: **one Panel and one Core, on one network** ([ADR 0016](../docs/adr/0016-the-0-1-0-shape.md)
D41). It is the copy-paste path in the README, and this page is the walkthrough
the one-liner leaves out.

It is a *reference*, not a framework. Every choice below is one you can change,
and the ones that look arbitrary are the ones this page exists to explain.

Related: [`DEPLOY.md`](../DEPLOY.md) for the Panel on its own (including the
plain-Node path, TLS, backup and upgrade), [`INSTALL.md`](../INSTALL.md) for a
Core installed on metal rather than in a container.

---

## Bring it up

```bash
git clone https://github.com/actana/control
cd control/deploy
docker compose up -d
docker compose exec core actana pair new     # a one-time code and a fingerprint
```

Then open <http://localhost:7420>, create the Operator (name + password), and
give **Add Core** the address `core:8443` and that code — checking the CA
fingerprint the Panel shows you against the one `pair new` printed.

You do not need the clone. Copying `docker-compose.yml` alone to a bare VM
works identically — plus `mkdir repos` beside it, for the bind mount the `core`
service names. Every path in the file is relative to the file.

> **Pre-release.** The file pulls `:latest` for both services, and no release
> has been published yet, so that tag does not exist. Until the first release,
> run against the open train's beta image — `ACTANA_TAG=beta-0.1.0 docker
> compose up -d`. See [Choosing a version](#choosing-a-version) below.

### What that actually started

| | |
| --- | --- |
| **`panel`** | The web service. Publishes `127.0.0.1:7420`, holds the Operator login, the Core registry and the presentation layer, and nothing else. |
| **`core`** | A Core daemon. Publishes **no port at all** — the Panel reaches it over the compose network. Owns its projects, sessions, SQLite database and PTYs. |
| **one network** | Compose's default. It is what lets the Panel dial `wss://core:8443` by service name. |
| **three volumes** | `panel-data`, `core-home`, and a bind mount of `./repos`. See [Volumes](#volumes--what-survives-what). |

The Panel dials the Core, never the reverse. That direction is why the Core
needs no published port, and it is the same direction on a real fleet — see
[How it works](../README.md#how-it-works).

## Pairing

A Core mints its own certificate authority on first boot and issues itself a
server certificate ([ADR 0002](../docs/adr/0002-core-link-auth-and-transport.md)).
It prints no credential and writes none into the log: a client is enrolled one
at a time, with a one-time code.

```bash
docker compose exec core actana pair new       # a code, a CA fingerprint, an expiry
docker compose exec core actana pair ls        # pending codes and paired clients
docker compose exec core actana pair revoke <target>   # unpair one, or cancel a code
docker compose exec core actana token regenerate       # rotate this Core's identity
```

The code is single-use, expires in five minutes by default, and dies after five
wrong guesses. Read it out with the fingerprint beside it: the client checks the
CA it is presented against that fingerprint before it sends the code, and the
private key it ends up holding is generated on the client and never crosses the
wire.

`pair revoke` takes back one client. `token regenerate` is the wider hammer — a
new CA, and every client paired with this Core has to pair again.

## `ACTANA_PUBLIC_HOST` is the service name, and that is load-bearing

```yaml
core:
  environment:
    - ACTANA_PUBLIC_HOST=core
```

That one value is three things at once:

1. the **address the Panel dials** (`wss://core:8443`),
2. the **SAN in the Core's server certificate**, and
3. the **endpoint every pairing hands back** to the client that redeems a code.

So it lives in the compose file you edit, next to the service it names — never
in `.env`, which has room for one value and a fleet needs one per Core, and
never guessed by the image, because a container's default hostname is its
container ID and would change the certificate on every recreation.

Rename the service and you must change this to match. Changing it after pairing
means re-pairing: the old certificate does not cover the new name.

## Volumes — what survives what

| Volume | Holds | Destroyed by |
| --- | --- | --- |
| `panel-data` | Operator login, Core registry, sealed pairing credentials, the secrets key (unless `AC_SECRETS_KEY` is set), your Panel-side preferences | `docker compose down -v` |
| `core-home` | The Core's whole home: its pairing identity, its SQLite database, and **each Harness's own credentials** (`~/.claude`, `~/.codex`, …) | `docker compose down -v` |
| `./repos` (bind mount) | Your checkouts, where **Add project** finds them | nothing — it is a directory on your host |

`docker compose down` stops and removes the containers and leaves all three.
**`docker compose down -v` deletes the two named volumes**: the Operator, every
Core's pairing, every session, and every Harness login inside the Core. The
bind-mounted `./repos` is untouched either way, which is the point of it being a
bind mount.

Backing up the Panel is backing up `panel-data` — [`DEPLOY.md` §
Backup](../DEPLOY.md#backup) has the `tar` one-liner.

One caveat on `./repos`: files the Core writes there are owned by uid 1000,
which is your own uid only on a host whose login user was the first created. If
that bites, swap it for a named volume (`core-repos:/home/core/repos`, with
`core-repos:` added under `volumes:`) and let the Core own them.

## The `127.0.0.1:7420:7420` port

```yaml
ports:
  - "127.0.0.1:7420:7420"
```

Loopback-only, deliberately. The Panel speaks **plain HTTP** and never grows
certificate code ([ADR 0010](../docs/adr/0010-panel-becomes-a-self-hosted-web-service.md)),
and `localhost` is a secure context without TLS — so a single-machine setup
works exactly as it stands, and a browser on another machine cannot reach it by
accident.

Change it to `"7420:7420"` **only once a TLS proxy is the thing in front of
it**. Point your Nginx / Traefik / Caddy at 7420, and give it two things:
forward WebSocket upgrades (the panel link is one), and set
`X-Forwarded-Proto: https` — without it the Panel issues a session cookie the
browser will happily send over plain HTTP. [`DEPLOY.md` §
TLS](../DEPLOY.md#tls) is the longer version.

None of this touches the core-link. That is mutual TLS with material the Core
mints itself, and no proxy of yours terminates or renews it.

## Adding a second Core

Nothing here is a singleton. `docker-compose.yml` carries a commented block
between `# >>> second Core` and `# <<< second Core`; uncomment it, add
`core2-home:` and `core2-repos:` under `volumes:`, and `docker compose up -d`.

Three things change per Core, and they must agree: the **service name**,
`ACTANA_PUBLIC_HOST` **to match it**, and its **own volumes**. Pair it the same
way — its blob is in `docker compose logs core2`.

Its repos are a named volume rather than a second bind mount, which is exactly
the swap described above: a bind mount needs a host directory that already
exists and is writable by uid 1000, and a pasted-in service would have neither.

A Core does not have to be in this file at all. The point of the architecture is
Cores on the machines that already have your code — `curl … install.sh | sh` on
a laptop or a build box, paired to this same Panel. See
[`INSTALL.md`](../INSTALL.md).

## Choosing a version

Both `image:` lines read one variable:

```yaml
panel:
  image: ${ACTANA_IMAGE_NAMESPACE:-actana}/panel:${ACTANA_TAG:-latest}
core:
  image: ${ACTANA_IMAGE_NAMESPACE:-actana}/core:${ACTANA_TAG:-latest}
```

**`ACTANA_TAG` moves both services together, and that is the point of it being
one variable.** The Panel and its Cores are version-locked: the core-link
handshake exchanges a protocol version, and a mismatched pair renders as "needs
update" in the Panel rather than degrading quietly. A Panel on `0.2.0` beside a
Core on `0.1.0` is a combination that never shipped and that nobody tested, so
the file does not make it convenient to type.

| Set | Get |
| --- | --- |
| nothing | `:latest` — the current release |
| `ACTANA_TAG=0.1.0` | that release, pinned. What a real deployment should do |
| `ACTANA_TAG=beta-0.2.0` | the open train — the next release, for testing |

```bash
ACTANA_TAG=0.1.0 docker compose up -d
```

Put it in `.env` beside the compose file to make it stick. `docker compose
pull && docker compose up -d` then upgrades within whatever you pinned, which
for a pinned version means it does nothing until you change the pin — that is
the intended behaviour of a pin.

`beta-<version>` is a real multi-arch build of the release train, and it is the
same digest that promotion re-points at `<version>` and `:latest` when the
train ships. Nothing is rebuilt in between, so a beta you have run is the
release you will get. That guarantee starts at `beta-x.y.z` and stops at
`x.y.z` — see [`../docs/ci-cd.md`](../docs/ci-cd.md).

`ACTANA_IMAGE_NAMESPACE` exists for a fork publishing under its own Docker Hub
account. It defaults to `actana` and most deployments never set it.

### Pre-merge pull request images

Images built from an open pull request live in *different repositories* —
`actana/panel-dev` and `actana/core-dev` — so a tag alone cannot reach them.
[`docker-compose.dev-images.yml`](docker-compose.dev-images.yml) is the
override that does:

```bash
ACTANA_TAG=pr-116202608 docker compose \
  -f docker-compose.yml -f docker-compose.dev-images.yml up -d
```

**Somewhere disposable, not here.** Those images have not been released or
approved by anybody, may carry a failing CVE scan, and may not work at all.
Bring one up in a scratch directory, look at the change, and `docker compose
down -v`. The tag is on the pull request itself — the `Panel image` and `Core
image` checks each announce the tag they pushed. Fork pull requests publish no
image at all; that is by design, not a failure.

## Configuration

Copy [`.env.example`](.env.example) to `.env` beside the compose file. Every
value in it is optional — `docker compose up -d` works with no `.env` at all.

| Variable | Default | What it does |
| --- | --- | --- |
| `ACTANA_TAG` | `latest` | The image tag **both** services pull. See [Choosing a version](#choosing-a-version) — one variable, because Panel and Core are version-locked. |
| `ACTANA_IMAGE_NAMESPACE` | `actana` | The Docker Hub namespace both images come from. For a fork that publishes its own; most deployments never set it. |
| `AC_SECRETS_KEY` | generated at `/data/secrets.key` | 32-byte key (hex or base64, e.g. `openssl rand -hex 32`) sealing each Core's stored credentials. Set it to keep the key **out of** `panel-data`, so a copied volume or a backup alone cannot open your fleet credentials. Losing whichever key is in use means re-pairing every Core. |
| `ACTANA_UPDATE_CHECK` | on | `0`, `false` or `off` stops the daily release check on both services. |

[`DEPLOY.md` § Configuration](../DEPLOY.md#configuration) is the full list,
including the ones the compose file does not surface.

## Updating

```bash
docker compose pull && docker compose up -d
```

The container is disposable; the volumes are not. Schema migrations run on
boot. There is **no in-app updater** — the image is the release artifact, and
this command is the update, run by you, here.

What Actana does do is *tell* you: once every 24 hours the Panel and each Core
ask `https://api.github.com/repos/actana/control/releases/latest` whether a
newer release exists, and say so in a dismissible banner, in `actana status`,
and once a day in `docker compose logs core`. Nothing is downloaded and nothing
is applied. Set `ACTANA_UPDATE_CHECK=0` in your `.env` to turn it off; it fails
silent on any network error either way.

## Operating a containerised Core

The image *is* the install, so the lifecycle verbs belong to Docker and
`actana` refuses them by name, pointing at the Docker command that does the
job:

| Instead of | Run |
| --- | --- |
| `actana setup` | set `ACTANA_PUBLIC_HOST` in this file, then `docker compose up -d` |
| `actana start` / `stop` / `restart` | `docker compose up -d` / `stop` / `restart` |
| `actana update` | `docker compose pull && docker compose up -d` |
| `actana logs` | `docker compose logs -f core` |
| `actana uninstall` | `docker compose down` (add `-v` to also delete sessions and pairing) |

The verbs that still work are the ones that are about *this* Core rather than
its lifecycle — `actana status`, `actana pair`, `actana harnesses install
<id>`. `docker compose exec core actana --help` prints the container page.
