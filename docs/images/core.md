# Actana Core — development fixture

> ### ⚠️ This is not a production deployment
>
> This image exists so you can try the real Panel↔Core pairing flow on one
> machine with nothing but Docker. It is **not** how you host a Core, and it is
> not hardened. Specifically, it:
>
> - runs **systemd as PID 1**, so it needs `--privileged` and the host cgroup
> - grants the `operator` user **passwordless sudo**
> - bakes systemd **linger** into the image
> - hardcodes `--public-host core`, so it only pairs when the Panel can reach
>   it at the hostname `core`
>
> **To run a real Core, install the Harness on a machine you own** —
> [INSTALL.md](https://github.com/actana/control/blob/main/INSTALL.md). There is
> no supported container deployment of a Core.

## What a Core is

In [Actana Control](https://github.com/actana/control), a **Core** is a machine
that actually has your code on it. It runs a **Harness** daemon that owns the
projects, the sessions, the SQLite database, and the PTYs — it is the only
process that writes its own state. The **Panel** (`actana/panel`) is a
connection broker over your fleet of Cores; it stores nothing task-shaped.

This image is an Ubuntu machine with the Harness tarball baked in and a
first-boot unit that installs it, so a `docker compose up` gives you a working
pair to click around in.

## Use it with the dev compose

```bash
git clone https://github.com/actana/control
cd control/deploy/dev
docker compose up -d
docker compose exec core cat /home/operator/registration-blob.txt
```

Open `http://localhost:7420`, create the Operator, and paste that blob into
"Add Core". The Panel dials `wss://core:8443` over the compose network; the
Core publishes no ports to your machine at all.

Full walkthrough: [deploy/dev/README.md](https://github.com/actana/control/blob/main/deploy/dev/README.md).

The compose file supplies the `privileged`, `cgroup`, and tmpfs settings
systemd needs. Running this image with a plain `docker run` will not boot.

## Agent CLIs

The image provisions itself with `--no-agents`, so it comes up hermetically
with no vendor CLI installed. Add them afterwards:

```bash
docker compose exec core machinectl shell operator@ /bin/bash -lc 'actana agents install claude'
```

## Building it yourself

Preferred when you are changing the Harness — the published image carries the
tarball from whichever commit built it:

```bash
pnpm harness:tarball        # on Linux; see the dev README for the macOS path
docker compose up -d --build
```

## Tags

| Tag | Moves |
| --- | --- |
| `latest` | every non-prerelease version tag |
| `<version>`, e.g. `0.49.0` | never |
| `edge` | every push to `main` |
| `sha-<short>` | never |

`linux/amd64` and `linux/arm64`. Each architecture bakes in the Harness tarball
for *that* architecture, so the two cannot be cross-built.

The image carries `ai.actana.image.role=development-fixture` as a label, in
case you want to assert on it.

## Links

- [Source](https://github.com/actana/control) · [Installing a real Core](https://github.com/actana/control/blob/main/INSTALL.md) · [Security policy](https://github.com/actana/control/blob/main/SECURITY.md)
- Also published as `ghcr.io/actana/core`

MIT licensed. A derivative work of Mission Control by AgentSystem Labs — see
[NOTICE](https://github.com/actana/control/blob/main/NOTICE).
