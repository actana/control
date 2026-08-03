# CI/CD

What runs, when, and what it publishes. Admin-side setup (secrets, required
checks, labels) lives in [`REPO_SETUP.md`](REPO_SETUP.md).

## At a glance

| Workflow | Trigger | Produces |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | every PR, push to `main` | nothing — it gates |
| [`conventions.yml`](../.github/workflows/conventions.yml) | every PR | nothing — it gates |
| [`panel-edge.yml`](../.github/workflows/panel-edge.yml) | push to `main` | `:edge`, `:sha-<short>` |
| [`panel-release.yml`](../.github/workflows/panel-release.yml) | `v*` tag | `:<version>`, `:latest` |
| [`harness-release.yml`](../.github/workflows/harness-release.yml) | `v*` tag | Harness tarballs + checksums |
| [`stale.yml`](../.github/workflows/stale.yml) | daily cron | stale labels / closures |
| [`react-doctor.yml`](../.github/workflows/react-doctor.yml) | see the file | a report |

The Panel image has **one** build implementation:
[`panel-image.yml`](../.github/workflows/panel-image.yml), a reusable workflow
called by the PR, edge, and release paths. That is deliberate — the bytes a PR
validates are built exactly the way the bytes a release publishes are, rather
than by a lookalike pipeline that drifts.

## The two release artifacts

The product ships as two different things, on two different pipelines, from the
same tag:

- **The Panel** is a container. `panel-release.yml` → `ghcr.io/actana/actana-panel`
  (and Docker Hub, when configured). No installer, no signing — the image is
  the release artifact ([ADR 0010](adr/0010-panel-becomes-a-self-hosted-web-service.md)).
- **The Harness** is a per-platform tarball. `harness-release.yml` → four
  targets (`mac-arm64`, `mac-x64`, `linux-x64`, `linux-arm64`) with published
  checksums, which `install.sh` and `actana update` verify against.

They are version-locked at runtime: the core-link handshake exchanges a
protocol version, and a mismatched pair renders as "needs update" in the Panel.
So tag both together — a `v*` tag fires both workflows.

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
each architecture is built on a **native runner** of its own kind — the image
compiles `better-sqlite3` during the build, and emulating that under QEMU is
both slow and a test of the wrong machine.

The PR build is `amd64` only. Paying for a second runner on every PR buys
little: the two legs share one Dockerfile, and the arch-specific failure mode
is almost always the native build, which the `amd64` leg already exercises.

## The smoke test is the acceptance criterion

No image is pushed before
[`scripts/smoke-panel-image.mjs`](../scripts/smoke-panel-image.mjs) passes
against those exact bytes. It boots the container on a fresh volume, walks the
operator's first day over HTTP (first boot wants setup → setup creates the
Operator), then **destroys the container and recreates it on the same volume**
and proves the Panel still knows its Operator.

That last step is the whole "all state in one directory" claim stated as a
test. Run it locally with `pnpm panel:image:smoke`.

## Registries

**GHCR always.** It authenticates with the workflow's own `github.token`, which
GHCR accepts for packages owned by this repository. No secret to configure, and
it works in forks.

**Docker Hub additionally**, whenever the `DOCKERHUB_TOKEN` secret is set. Every
Docker Hub step is individually gated on that secret being non-empty, so:

- With the keys set → the same manifest is published to both registries.
- Without them → the run publishes to GHCR alone and still succeeds.

That gating is what lets a fork — or this repo before the keys were added —
build and release without a Docker Hub account. Adding the keys is a settings
change, not a code change; see [`REPO_SETUP.md`](REPO_SETUP.md) §2.

The image name is derived, never hardcoded: `ghcr.io/<repo owner>/actana-panel`,
and `docker.io/<DOCKERHUB_NAMESPACE or repo owner>/actana-panel`. A fork
publishes under its own namespace with no edit to any workflow.

## Cutting a release

```bash
git tag v0.50.0 && git push origin v0.50.0
```

That fires `panel-release.yml` and `harness-release.yml` in parallel. If a
release needs rebuilding, both workflows accept a `workflow_dispatch` with the
tag name — the tag must already exist on origin.

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
npm install --no-save @commitlint/cli @commitlint/config-conventional
npx commitlint --from origin/main --to HEAD --verbose
```

## Notes for forks

Everything works in a fork with no configuration: GHCR uses the fork's own
token and namespace, Docker Hub steps skip, and the PR build never pushes.

PRs *from* a fork run without repository secrets — so `DOCKERHUB_TOKEN` is
empty there and the publishing steps skip. That is expected, not a failure.
