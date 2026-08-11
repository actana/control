# Actana Panel — pre-merge builds

**Not a release. Do not deploy this.**

This repository holds the Panel image built from open pull requests on
[actana/control](https://github.com/actana/control), so a reviewer can *run* a
change instead of reading it. The released Panel is
[`actana/panel`](https://hub.docker.com/r/actana/panel).

Nothing here has been through a release: it has not been approved by a person,
it may carry a failing CVE scan, and it may not work at all. That is the point
— the image you most need to pull and inspect is often the one that failed a
check.

## Tags

| Tag | What it is |
| --- | --- |
| `pr-<number><YYYYMM>` | the current state of pull request `<number>`. **Moves on every push.** The six-digit month suffix is fixed-width, so the pull request id reads off the front |
| `sha-<short>` | one commit on a release train, pinned forever — the handle to reach for when a beta misbehaves |
| `pr-<number>-<arch>` | build scaffolding, not a tag to pull. The per-architecture halves of an image before its manifest is stitched |

`pr-*` images are **amd64 only**. Anything an operator deploys is multi-arch and
built natively; a pull request image is a developer poking at a change, and
emulation is fine for that.

## Running one

Find the tag on the pull request itself — the `Panel image` check announces the
mode it took and the tag it pushed. Then:

```bash
docker run -d --name actana-panel-pr \
  -p 127.0.0.1:7421:7420 \
  -v actana-panel-pr-data:/data \
  actana/panel-dev:pr-116202608
```

Port 7421 and a throwaway volume, deliberately: a pre-merge Panel is not
something to point your real data directory at, and a schema migration in an
unmerged branch is under no obligation to be reversible. Delete the volume when
you are done reviewing.

To bring one up beside a Core with the reference compose, add the
dev-images override rather than editing the compose file:

```bash
cd deploy
ACTANA_TAG=pr-116202608 docker compose \
  -f docker-compose.yml -f docker-compose.dev-images.yml up -d
```

The override file swaps both repositories to `-dev`; `ACTANA_TAG` moves both
services. Panel and Core are version-locked, so move both or neither — see
[`deploy/README.md`](https://github.com/actana/control/blob/main/deploy/README.md).

## Why these are not in `actana/panel`

Two reasons, and the second is the one that matters.

The `actana/panel` page exists to be presentable, and filling its tag list with
hundreds of `pr-*` names undoes that. More importantly, deleting tags needs a
delete-capable credential, and keeping that credential's blast radius away from
the repositories holding `:latest` is a design constraint rather than a
preference: Docker Hub personal access tokens carry an account-wide permission
level, not a repository list, so a hard-coded allowlist of these two `-dev`
repositories is the only guard there is.

A separate repository also means a wrong-repository pull cannot happen by
accident. `actana/panel:latest` is never a pre-merge build, whatever anybody
types.

## No image for a fork's pull request

Fork pull requests build the image and smoke it, but publish nothing. GitHub
does not expose repository secrets to a workflow run triggered by a fork, by
design, and the alternative — `pull_request_target`, which would run with
secrets against contributor-authored code — is rejected outright: the
credential it would expose can push `:latest` and rewrite both public image
pages.

So **the pull request image is a maintainer convenience, not a contributor
one.** A green check with no image behind it is expected on a fork, not a bug.

## Housekeeping

Tags are swept weekly. A pull request's images go when it closes, last month's
`pr-` tag goes when the month rolls, and everything unclaimed expires at 30
days. `sha-<short>` pins expire on the same 30-day clock — they are a debugging
handle, not an archive. Tags that are none of those three shapes are left
alone and reported rather than deleted.

## What to pull instead

| You want | Pull |
| --- | --- |
| the current release | `actana/panel:latest` |
| a specific release | `actana/panel:<version>` |
| the next release, for testing | `actana/panel:beta-<version>` |

`beta-<version>` is the one to reach for if you are here because you want to
try what is about to ship. It is a real multi-arch build of a release train,
and it is the exact digest that promotion re-points at `<version>` and
`:latest` — nothing is rebuilt in between. See
[`docs/ci-cd.md`](https://github.com/actana/control/blob/main/docs/ci-cd.md).
