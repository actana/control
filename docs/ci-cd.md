# CI/CD

What runs, when, and what it publishes. Admin-side setup (secrets, required
checks, labels) lives in [`REPO_SETUP.md`](REPO_SETUP.md).

## At a glance

| Workflow | Trigger | Produces |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | every PR, push to `main` | nothing — it gates |
| [`conventions.yml`](../.github/workflows/conventions.yml) | every PR | nothing — it gates |
| [`images-edge.yml`](../.github/workflows/images-edge.yml) | push to `main` | `:edge`, `:sha-<short>` |
| [`images-release.yml`](../.github/workflows/images-release.yml) | `v*` tag | `:<version>`, `:latest` |
| [`harness-release.yml`](../.github/workflows/harness-release.yml) | `v*` tag | Harness tarballs + checksums |
| [`dockerhub-description.yml`](../.github/workflows/dockerhub-description.yml) | `docs/images/**` on `main` | each image's Docker Hub page |
| [`stale.yml`](../.github/workflows/stale.yml) | daily cron | stale labels / closures |
| [`react-doctor.yml`](../.github/workflows/react-doctor.yml) | see the file | a report |

Both container images have **one** build implementation:
[`container-image.yml`](../.github/workflows/container-image.yml), a reusable
workflow called by the PR, edge, and release paths with `image: panel` or
`image: core`. That is deliberate — the bytes a PR validates are built exactly
the way the bytes a release publishes are, rather than by a lookalike pipeline
that drifts.

## The published images

| Image | What it is |
| --- | --- |
| `actana/panel` | The Panel web service. **This is the one you deploy.** |
| `actana/core` | The dev Core-in-a-box. **A development fixture, not a deployment.** |

Both are published to GHCR (`ghcr.io/actana/…`) and Docker Hub
(`docker.io/actana/…`) under the same tags.

`actana/core` deserves the warning it carries. It is `deploy/dev`'s
Core-in-a-box: systemd as PID 1 (so it needs `--privileged` and the host
cgroup), passwordless sudo for the `operator` user, linger baked into the
image, and a first-boot script that hardcodes `--public-host core` — it only
pairs when it is reachable at the hostname `core`. It exists so you can try the
real pairing flow on one machine with nothing but Docker. The image carries
`ai.actana.image.role=development-fixture` and an OCI description saying so.

**To run a real Core, install the Harness on a machine you own** — see
[`../INSTALL.md`](../INSTALL.md). There is no supported container deployment of
a Core.

### Where each registry's description comes from

The two registries work differently, and neither reads a README from GitHub on
its own:

- **GHCR** links a package to its repository through the
  `org.opencontainers.image.source` label, and then shows **this repository's
  README** on the package page. There is no per-package README, so both images
  show the same project README; the only per-image text is the
  `org.opencontainers.image.description` label. Both images set these labels at
  build time.
- **Docker Hub** ignores those labels and stores its own per-repository
  description, set through its API. [`dockerhub-description.yml`](../.github/workflows/dockerhub-description.yml)
  pushes one file per image — [`docs/images/panel.md`](images/panel.md) and
  [`docs/images/core.md`](images/core.md) — whenever either changes on `main`.

Edit those two files to change what Docker Hub shows. The sync needs its own
credential (`DOCKERHUB_DESCRIPTION_*`), because the API endpoint it uses
rejects organization access tokens; see [`REPO_SETUP.md`](REPO_SETUP.md) §2.

## The release artifacts

The product ships as three things, on two pipelines, from the same tag:

- **The Panel** is a container. `images-release.yml` → `ghcr.io/actana/panel`
  (and Docker Hub, when configured). No installer, no signing — the image is
  the release artifact ([ADR 0010](adr/0010-panel-becomes-a-self-hosted-web-service.md)).
- **The dev Core** is a container from the same workflow → `ghcr.io/actana/core`.
- **The Harness** — the thing a real Core actually runs — is a per-platform
  tarball. `harness-release.yml` → four targets (`mac-arm64`, `mac-x64`,
  `linux-x64`, `linux-arm64`) with published checksums, which `install.sh` and
  `actana update` verify against.

The Panel and the Harness are version-locked at runtime: the core-link
handshake exchanges a protocol version, and a mismatched pair renders as "needs
update" in the Panel. So tag both together — a `v*` tag fires both workflows.

## Container image tags

| Tag | Moves | Use it for |
| --- | --- | --- |
| `:latest` | on every non-prerelease version tag | the default; what the reference compose pulls |
| `:<version>` e.g. `:0.49.0` | never | pinning a deployment |
| `:edge` | on every push to `main` | trying what is about to ship |
| `:sha-<short>` | never | pinning to an exact commit, e.g. to bisect |

A prerelease tag (`v1.0.0-rc.1`) publishes `:1.0.0-rc.1` and deliberately does
**not** move `:latest`.

## Architectures

