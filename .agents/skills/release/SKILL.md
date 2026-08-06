---
name: release
description: Cut an Actana Control release. One version tag, pushed on its own, is the whole procedure — it fires release.yml, which builds both Core tarballs and both container images and creates the GitHub Release. The procedure itself lives in docs/ci-cd.md § "Cutting a release"; this skill is the pointer to it plus the two rules that are expensive to learn by doing.
---

# Release

Read [`docs/ci-cd.md` § "Cutting a release"](../../../docs/ci-cd.md#cutting-a-release)
before you do anything. It is short, it sits next to the rest of the pipeline it
describes, and it is the only account of a release that is kept in step with
[`.github/workflows/release.yml`](../../../.github/workflows/release.yml).

The whole of it, once the tree is where you want it:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

(`origin` in a fresh clone; `git remote -v` for what this checkout calls it.)

## Two rules

**Push the one tag, never `git push --tags`.** A clone taken from the fork
parent carries that project's tags. Pushing them all fires a release run per
tag, for versions this repository never made. See
[`docs/REPO_SETUP.md`](../../../docs/REPO_SETUP.md) §6.

**The tag *is* the release.** There is no second step you run afterwards: the
push builds the artifacts, moves `:latest` on both images and creates the GitHub
Release. Nothing here rolls that back — a bad release is fixed by tagging the
next version, never by moving or deleting a published tag.

Watch the run rather than assuming it: `github-release` waits on the arm64
`installer-e2e` legs and the image jobs do not, so a red installer leg leaves
both images published with no GitHub Release beside them.

## What the tag decides

`release.yml` takes the version from the tag ref and nothing else — no
`package.json` bump is required first, and no job checks the two against each
other. A prerelease tag (`v1.0.0-rc.1`) publishes its own image tag and
deliberately does not move `:latest`.
