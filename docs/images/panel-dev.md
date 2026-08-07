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

Tags are swept weekly: a pull request's images go when it closes, last month's
go when the month rolls, and `sha-*` pins expire after 30 days.

## What to pull instead

| You want | Pull |
| --- | --- |
| the current release | `actana/panel:latest` |
| a specific release | `actana/panel:<version>` |
| the next release, for testing | `actana/panel:beta-<version>` |