Every published image is a multi-arch manifest over `amd64` and `arm64`, and
each architecture is built on a **native runner** of its own kind. Neither
image could be cross-built honestly: the Panel compiles `better-sqlite3` during
its build, and the Core bakes in the Harness tarball for that architecture.
Emulating either under QEMU is both slow and a test of the wrong machine.

The PR build is `amd64` only. Paying for a second runner on every PR buys
little: the two legs share one Dockerfile, and the arch-specific failure mode
is almost always the native build, which the `amd64` leg already exercises.

## The smoke test is the acceptance criterion

No image is pushed before it passes a smoke test against those exact bytes.

**Panel** — [`scripts/smoke-panel-image.mjs`](../scripts/smoke-panel-image.mjs)
boots the container on a fresh volume, walks the operator's first day over HTTP
(first boot wants setup → setup creates the Operator), then **destroys the
container and recreates it on the same volume** and proves the Panel still
knows its Operator. That last step is the whole "all state in one directory"
claim stated as a test. Run it locally with `pnpm panel:image:smoke`.

**Core** — systemd is PID 1 in that image, so CI cannot boot it without
`--privileged` and a cgroup mount. The smoke overrides the command and checks
the two things a build can actually get wrong: the *architecture-matched*
Harness tarball landing in `/opt/harness`, and the first-boot provision unit
being enabled. Booting it for real is what `deploy/dev/docker-compose.yml` is
for, and the `E2E — Panel against Core-in-a-box` job in `ci.yml` covers that
seam.

## Registries

**GHCR always.** It authenticates with the workflow's own `github.token`, which
GHCR accepts for packages owned by this repository. No secret to configure, and
it works in forks.

**Docker Hub additionally**, whenever the `DOCKERHUB_TOKEN` secret is set. Every
Docker Hub step is individually gated on that secret being non-empty, so:

- With the keys set → the same manifest is published to both registries.
- Without them → the run publishes to GHCR alone and still succeeds.
- With the keys set but **wrong** → GHCR is published *completely* (per-arch
  tags and manifests), Docker Hub is skipped, and the run then fails with an
  annotation naming the cause. A misconfigured mirror must not cost you the
  primary registry, but nor should it pass silently.

If you see `unauthorized: incorrect username or password`, the cause is almost
always that `DOCKERHUB_USERNAME` does not match the *kind* of token in
`DOCKERHUB_TOKEN`. The two kinds authenticate as different principals:

| Token | Created at | `DOCKERHUB_USERNAME` must be |
| --- | --- | --- |
| **Organization access token (OAT)** | the org — `app.docker.com/accounts/<org>` → Identity & authentication | **the organisation name** (`actana`) |
| **Personal access token (PAT)** | your own Account settings → Personal access tokens | **your own username** (e.g. `qcenticadm`) |

An OAT authenticates *as the organisation*, not as the person who created it —
pairing an OAT with a personal username is rejected. OATs also require a Docker
**Team or Business** subscription; on a free org they cannot be used at all, and
a PAT belonging to a member with push rights is the way in.

An account password never works in place of a token.

That gating is what lets a fork — or this repo before the keys were added —
build and release without a Docker Hub account. Adding the keys is a settings
change, not a code change; see [`REPO_SETUP.md`](REPO_SETUP.md) §2.

The image name is derived, never hardcoded: `ghcr.io/<repo owner>/panel`,
and `docker.io/<DOCKERHUB_NAMESPACE or repo owner>/panel`. A fork
publishes under its own namespace with no edit to any workflow.

## Cutting a release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

That fires `images-release.yml` and `harness-release.yml` in parallel. If a
release needs rebuilding, both workflows accept a `workflow_dispatch` with the
tag name — the tag must already exist on origin.

Push one tag deliberately, never `git push --tags` — a clone made from the fork
parent carries tags that would fire both workflows for releases this repository
never made; see [`REPO_SETUP.md`](REPO_SETUP.md) §6.

## Running CI locally

The four checks that gate every PR:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm scan:secrets
```

The container build:

```bash
pnpm panel:image:smoke      # builds the Dockerfile, then smokes it
```

Commit conventions, without installing anything permanently:

```bash
d=$(mktemp -d) && cp commitlint.config.mjs "$d"
(cd "$d" && npm init -y >/dev/null && npm install @commitlint/cli @commitlint/config-conventional)
"$d"/node_modules/.bin/commitlint --config "$d"/commitlint.config.mjs \
  --cwd "$PWD" --from origin/main --to HEAD --verbose
```

The detour through a temp directory is not ceremony: this is a pnpm workspace,
and the root `package.json` declares `workspace:*` dependencies that npm
refuses to parse (`EUNSUPPORTEDPROTOCOL`). Installing outside the checkout —
with the config copied alongside, so `extends` still resolves — is what the
Conventions workflow itself does.

## Notes for forks

Everything works in a fork with no configuration: GHCR uses the fork's own
token and namespace, Docker Hub steps skip, and the PR build never pushes.

PRs *from* a fork run without repository secrets — so `DOCKERHUB_TOKEN` is
empty there and the publishing steps skip. That is expected, not a failure.
