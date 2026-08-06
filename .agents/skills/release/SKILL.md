---
name: release
description: Cut an Actana Control release. Pushing one version tag fires release.yml, which builds the three Core tarballs and both container images — but the run pauses on a human approval for the macOS leg, and nothing publishes until someone approves it on a real Mac. The procedure lives in docs/ci-cd.md § "Cutting a release"; this skill is the pointer to it, the two rules that are expensive to learn by doing, and the preconditions the workflow does not check for you.
---

# Release

Read [`docs/ci-cd.md` § "Cutting a release"](../../../docs/ci-cd.md#cutting-a-release)
before you do anything. It is short, it sits next to the rest of the pipeline it
describes, and it is the only account of a release that is kept in step with
[`.github/workflows/release.yml`](../../../.github/workflows/release.yml).

## Before you push the tag

Three things the workflow will not check for you. The first two are why a
release fails or publishes something it shouldn't; the third is why it hangs.

- **CI is green on the commit you are tagging.** There is no gate job reading
  the tagged commit's check runs. A tag on a red commit builds and publishes
  exactly like a tag on a green one.
- **`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` exist as repo secrets.**
  `release.yml`'s `resolve` job fails the whole run outright when either is
  missing on `actana/control` — before anything is built. See
  [`docs/REPO_SETUP.md`](../../../docs/REPO_SETUP.md) §1.
- **The `macos-release` environment exists, with required reviewers on it.**
  Check with `gh api repos/actana/control/environments --jq
  '.environments[].name'`. If it is absent, GitHub auto-creates an unprotected
  one on first use, so the run does **not** fail — it publishes the whole
  release with no review at all, silently. `REPO_SETUP.md` §2.

Then, once the tree is where you want it:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

(`origin` in a fresh clone; `git remote -v` for what this checkout calls it.)

## The tag starts the release; a person finishes it

The push is not the whole procedure. `release.yml`'s `tarball-macos` job
declares `environment: macos-release`
([release.yml](../../../.github/workflows/release.yml), the `tarball-macos`
job), so the run enters **waiting** within seconds and stays there until a
required reviewer approves it in the run's UI.

**Everything a release publishes sits downstream of that approval** — the
`panel` and `core` images and their `:latest`, both Docker Hub description
pages, the GitHub Release and its four assets. While the run waits, only the
Linux tarball legs and the installer e2e run, and neither publishes anything.

So an agent or a person who pushes a tag and watches for a GitHub Release will
see the run sit at 60–70% indefinitely. **That is not a hang.** Open the run,
look for a job in `Waiting`, and go find the reviewer. The approval is a real
ten-minute manual test on Apple hardware, not a click:
[`docs/core-macos-prerelease-checklist.md`](../../../docs/core-macos-prerelease-checklist.md)
is what they work through, and rejecting is a supported outcome — it stops the
release entirely, and the fix ships in the next tag.

Full account, including what the reviewer does:
[`docs/ci-cd.md` § "The approval pause"](../../../docs/ci-cd.md#the-approval-pause--a-release-waits-for-a-person).

## Two rules

**Push the one tag, never `git push --tags`.** A clone taken from the fork
parent carries that project's tags. Pushing them all fires a release run per
tag, for versions this repository never made. See
[`docs/REPO_SETUP.md`](../../../docs/REPO_SETUP.md) §6.

**A published release is never unpublished.** Once the approval lands, the run
moves `:latest` on both images and creates the GitHub Release. Nothing here
rolls that back — an image push is not undoable and `:latest` has no history —
so a bad release is fixed by tagging the next version, never by moving or
deleting a published tag. The approval pause is the last point at which "no"
is still cheap.

## What the tag decides

`release.yml` takes the version from the tag ref and nothing else — no
`package.json` bump is required first, and no job checks the two against each
other. A prerelease tag (`v1.0.0-rc.1`) publishes its own image tag and
deliberately does not move `:latest`.

A tag builds **three** Core tarballs — `linux-x64`, `linux-arm64` and
`mac-arm64` — and publishes four assets, the fourth being the `SHA256SUMS` over
them. The count is load-bearing rather than descriptive: the `github-release`
job runs `compose-core-shasums.mjs --expect 3` and then hard-fails unless
exactly four files are present, so a missing architecture is a red release
rather than a checksum file that quietly covers part of one.

## When a run goes red instead of waiting

- **Red before anything builds** — a missing Docker Hub secret; `resolve` says so.
- **Red on `installer-e2e`** — the arm64 one-liner could not install the tarball
  it just built. `github-release` needs it, so no assets are attached. The
  images are unaffected either way: they are behind the mac approval, not
  behind this leg.
- **Nothing red, nothing finishing** — an unapproved `tarball-macos`. See above.
