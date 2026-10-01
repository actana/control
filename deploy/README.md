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
echo "AC_PANEL_DB_PASSWORD=$(openssl rand -hex 24)" > .env    # the Panel's Postgres password
docker compose up -d
docker compose exec -u actana core actana pair new     # a one-time code and a fingerprint
```

Then open <http://localhost:7420>, create the Operator (name + password), and
give **Add Core** the address `core:8443` and that code — checking the CA
fingerprint the Panel shows you against the one `pair new` printed.

You do not need the clone. Copying `docker-compose.yml` alone to a bare VM
works identically — plus `mkdir repos` beside it, for the bind mount the `core`
service names, and the `.env` above, which is the one value compose refuses to
guess. Every path in the file is relative to the file.

> **Pre-release.** The file pulls `:latest` for both services, and no release
> has been published yet, so that tag does not exist. Until the first release,
> run against the open train's beta image — `ACTANA_TAG=beta-0.1.0 docker
> compose up -d`. See [Choosing a version](#choosing-a-version) below.

### What that actually started

| | |
| --- | --- |
| **`panel`** | The web service. Publishes `127.0.0.1:7420`, holds the Operator login, the Core registry and the presentation layer, and nothing else. |
| **`postgres`** | The Panel's database, a digest-pinned Postgres. Publishes **no port**; the Panel reaches it by service name and will not start until its healthcheck passes. Nothing in the Panel reads it yet — it is the first step of moving the Panel's state there (#567). |
| **`core`** | A Core daemon. Publishes **no port at all** — the Panel reaches it over the compose network. Owns its sessions, SQLite database and PTYs. Two users live in it; see [Two users in the Core](#two-users-in-the-core). |
| **one network** | Compose's default. It is what lets the Panel dial `wss://core:8443` by service name. |
| **five volumes** | `panel-data`, `postgres-data`, `core-home`, `core-state`, and a bind mount of `./repos` (plus `seaweedfs-data` if you opt in to SeaweedFS). See [Volumes](#volumes--what-survives-what). |

The Panel dials the Core, never the reverse. That direction is why the Core
needs no published port, and it is the same direction on a real fleet — see
[How it works](../README.md#how-it-works).

## Pairing

A Core mints its own certificate authority on first boot and issues itself a
server certificate ([ADR 0002](../docs/adr/0002-core-link-auth-and-transport.md)).
It prints no credential and writes none into the log: a client is enrolled one
at a time, with a one-time code.

```bash
docker compose exec -u actana core actana pair new       # a code, a CA fingerprint, an expiry
docker compose exec -u actana core actana pair ls        # pending codes and paired clients
docker compose exec -u actana core actana pair revoke <target>   # unpair one, or cancel a code
docker compose exec -u actana core actana token regenerate       # rotate this Core's identity
```

`-u actana` is not optional: the pairing identity and the pairings are the daemon's, and the daemon's user is the only
one that can read them. Run as `core` or as a plain `docker compose exec` (root), `actana pair` and `actana status`
refuse in one sentence that names this command, exit non-zero and change nothing. See
[Two users in the Core](#two-users-in-the-core).

The code is single-use, expires in five minutes by default, and dies after five
wrong guesses. Read it out with the fingerprint beside it: the client checks the
CA it is presented against that fingerprint before it sends the code, and the
private key it ends up holding is generated on the client and never crosses the
wire.

`pair revoke` takes back one client. `token regenerate` is the wider hammer — a
new CA, and every client paired with this Core has to pair again. Remove the Core
from a Panel before you do: rotation does not move the endpoint, so pairing at an
address that is already registered is refused, and refused *before* the code is
spent. `actana core pair` replaces its stored credential in place instead.

## `ACTANA_PUBLIC_HOST` is the service name, and that is load-bearing

```yaml
core:
  environment:
    - ACTANA_PUBLIC_HOST=core
```

That one value is two-and-a-half things at once (ADR 0038):

1. the **address the Panel dials** (`wss://core:8443`),
2. the **SANs in the Core's server certificate** — every entry, since the value
   may name more than one address, and
3. by default, the **endpoint a pairing hands back** to the client that redeems
   a code: the first entry, unless that code chose another of them with
   `pair new --public-host`.

So it lives in the compose file you edit, next to the service it names — never
in `.env`, which has room for one value and a fleet needs one per Core, and
never guessed by the image, because a container's default hostname is its
container ID and would change the certificate on every recreation.

Rename the service and you must change this to match. What that costs depends
on which edit it is:

- **Adding** an address leaves every address already there covered, so clients
  paired before the edit keep working and none has to be re-paired.
- **Replacing or removing** one means re-pairing every client that was paired to
  the address you took away: the new certificate does not cover it, and the
  client is the one holding it.

### Reaching one Core more than one way

A Core is often reachable two ways at once — as the compose service name from
the Panel beside it, and as a LAN address from your own machine's `actana`. Name
both, comma-separated, and one certificate covers both:

```yaml
core:
  environment:
    - ACTANA_PUBLIC_HOST=core,192.168.1.20
```

Every entry becomes a SAN. **The first entry is the primary**: it is the
certificate's common name, and it is the endpoint a pairing hands back unless
that code chose otherwise. `localhost` and `127.0.0.1` are always covered too,
so the container's own `actana` can dial it.

Then pair each client to the address it can actually reach:

```bash
docker compose exec -u actana core actana pair new --label panel  --public-host core
docker compose exec -u actana core actana pair new --label laptop --public-host 192.168.1.20
```

`--public-host` **chooses** from that list; it can never add to it. Name an
address that is not configured and `pair new` refuses and prints the ones that
are — a code that handed back an address this certificate does not cover would
give its client a credential that fails on its first dial.

A single value still means exactly what it always meant, so nothing above is
needed for one address. And **adding** an address to the list keeps the ones
already there covered: clients paired before the change stay paired, which is
the re-pair that *replacing* the one value still forces and adding no longer
does.

## Volumes — what survives what

| Volume | Holds | Destroyed by |
| --- | --- | --- |
| `panel-data` | Operator login, Core registry, sealed pairing credentials, the secrets key (unless `AC_SECRETS_KEY` is set), your Panel-side preferences | `docker compose down -v` |
| `postgres-data` | The Panel's Postgres cluster. Empty of Panel data for now: the Panel only connects to it | `docker compose down -v` |
| `core-home` | The Core's home, `/home/core`: its work and **each Harness's own credentials** (`~/.claude`, `~/.codex`, …). The user `core` (uid 1000) owns it | `docker compose down -v` |
| `core-state` | What only the Core's daemon may hold, at `/var/lib/actana` (mode 700): its pairing identity and pairings, its SQLite database, the update-check caches. The user `actana` (uid 1001) owns it. A Session, which runs as `core`, cannot read it | `docker compose down -v` |
| `seaweedfs-data` | Only with `--profile seaweedfs`: the Shared folder's stored objects | `docker compose down -v` |
| `./repos` (bind mount) | Your checkouts, where **Add project** finds them | nothing — it is a directory on your host |

`docker compose down` stops and removes the containers and leaves every volume.
**`docker compose down -v` deletes the named volumes** (`panel-data`,
`postgres-data`, `core-home` and `core-state`, plus `seaweedfs-data` if you opted in): the Operator, every
Core's pairing, every session, every Harness login inside the Core, and the
Shared folder's stored objects. The
bind-mounted `./repos` is untouched either way, which is the point of it being a
bind mount.

Backing up the Panel is backing up `panel-data` **and** the database —
[`DEPLOY.md` § Backup](../DEPLOY.md#backup) has the `tar` one-liner and the
`pg_dump`. A dump alone is not enough once the Core credentials move into it:
they are sealed, and the key that opens them is in `panel-data` or your
`AC_SECRETS_KEY`.

One caveat on `./repos`: files the Core's Sessions write there are owned by uid 1000,
which is your own uid only on a host whose login user was the first created. If
that bites, swap it for a named volume (`core-repos:/home/core/repos`, with
`core-repos:` added under `volumes:`) and let the Core own them. A missing host
`./repos` that Docker creates as root is repaired by the `core-init` one-shot
(mount point only) before `core` starts. It also hands the `core-state` volume to uid 1001 (the `actana` user).

## Two users in the Core

The `core` container has two users, and what each can read is the point
([ADR 0041](../docs/adr/0041-the-0-5-0-core-model.md) D23–D25). This section describes the image and
compose file as the pull request that switches them over, which was a draft when this was written, makes them.

| User | uid | What it is | What it owns |
| --- | --- | --- | --- |
| `actana` | 1001 | The daemon: pairing, the core link, the database. A system user | `/var/lib/actana` (the `core-state` volume, mode 700) |
| `core` | 1000 | Sessions, and everything a Harness does. Has no sudo | `/home/core` (the `core-home` volume): the work, `~/shared`, each Harness's login |

The container starts as root only for the entrypoint's step before it starts the daemon as `actana`; tini as PID 1
is the only other root process. The daemon holds two capabilities, `CAP_SETUID` and `CAP_SETGID`, and no others. It
starts every Session as `core` with no capabilities and `no_new_privs` set, so a Session cannot read
`/var/lib/actana` and cannot become the daemon's user. The compose file asks for exactly those two
capabilities (`cap_drop: ALL`, `cap_add: [SETUID, SETGID]`) and sets `no-new-privileges`.

**Which user to `docker compose exec` as.** Without `-u` you are root. That root cannot override file permissions, so it
can read neither the home nor the state. Name the user:

```bash
docker compose exec -u core core bash                    # a shell as a Session would have it
docker compose exec -u actana core actana pair new       # the daemon's own files: pairing
docker compose exec -u actana core actana status
```

`actana pair` and `actana status` check this for you. Run as any other user in the container they print one sentence with
the exact command above, exit non-zero and change nothing. Outside the container (`actana setup` on a machine) there
is one user, and nothing is checked.

Upgrading from an earlier 0.5.0 build is not supported: 0.5.0 Cores are installed fresh. A state volume that is not
owned by uid 1001 with mode 700 is refused at start with the owner it found, and is left as it was.

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
way — `docker compose exec -u actana core2 actana pair new` prints its own code and CA
fingerprint, and **Add Core** takes the address `core2:8443` with that code.

Its repos are a named volume rather than a second bind mount, which is exactly
the swap described above: a bind mount needs a host directory that already
exists and is writable by uid 1000, and a pasted-in service would have neither.

A Core does not have to be in this file at all. The point of the architecture is
Cores on the machines that already have your code — `install.sh` and then
`actana setup` on a laptop or a build box, paired to this same Panel. It is two
commands because installing is not activating. See
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

| Set | Get | Moves |
| --- | --- | --- |
| nothing | `:latest` — the current release | per release |
| `ACTANA_TAG=0.1.0` | that release, pinned. What a real deployment should do | never |
| `ACTANA_TAG=beta-0.2.0` | the open train's tip — the next release, for testing | **on every merge into the train** |
| `ACTANA_TAG=0.2.0-beta` | the train's last published beta cut | **only when a person cuts one** |

```bash
ACTANA_TAG=0.1.0 docker compose up -d
```

Put it in `.env` beside the compose file to make it stick. `docker compose
pull && docker compose up -d` then upgrades within whatever you pinned, which
for a pinned version means it does nothing until you change the pin — that is
the intended behaviour of a pin.

**The last two rows are both "a beta of 0.2.0", and they run on different
clocks.** That is the one thing to get right here:

- **`beta-0.2.0`** is the train tag. It is republished by **every merge into the
  train**, so what you get depends on when you pulled and nobody announced the
  change. It is what the beta acceptance checklist is worked against, and it is
  the digest a promotion re-points.
- **`0.2.0-beta`** is a published beta cut. It moves **only when somebody
  dispatches one**, and it stands still between cuts however much the train
  moves underneath it. It is the version a machine reports, and the same string
  names the git tag, the prerelease, its Core tarballs and this image tag.

Neither is `latest`, and neither ever will be. The version string of a beta is
`x.y.z-beta` exactly — no counter, no dotted suffix — so `0.2.0-beta` is the
whole tag for the 0.2.0 line's beta however many times that line is cut. Both
tags persist after the line promotes; nothing sweeps them.

`beta-<version>` is a real multi-arch build of the release train, and it is the
same digest that promotion re-points at `<version>` and `:latest` when the
train ships. Nothing is rebuilt in between, so a beta you have run is the
release you will get. `x.y.z-beta` is that same digest under a second name, cut
from the train at the moment somebody asked. That guarantee starts at
`beta-x.y.z` and stops at `x.y.z`, and it does not extend to the Core tarballs —
see [`../docs/ci-cd.md`](../docs/ci-cd.md) and [ADR
0036](../docs/adr/0036-the-beta-release-channel.md).

A beta is no longer testable only as a container: the same train installs on
metal from its own ref, and the CLI-only path has an equivalent too. See
[`INSTALL.md` §Installing a beta](../INSTALL.md#installing-a-beta).

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

## Shared folder storage: SeaweedFS (optional)

The compose file also defines a `seaweedfs` service — SeaweedFS with its S3
gateway and STS enabled, the backend for the Shared folder of development Cores.
It is behind a compose profile, so **a plain `docker compose up -d` is unchanged**:
it does not start it, pull its image or read its variables. To opt in, fill the
`SEAWEEDFS_*` block of `.env` and run:

```bash
docker compose --profile seaweedfs up -d
```

[`seaweedfs/README.md`](seaweedfs/README.md) has the variables, the pinned image,
and the role and policy that limit a Core to `<prefix>/<core-id>/`, with what
each allowed and denied request does. Its Known gaps say what is not built yet.

## Configuration

Copy [`.env.example`](.env.example) to `.env` beside the compose file. One
value is required, `AC_PANEL_DB_PASSWORD`: `docker compose up -d` stops and
names it until it is set. Every other value is optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `AC_PANEL_DB_PASSWORD` | **required**, no default | The password of the bundled Postgres. Generate one with `openssl rand -hex 24`; hex, because it is put into a URL. It is never committed, and it is only read when the database is first created: changing it later means changing it inside the database too. |
| `AC_PANEL_DATABASE_URL` | the bundled `postgres` service | A `postgres://user:password@host:5432/db` URL, to point the Panel at a Postgres of your own. The Panel exits at start, with the reason on stderr, when this is missing or cannot be reached. |
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
<id>`. `docker compose exec -u actana core actana --help` prints the container page. `status` and `pair` need `-u actana`
(see [Two users in the Core](#two-users-in-the-core)).
