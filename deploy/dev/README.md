# Dev stack — Panel + Core-in-a-box on one compose network

One `docker compose up` gives you a Panel and an Ubuntu Core that pair over
the compose network by service name: the Core's cert and registration blob
carry `core` as the host, the Panel dials `wss://core:8443` internally, and
the Core publishes **no ports** to your machine at all. Only the Panel is
reachable, at `http://localhost:7420`.

This is a development fixture, not a deployment. For hosting a real Panel see
[DEPLOY.md](../../DEPLOY.md); for installing a real Core see
[INSTALL.md](../../INSTALL.md).

CI publishes this image as `ghcr.io/actana/core` and `docker.io/actana/core`
(see [docs/ci-cd.md](../../docs/ci-cd.md#the-published-images)), so you can pull
it instead of building. The name looks production-ready and is not: systemd is
PID 1 (hence `privileged: true` and the cgroup mount below), the `operator` user
has passwordless sudo, and the provision script hardcodes `--public-host core`,
so it only pairs when the Panel can reach it at the hostname `core`. Building
locally is still the better path when you are changing the Harness, since the
published image carries the tarball from whichever commit built it.

## 1. Build a Linux Harness tarball

The Core installs the same tarball a release ships. On a Linux host:

```bash
pnpm harness:tarball
```

On macOS, build it inside Linux (native modules don't cross-compile) — in a
**throwaway clone**, since this rewrites `node_modules` with Linux binaries:

```bash
docker run --rm -v "$PWD":/repo -w /repo node:24 bash -c 'apt-get update -qq && apt-get install -y -qq python3 make g++ && corepack enable && corepack pnpm@11.1.2 install && corepack pnpm@11.1.2 harness:tarball'
```

Either way the tarball lands in `artifacts/harness/`, where the compose build
picks it up. (From a throwaway clone, copy it into this repo's
`artifacts/harness/` first.)

## 2. Up

```bash
cd deploy/dev
docker compose up -d --build
```

First boot takes a minute: the Core is a real systemd machine that installs
the Harness through the same no-sudo, operator-session path the installer
e2es exercise (`core-provision.service`).

## 3. Pair

```bash
docker compose exec core cat /home/operator/registration-blob.txt
```

Open `http://localhost:7420` → create the Operator → **Add Core** → paste the
blob. The Panel dials `wss://core:8443` and the Core comes up green. If the
blob file isn't there yet, provisioning is still running — watch it with:

```bash
docker compose exec core journalctl -u core-provision -f
```

## Notes

- **State survives recreation.** `panel-data` holds the Panel, `core-home`
  holds the Core (install, SQLite, certs, the provision marker).
  `docker compose down && up` keeps the pairing; `docker compose down -v`
  starts the world over.
- **No agent CLIs are installed** (`--no-agents` — hermetic first boot).
  Re-run setup interactively to add them:
  `docker compose exec core machinectl shell operator@`
  then `actana setup` in that shell.
- **A shell on the Core:** `docker compose exec core machinectl shell operator@`
  — a real login session as the operator, `actana status` works.
- **This machine has a toolchain.** Unlike the e2e fixture it copies, the dev
  Core ships git, curl, build-essential, Node 24, and the operator has
  passwordless sudo — it's a machine to do dev work on, not a proof that the
  installer needs none of that.
