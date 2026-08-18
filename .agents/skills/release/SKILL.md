---
name: release
description: Cut an Actana Control release. A release is a promotion of a train, not a tag push — promote.yml is dispatched against beta/x.y.z, its first job waits on a human, and the digest check, the fast-forward of main, the tag, release.yml and the npm publish are all downstream of that approval. The procedure lives in docs/ci-cd.md § "Cutting a release"; this skill is the pointer to it, the two rules that are expensive to learn by doing, the preconditions no workflow checks for you, and the places ADR 0023 and the workflows do not agree.
---

# Release

Read [`docs/ci-cd.md` § "Cutting a release"](../../../docs/ci-cd.md#cutting-a-release)
before you do anything. It is short, it sits next to the rest of the pipeline it
describes, and it is the only account of a release that is kept in step with
[`promote.yml`](../../../.github/workflows/promote.yml) and
[`release.yml`](../../../.github/workflows/release.yml).

**A release is a promotion, not a tag push.** Since
[ADR 0023](../../../docs/adr/0023-release-trains-and-digest-promotion.md) the
entry point is a dispatch on `promote.yml` naming the train branch:

```bash
gh workflow run promote.yml --repo actana/control -f train=beta/0.1.0
```

Pushing `v0.1.0` by hand does nothing at all. `release.yml` has no `push: tags`
trigger and is reached by `workflow_call` from `promote.yml` (D40) — the tag is
pushed by the promotion, as a record, *after* the fast-forward and *before* the
call. Keeping a tag trigger beside the `workflow_call` would fire two release
runs for one promotion that could not even block each other, because
`github.ref_name` is the tag under a tag push and the caller's ref under a
`workflow_call`, so the two would take different concurrency keys and race to
build the same tarballs and create the same Release.

The by-hand entry point that does exist is `release.yml`'s own dispatch —
`gh workflow run release.yml -f tag=v0.1.0`. It re-runs a whole release, and it
is the only way a backport releases at all. It is not how a normal release
starts. See
[`docs/ci-cd.md` § "What `release.yml` does with the tag"](../../../docs/ci-cd.md#what-releaseyml-does-with-the-tag).

## Before you dispatch the promotion

Things no workflow will check for you.

- **The promotion pull request is open, green and approved, and it
  fast-forwards.** `beta/x.y.z` into `main`, and **do not press the merge
  button** — a squash produces a `main` commit whose SHA differs from the
  tested one, which is exactly what the digest assertion cannot survive. GitHub
  closes the pull request as merged on its own once the fast-forward makes its
  commits reachable.
- **The train has actually been accepted.** The `beta-x.y.z` images were
  pulled and worked through
  [`beta-acceptance-checklist.md`](../../../docs/beta-acceptance-checklist.md),
  and the macOS checklist was worked against the **train tip** — see the pause
  section below.
- **`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` exist as repo secrets.**
  `release.yml`'s `resolve` job fails the whole run outright when either is
  missing on `actana/control` — before anything is built. See
  [`docs/REPO_SETUP.md`](../../../docs/REPO_SETUP.md) §1.
- **`NPM_TOKEN` exists as a repo secret.** Since
  [#159](https://github.com/actana/control/issues/159) a release also publishes
  `@actana/sdk` and `@actana/cli` to npm, and `resolve` fails the whole run when
  the token is missing — in the same place and the same shape as the Docker Hub
  check, before anything is built. `REPO_SETUP.md` §2.
- **The `macos-release` environment exists, with required reviewers on it.**
  Check with `gh api repos/actana/control/environments --jq
  '.environments[].name'`. If it is absent, GitHub auto-creates an unprotected
  one on first use, so the run does **not** fail — the promotion waves itself
  through unattended and green, with no review at all. `REPO_SETUP.md` §2.

Note where that last one now bites. The environment is consumed by
`promote.yml`, not by `release.yml`, so a missing environment no longer means
"a release published without review" — it means **`main` fast-forwarded without
review**, and everything else followed from there.

## Where `macos-release` sits

On `promote.yml`'s `pause` job: the first job in that file, and the only job in
either workflow that declares an environment (D15).

It used to sit on `release.yml`'s `tarball-macos` leg. It does not any more, and
`release.yml` names it only in comments explaining the removal. The move is not
cosmetic. With the pause at the head of `promote.yml`, **the fast-forward is
downstream of the human as well**, so `main` never contains unapproved code —
where the old shape already had the commit on `main` by the time anybody was
asked.

**Exactly one pause exists.** A second one appearing anywhere would be
invisible in a green run: it would look like a release nobody had got round to
approving yet.

## The dispatch starts a promotion; its first job is a person

`pause` declares `environment: macos-release` and does nothing else of
consequence, so the run enters **waiting** within seconds of the dispatch and
stays there until a required reviewer approves it in the run's UI.

**Nothing has happened yet when it waits.** No digest is verified, `main` does
not advance, no tag is pushed, `release.yml` is never called — so no image
moves, no `:latest` moves, no package reaches npm, and no GitHub Release
appears. The old shape published everything downstream of the approval; this
shape *decides* everything downstream of it, and that is the difference that
makes "reject" a real answer.

So a promotion run that sits at its first job is **not a hang**, and it no
longer sits at 60–70% — there is nothing else running beside it. Open the run,
look for `Approve the promotion` in `Waiting`, and go find the reviewer.

The approval is the end of a real manual test, not a click. Before dispatching,
the reviewer works
[`docs/core-macos-prerelease-checklist.md`](../../../docs/core-macos-prerelease-checklist.md)
on real Apple hardware — against the **train tip**, which by the digest
assertion is the same commit this promotes and is available to them earlier
than a tag that does not exist yet. Rejecting is a supported outcome: it stops
the promotion entirely, before `main` moves.

One consequence of putting a gate first: the train name is validated *inside*
`pause`, after the approval, because a job with an `environment:` blocks before
its first step runs and anything upstream of the pause would be a job `main` is
not protected from. A typo'd train name therefore costs one approval click and
then fails immediately and loudly. That is the cheaper side of the trade.

Full account, including what the reviewer does:
[`docs/ci-cd.md` § "The approval pause"](../../../docs/ci-cd.md#the-approval-pause--a-release-waits-for-a-person)
and [§ "Promotion"](../../../docs/ci-cd.md#promotion).

## Cutting a train by hand skips the version stamp

The sanctioned cut is what writes the version. `promote.yml`'s `next-train` job
creates `beta/x.y.z` from `main` and, in the same commit, rewrites the version
in **all six manifests** — `package.json`, `packages/cli`, `packages/core`,
`packages/panel`, `packages/sdk`, `packages/shared`. That commit *is* the
stamp, and it is the only thing that produces one. Its subject is
`chore(release): cut beta/x.y.z`, and it is Conventional Commits on purpose:
the commit reaches `main` through the next promotion pull request, where
`ci.yml`'s `Conventions` job lints every commit in it, not just the title.

`git branch beta/0.3.2 main && git push -u origin beta/0.3.2` produces a branch
that looks right and carries no stamp. Every manifest still reads the previous
train's version.

Nothing goes red at that moment, which is the trap. `Train rules` is
`if: github.event_name == 'pull_request'`, so a hand-cut train sits green and
empty until somebody opens the first pull request into it — and then
`assert_versions` compares each manifest against the version in the branch name
and calls `fail` once per manifest. **Six errors, one per manifest**, on the
pull request of whoever happened to be first, who did not cut the branch and
has no reason to connect the two. This has already cost a train an hour.

The count is the tell: **six errors is a missing stamp; one is real drift in one
file.** The fix is not to hand-edit the six files back — hand-editing them is
the failure mode D3 exists to prevent. Delete the branch and let a promotion cut
it, or reproduce the cut commit exactly: the same version rewritten in the same
six manifests, as one commit, with the subject above.

There is no workflow you can dispatch to do this for you. See "Where ADR 0023
and the workflows disagree" below.

## Two rules

**Never `git push --tags`.** A clone taken from the fork parent carries 102 of
that project's tags, for versions this repository never made. It no longer
fires a release run per tag — `release.yml` has no tag trigger, and a stray
`v*` tag now does nothing at all (D40) — but pushing them re-imports the
upstream history into a repository that was squashed on purpose, and they sort
above `0.1.0`, so `git describe` reports a version this product has never
released. [`docs/REPO_SETUP.md`](../../../docs/REPO_SETUP.md) §6 is current on
this and says how to clear them.

**A published release is never unpublished.** Once the approval lands, the run
fast-forwards `main`, moves `:latest` on both images, publishes the npm
packages, and creates the GitHub Release. Nothing here rolls that back — an
image push is not undoable and `:latest` has no history — so a bad release is
fixed by promoting the next version, never by moving or deleting a published
tag. The approval pause is the last point at which "no" is still cheap.

**npm is stricter than that, and it is the one irreversibility with no
workaround at all.** A container tag can at least be re-pointed at better bytes.
An npm version number is consumed by its first publish: unpublishing inside the
72-hour window frees the bytes and not the name, so `@actana/sdk@0.2.2` can
never mean anything else, and the recovery from a bad publish is to burn the
next version too. This is why the `npm` job is last in the graph — nothing is
burned until every other gate has passed — and why `pnpm npm:rehearse` exists:
run it locally, on any branch, before a promotion is anywhere near the picture.
It packs and asserts the real tarballs and publishes nothing.

## What the tag decides

`release.yml` takes the version from `inputs.tag` and nothing else — never from
`github.ref_name`, which resolves differently depending on how the workflow was
entered. The concurrency key is derived from the input for the same reason
(D40). The tag must already exist on origin; the promotion pushes it before
calling.

No job reads a `package.json`. That is not the same as "the manifests do not
matter": on the promote path they already carry the version, because the cut
wrote all six and `Train rules` asserted them on every pull request into the
train. `release.yml` does not re-check what the branch model has already
guaranteed.

A prerelease tag (`v1.0.0-rc.1`) publishes its own image tag and deliberately
does not move `:latest`.

A release builds **three** Core tarballs — `linux-x64`, `linux-arm64` and
`mac-arm64` — and publishes four assets, the fourth being the `SHA256SUMS` over
them. The count is load-bearing rather than descriptive: the `github-release`
job runs `compose-core-shasums.mjs --expect 3` and then hard-fails unless
exactly four files are present, so a missing architecture is a red release
rather than a checksum file that quietly covers part of one.

## When a run goes red instead of waiting

- **Red immediately after the approval** — a train name that is not
  `beta/x.y.z`. `pause` validates its input after the gate, because there is no
  "before".
- **Red on `verify`** — the digest assertion (D16): `beta-x.y.z` was not built
  from the commit being promoted. Usually a train merge whose image build went
  red, or a merge that landed after the acceptance run. Nothing has been
  published; `main` has not moved.
- **Red on `advance`** — something moved `main` while the promotion was
  running, so the fast-forward is no longer possible. A squash is not the
  fallback (D5); the train needs re-cutting from `main`.
- **Red before anything builds, inside `release.yml`** — a missing Docker Hub
  or npm secret; `resolve` says so. By this point `main` has already advanced
  and the tag exists, so recovery is `gh workflow run release.yml -f tag=vx.y.z`
  once the secret is there, not a re-run of the promotion.
- **Red on `installer-e2e`** — the arm64 one-liner could not install the tarball
  it just built. `github-release` needs it, so no assets are attached.
- **Nothing red, nothing finishing** — `pause` is waiting for a reviewer. That
  is the first job now, not a macOS leg two thirds of the way in.

## Where ADR 0023 and the workflows disagree

This file describes what the workflows do today. One place where the ADR and
the workflows genuinely disagree, and one where D3's headline number looks like
a disagreement and is not:

**D3's opening sentence says four manifests. The set is six — and D3 says so
itself, a few lines further down.** The clause opens "all four manifests —
root, `packages/core`, `packages/panel`, `packages/shared`", and that sentence
has never been rewritten. What sits directly under it has: D3 is amended twice,
by [#152](https://github.com/actana/control/issues/152), which added
`packages/sdk` as the fifth when the core-link frames moved out of
`packages/shared`, and by [#157](https://github.com/actana/control/issues/157),
which added `packages/cli` as the sixth. Both `promote.yml`'s cut and `ci.yml`'s
`Train rules` carry the six-entry list and annotate it "as amended by #152 and
#157", and [`docs/ci-cd.md` § "Cutting a train"](../../../docs/ci-cd.md#cutting-a-train)
already says six. So the number is stale, not uncorrected — and stale by
design: D3 asks you to read its count as "derived rather than declared", says
the next package "does not need to amend this clause to stay correct" because
`Train rules` asserts the list covers every workspace package, and calls the
written number documentation against the assertion in `ci.yml` as the
mechanism. **Read the count off `${#MANIFESTS[@]}` in `ci.yml`, never off D3's
first sentence** — which is what D3 asks for too.

**D3 says "a workflow does it" — and there is no workflow you can dispatch to
cut a train.** The only sanctioned cut is `promote.yml`'s `next-train` job,
which runs automatically after a promotion and skips itself when a train
already exists (D25). D25 and `docs/ci-cd.md` both tell an administrator to
"delete and re-cut" a train whose guessed version is wrong — the guess is
`beta/<next-minor>.0`, a default and not a commitment — and neither names a
mechanism, because there is not one: nothing in `.github/workflows/` cuts a
train on dispatch. That gap is what the hand-cut trap above is made of, and it
is worth knowing before you go looking for the button.
