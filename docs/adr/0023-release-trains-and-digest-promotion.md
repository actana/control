# Release trains and digest promotion

ADR 0016 shipped a trunk-based release: every merge to `main` published `:edge` and `:sha-<short>`, and a `v*` tag rebuilt those bytes and published `:<version>` + `:latest`. The two-stage shape was already there — `edge` then `v*` — but the second stage *rebuilt*. So the image an operator ran had never been run by anyone: a fresh `pnpm install`, a base image that had moved since the PR, a `better-sqlite3` compiled on a different day. "We tested it" was true of a build, not of the bytes.

**This ADR replaces the trunk with a release train, and replaces the release build with a retag.** Work flows through one `beta/x.y.z` branch at a time; every merge to it publishes a testable multi-arch image; a person pulls that image, runs it, and approves; promotion then **fast-forwards `main` and re-points the existing digest** at `x.y.z` and `latest`. Nothing is rebuilt between the thing that was approved and the thing that ships. Separately, every pull request publishes its own image so a change can be run before it is merged at all.

The cost is a second branch class, a promotion workflow, a GitHub App identity, and a code freeze during each approval window. The property bought is narrow and worth naming precisely: **from `beta-x.y.z` to `x.y.z` the bytes are identical, and the pipeline refuses to proceed when they are not.** It does not extend backwards to the PR image (D18), and it has exactly one documented exception (D26).

This ADR **supersedes ADR 0016 D30** (the edge fold) and **amends D34** (three entry points, since revised to four by `landing.yml`, and now five). ADR 0018's single-registry posture is unchanged and load-bearing throughout.

---

## A. The branch model

**D1 — Work reaches `main` only through a train.** A pull request targets the open `beta/x.y.z` branch. `main` accepts exactly one kind of change: a promotion of a whole train. There is no exception for hotfixes (D20), for documentation, or for reverts. Enforcement is a required status check, not a ruleset setting, because **GitHub rulesets cannot restrict a pull request's source branch** — no such setting exists. The check reads `base_ref` and `head_ref` and fails when a PR based on `main` has a head that is not the open train.

**D2 — Exactly one train is open at a time, and this is forced, not chosen.** Fast-forward promotion (D5) requires `main` to be an ancestor of the train tip. Two trains cut from the same `main` cannot both fast-forward: the moment the first promotes, the second's ancestor is a commit `main` has moved past, and it can never fast-forward again. One-train-at-a-time is therefore a consequence of D5 rather than a policy laid on top of it, and any future proposal to run two trains is a proposal to abandon fast-forward.

The cost is a **freeze window**: from the moment a train is frozen for approval until it promotes, nothing merges anywhere. That window is bounded by how fast promotion happens and is documented in `CONTRIBUTING.md` rather than hidden.

**D3 — Cutting a train is choosing the version, and a workflow does it.** The cut creates `beta/x.y.z` from `main` and, in its first commit, writes that version into all four manifests — root, `packages/core`, `packages/panel`, `packages/shared`. The version is an administrative decision; writing it is not, and hand-editing four files is how three of them end up disagreeing. A required check on the train asserts all four equal the branch's version, so drift afterwards is impossible rather than merely discouraged.

**D4 — A train is disposable, and is deleted on promotion.** Its commits live on `main` afterwards; the branch itself carries no information. Disposability is also what makes squash-merging *into* the train safe: the classic GitFlow failure — squash a long-lived branch into `main` and it never becomes an ancestor, so the next merge diffs the entire history again — needs the branch to survive the merge. This one does not.

**D5 — `main` advances only by fast-forward.** Not a squash, not a merge commit. A squash would collapse every PR in the train into one commit, destroying the per-PR subjects the CHANGELOG is written from and breaking the linear-history rule's usefulness; a merge commit would abandon linear history outright. A fast-forward preserves every squashed PR commit, keeps history linear, and — critically — makes the promotion commit **byte-identical to the tip that was tested**, which is what D15's verification depends on.

A consequence worth stating plainly: the promotion pull request is a **gate, not a merge**. Its checks and its approval are the point; a workflow performs the advance (D13). GitHub's merge button is wrong for it, and squash-merge being the repository's only enabled merge method is what makes that unambiguous.

**D6 — `main` stays the default branch.** Making the open train the default would fix the one real papercut — GitHub bases new pull requests on the default branch, so a contributor's first PR targets `main` and gets bounced — but `main` is what `raw.githubusercontent.com/actana/control/main/install.sh` serves, what a clone checks out, and what the README renders from. All three mean "released code", and inverting that to fix a retarget click is the wrong trade. The papercut is answered with a note in the pull request template and an automated comment telling the author to retarget.

---

## B. The tag ladder

**D7 — Four published tag classes, and each answers one question.**

| Tag | Repository | Published when | Moves | Architectures |
| --- | --- | --- | --- | --- |
| `pr-<prid><YYYYMM>` | `panel-dev` / `core-dev` | every push to a non-draft, non-docs-only PR | per push | amd64 |
| `sha-<short>` | `panel-dev` / `core-dev` | every train merge | never | multi-arch |
| `beta-x.y.z` | `panel` / `core` | train cut, and every train merge | per merge | multi-arch |
| `x.y.z` | `panel` / `core` | promotion | never | multi-arch |
| `latest` | `panel` / `core` | promotion of the highest version | per release | multi-arch |

**D8 — `beta-x.y.z` is not a semver prerelease, and that is deliberate.** Semver's own form is `1.2.3-beta.1`, `release.yml` already handles prerelease tags correctly, and the shared `semver.ts` already parses them. `beta-x.y.z` was chosen anyway because it matches the branch name that produced it, and the mismatch is safe **only because betas never become GitHub Releases** (D9): nothing that parses versions ever sees one. If betas ever gain a GitHub Release, this clause must be revisited before that change lands, not after.

**D9 — Betas are Docker-only.** No git tag, no GitHub Release, no Core tarballs. The consequence is accepted: the metal install path has no beta channel, and a beta is testable only as a container. Should a beta ever publish a GitHub Release, it must be created with `prerelease: true` **and CI must assert the flag**, because `install.sh` and the in-product update checker both read `/releases/latest`, which excludes prereleases — a single missing flag would make every running Core and Panel advertise an unreleased build.

**D10 — `pr-<prid><YYYYMM>` moves with every push, and the prefix is not `sha-`.** The tag means "the current state of that PR" and is deliberately mutable: what it points at is what is under discussion. The `sha-` prefix was rejected because this repository already uses `sha-<short>` for the opposite thing — an immutable commit pin — and one prefix meaning both would misread exactly when it matters. The six-digit `YYYYMM` suffix is fixed-width so the PR id is recoverable by parsing from the right. A PR open across a month boundary starts a new tag and the previous month's is swept (D33).

**D11 — `sha-<short>` is the only immutable handle on pre-release bytes, and it lives in the `-dev` repositories.** It answers "which commit introduced this", which is the question a misbehaving beta produces. It sits in `-dev` rather than beside `beta-x.y.z` for one reason: the sweep that deletes it needs a delete-capable credential, and D34 keeps that credential permanently out of the repositories holding `latest`. The tag namespace therefore splits by audience — `-dev` holds handles for people debugging, the release repositories hold things people deploy.

**D12 — `<stage>-<arch>` tags are build scaffolding, not tags to pull.** `container-image.yml` pushes a per-architecture tag before stitching the multi-arch manifest. They are a real, visible part of the registry and were previously undocumented. The `stage` discriminator must be unique per concurrent build: with PR builds now pushing, two open pull requests sharing `stage: ci` would overwrite each other's per-architecture tags, and the stitch could assemble a manifest from another pull request's bytes. `stage` is therefore `pr-<number>` on the PR path.

**D13 — `:edge` is retired, job and tag.** It published from `main`; under the train model `main` is only ever a released version, so `:edge` would be a second name for `:latest`. `beta-x.y.z` replaces it, one branch earlier in the flow. This is the clause that supersedes ADR 0016 D30 — the argument for folding the edge publish into `ci.yml` ends when there is no edge publish.

---

## C. Promotion

**D14 — Promotion is an explicit dispatch.** `promote.yml` runs on `workflow_dispatch` with the train name, after the promotion pull request is green and approved. Auto-running on review approval was rejected: promotion is the most consequential action in the repository, it publishes to the world, and "approved by accident" is a failure mode worth designing out. The promotion pull request closes itself as merged once its commits become reachable from `main`.

**D15 — The human pause is the first thing promotion does.** ADR 0016 put a required-reviewer environment on the macOS tarball leg so that every publishing job sat downstream of a person. That ordering is preserved and strengthened: the pause moves to the head of `promote.yml`, so **the fast-forward itself is downstream of it** and `main` never contains unapproved code. `release.yml`'s macOS leg loses its environment; exactly one pause exists.

The reviewer builds their macOS tarball from the **train tip** rather than from a tag that does not exist yet. That is the same commit by D16's assertion, and it is available earlier, which is strictly better for them.

**D16 — The promoted digest is verified, not trusted.** `beta-x.y.z` moves on every train merge, so "retag whatever it points at" would promote untested bytes whenever someone merged after the approver tested. Promotion therefore resolves the tag to a digest and **asserts that the image's `org.opencontainers.image.revision` label equals the promotion pull request's head SHA**. A mismatch fails the promotion with "the train moved; re-approve". The label is already baked in by `container-image.yml`; nothing new is published to make this work.

The ruleset's dismiss-stale-approvals rule remains as the human-side guard. This clause is the machine-side one, and the design's central claim reduces to it.

**D17 — Release images are retagged, never rebuilt.** `release.yml`'s image jobs stop calling the build path and instead run `docker buildx imagetools create` from the verified beta digest — the same command the reusable workflow already uses to stitch multi-arch manifests. A promotion therefore takes seconds and cannot produce different bytes, because it produces no bytes.

**D18 — The digest guarantee runs from `beta-x.y.z` to `x.y.z`, and no further.** Pull requests squash-merge, so a train commit is a *new* commit and its image is a fresh build — different bytes from the `pr-*` image that was manually tested. This is stated because "we ship the exact image we tested" is the kind of claim that grows in the retelling until somebody relies on a link in the chain that was never there. The PR image is a convenience for reviewing a change; the beta image is the artifact that gets promoted.

**D19 — The promotion pull request's image checks verify instead of building.** `Panel image` and `Core image` are pinned required checks and run on every pull request, so a promotion would otherwise rebuild both images for an hour to produce bytes that already exist. On a promotion pull request the jobs instead perform D16's assertion: seconds, same check names, still green, and the redundant work becomes the verification the design needs.

**D20 — Train merges always rebuild, with no path filters.** Documentation-only pull requests pass their image checks without building; a documentation-only *merge into a train* must still republish. Otherwise `beta-x.y.z`'s revision label names an older commit and D16's assertion fails — a README fix would block the release. Relaxing the assertion to accept an ancestor commit whose diff touches only ignored paths was considered and rejected: it makes the design's most safety-critical check conditional on a path list staying accurate. Train merges are rare compared with PR pushes, so nearly all of the saving is kept on the PR side regardless.

**D21 — A failed train publish blocks promotion at the pull request, not at the dispatch.** When a train merge's image build fails — a Trivy finding, a native build break — `beta-x.y.z` does not move and the train is silently un-promotable. Left alone, this surfaces only when someone dispatches promotion, after a human has already worked the acceptance checklist against a stale image. The failure therefore opens an issue and the enforcement check blocks the promotion pull request while the train's latest push is red. Auto-reverting the merge was rejected: reverting someone's work because a base image grew a CVE overnight is worse than the failure.

---

## D. Hotfixes and backports

**D22 — A hotfix is an expedited train, not a bypass.** Cut `beta/x.y.z+1` from `main`, cherry-pick the fix, run the normal flow at speed. A second publish path was rejected precisely because it would be the path used under time pressure — when the machinery most needs to be the one everybody has exercised. The whole flow is automated; if it is too slow, the answer is faster CI, not an exception.

**D23 — "This is a hotfix" is an observable state, never a label.** The condition that matters is *a train was promoted while another train existed*, which the workflow can see. A label or dispatch input would have to be set by a human during an incident, which is when it would be forgotten.

**D24 — After a hotfix, the surviving train is rebased by the workflow.** D22 necessarily opens a second train, and promoting it strands the first (D2). `promote.yml` therefore rebases the surviving train onto the new `main` and force-pushes it. This is the one exception to the train branch protection: **no force-push except the promotion workflow, after a hotfix.** Where the rebase conflicts, the runbook's fallback is to abandon and re-cut the train from `main`, cherry-picking its squash commits.

Two obligations attach to that rebase. Every commit SHA on the train changes, so the rebase **must republish `beta-x.y.z` and `sha-<short>`** — otherwise the tag names an image whose revision label points at a commit that is no longer reachable, and D16's assertion fails at that train's promotion, long after the cause. And every open pull request into the train has had its base rewritten without being told, so the workflow comments on each one.

**D25 — Auto-cut is skipped when a train already exists.** `promote.yml` cuts `beta/<next-minor>.0` after promoting, so a train is always open and the repository never enters a state where work cannot be proposed. When a train already exists — which is exactly the post-hotfix case — the invariant already holds and there is nothing to cut. The guessed version is a default, not a commitment; the administrator may delete and re-cut before anything merges.

**D26 — Backports are the one documented exception to digest promotion.** A severe bug's fix for current users rides a hotfix train (D22), with the invariant intact. Users on older lines are served by cherry-pick pull requests into the last two minor lines' release branches, each publishing its own patch release **built from the release branch** — no beta train exists for an old version, so no beta digest exists to promote. The gate is pull request review plus full CI plus a human-tested release candidate (D29). Anything older than the last two minor lines gets "upgrade to latest", which the one-command installer and the compose setup make cheap.

This is the only exception in the design. It is written down here rather than discovered later, and `release.yml` therefore carries two modes: **promote mode** when the tag is reachable from `main` (retag the verified beta digest), **backport mode** when the tag is on a `release/*` branch (build and push).

**D27 — Release branches are named for the line, `release/x.y`.** A branch cut at `1.2.0` that then publishes `1.2.4` is not `release/1.2.0`. Naming it for the minor line keeps the name true, matches the unit the support policy is expressed in, and makes "the supported lines" computable by listing and sorting `release/*` rather than by parsing patch versions. Retired lines keep their branches as history and become read-only.

**D28 — A backport never moves `latest`, on either Docker Hub or GitHub, and an assertion enforces it.** Two independent library defaults do the wrong thing here and neither was written by anyone: `resolve` emits `tags="$version latest"` for any non-prerelease, and `gh release create` defaults the API's `make_latest` to `true`. Publishing `1.2.4` after `1.4.0` would therefore move `:latest` backwards *and* make `/releases/latest` answer `v1.2.4` — which is what `install.sh` installs by default and what the update checker compares against. **Every existing user would be told to downgrade.**

Both sites gain an explicit "is this the highest released version" test, `--latest` is always passed explicitly rather than defaulted, and a CI assertion makes backport mode structurally incapable of emitting `latest`. The failure is silent, reaches end users, and stays dormant until the first backport; belt and braces is proportionate.

**D29 — Forward-fix first, backport second, and the order is enforced.** A fix that lands on a release line but never on `main` is reintroduced by the next minor — the classic silent backport regression. A required check on `release/*` pull requests asserts the fix already exists on `main` by patch-id, and a periodic housekeeping job diffs the release lines against `main` to catch a fix that later gets reverted.

**D30 — A backport publishes a release candidate first.** `1.2.4-rc.1` is built from the release branch and pulled by a human before the real tag. It costs one tag and one dispatch, reuses machinery already being built, and keeps "somebody ran these bytes" true of every published release rather than most of them — which is the entire product of this design, and would otherwise be false for precisely the releases carrying urgent fixes to the most conservative users.

**D31 — While the product is pre-1.0, the supported set is the current line only.** A `0.x` minor bump *is* the breaking change under semver — the same argument ADR 0016 D30 used to refuse a moving `:0` tag — so backporting across `0.x` minors would be backporting across breaking changes. Backports begin meaning something at `1.0`.

---

## E. Pull request images

**D32 — Every push to a non-draft pull request publishes a testable image.** This is the half of the design that is useful on its own: a reviewer can run a change before it is merged, rather than reading it. Draft pull requests and documentation-only diffs are exempt.

**D33 — An exempt image job must run and report success, never be skipped.** `Panel image` and `Core image` are pinned required checks, and **a required check whose job is skipped stays Pending forever, blocking the pull request permanently.** This is the same failure that forced `landing.yml` into a file of its own rather than a path-filtered job inside `ci.yml`, and it is why "skip on documentation-only" is implemented as an early successful exit rather than a job-level `if:`.

**D34 — Fork pull requests build without pushing.** GitHub does not expose secrets to `pull_request` runs from forks, by design. `pull_request_target` — which would run the base branch's workflow with secrets against contributor-authored code — is **rejected outright**: the Docker Hub credential it would expose can push `:latest` and rewrite both public image pages, and a malicious Dockerfile or `postinstall` script is all it takes. Fork pull requests keep today's behaviour, and the pull request image is therefore a maintainer convenience rather than a contributor one — which the documentation must say, or it will be filed as a bug.

**D35 — Pull request images are amd64 only; everything an operator deploys is multi-arch.** The two architecture legs share one Dockerfile and the architecture-specific failure is almost always the native `better-sqlite3` build, which the amd64 leg already exercises. Emulation on Apple silicon is acceptable for a developer poking at a change; it is not acceptable for `beta-x.y.z`, `x.y.z` or `latest`, which are built natively on runners of their own kind.

**D36 — Pull request images live in `panel-dev` and `core-dev`.** The `descriptions` job exists to make `actana/panel` and `actana/core` presentable; filling their tag lists with hundreds of `pr-*` tags undoes it. Separate repositories also mean a wrong-repository pull is impossible, and they bound the blast radius of the delete-capable credential (D38). They are public, with a description that says what they are: *pre-merge PR builds, not released, not scanned-clean, do not deploy.*

**D37 — The CVE gate blocks the merge, not the `-dev` publish.** A pull request whose image carries a fixable CRITICAL or HIGH cannot merge — unchanged from ADR 0016 D11 — but the image still publishes to `-dev`, because the image you most need to pull and inspect is the one that failed the scan. This applies to `-dev` only; nothing CVE-flagged ever reaches a release repository.

**D38 — One check name, four behaviours, each announced.** `Panel image` / `Core image` covers: build + smoke + push (normal pull request), build + smoke without push (fork), digest verification (promotion pull request, D19), and immediate success (draft or documentation-only, D33). ADR 0016's principle at `ci.yml` — *a job that sometimes pushes is a job whose green means two different things* — is **narrowed, not discarded**: it guards against a green check concealing a publish, and here every mode asserts "these bytes are good" while the modes are mutually exclusive on observable facts rather than on a flag someone sets. Keeping one name also keeps the ruleset's required-check list stable, which matters because that list is what locks the repository when it is wrong. Every run emits a `::notice` naming the mode it took, so a green check is self-describing in the log.

---

## F. Identity, triggers, and permissions

**D39 — A GitHub App is the push identity, and `GITHUB_TOKEN` cannot be.** Two reasons, and the first is a silent failure: **GitHub does not trigger workflows from pushes made with the default `GITHUB_TOKEN`.** A promotion pushing `vx.y.z` with it would produce a tag and no release, with nothing red anywhere, and the fast-forward of `main` would likewise never fire `landing.yml` — so a landing-page change merged through a train would quietly stop deploying. Second, `main` and `beta/*` require a pull request before merging, so a direct push needs a bypass actor. A GitHub App satisfies both, issues short-lived tokens, and scopes its permissions; a long-lived personal access token with push rights on `main` sitting in Actions secrets is the alternative and is worse.

The same identity writes the train-cut commit (D3), performs the fast-forward (D5), and force-pushes the post-hotfix rebase (D24). It is a bypass actor on both the `main` and `beta/*` rulesets.

**D40 — `release.yml` loses its `push: tags` trigger.** `promote.yml` invokes it by `workflow_call`; the tag is pushed as a record and triggers nothing. Keeping both would fire two release runs whose concurrency keys differ, so neither would block the other and both would race to build the same tarballs and create the same Release. The clause also makes a guard unnecessary: a stray hand-pushed `v*` tag now does nothing at all, which is a stronger property than a check that catches it. Re-releasing is `gh workflow run`, which is already how a Docker Hub description typo is fixed.

**D41 — `ci.yml` gains a `push` trigger on `beta/**` and loses the one on `main`.** Nothing else triggers on a train merge, so without it `beta-x.y.z` — the tag the entire promotion depends on — would never be published. The beta publish jobs sit structurally where the edge jobs were, which keeps ADR 0016's one-build-implementation property intact and makes the change a substitution rather than a rewrite. The `main` trigger goes because commits arrive there by fast-forward already proven by the train, and its `paths-ignore` block loses its stated justification along with `:edge`. `landing.yml` keeps its own `push: main` trigger, which D39's identity is what makes fire.

---

## G. Housekeeping and rollback

**D42 — The weekly rebuild stops publishing and becomes a detector.** As built, it resolved the newest release, rebuilt the Core image on whatever the base image was that Monday, and pushed over `<version>` **and `latest`**. Under this ADR that would overwrite a promoted digest with bytes no beta contained and no human approved — while the revision label still named the promoted commit, so D16's assertion would keep passing against changed bytes. The immutability claim would survive about seven days.

It now detects and files: when the base digest has moved, or Trivy finds a new fixable CRITICAL or HIGH in a released image, it opens an issue, and the patch ships through a hotfix train like any other change. It covers **both** images; core-only was an accident of how it grew. The accepted trade is that a base-image CVE now costs a patch release and a person, instead of a silent Monday mutation of `latest` — which is the price of the claim this ADR is built to make.

**D43 — Description syncing moves to housekeeping and covers all four repositories.** It was gated on the two release image publishes (ADR 0016 D33) because a page must not describe a version nobody can pull. The `-dev` pages have nothing to do with a release, and a weekly sync makes drift self-healing on all four. `docs/images/panel-dev.md` and `core-dev.md` exist as real files so the pages are reviewable in a pull request like the other two.

**D44 — Rollback re-points `latest` and flips the GitHub Release's latest flag. Nothing else.** `main`, the `vx.y.z` tag, and the release branch are the record of what happened and are never rewritten. Rollback stops new pulls from getting bad bytes; the fix goes forward through a hotfix train. The runbook says this explicitly, because the instinct at 2am is to rewrite history — and losing the ability to reason about an incident is a worse outcome than a bad version remaining in the record.

---

## What this supersedes

- **ADR 0016 D30** — the edge fold. Superseded by D13: there is no edge publish to fold.
- **ADR 0016 D34** — the entry-point count, already revised from three to four by `landing.yml`. Now **five**: `ci.yml`, `release.yml`, `promote.yml`, `housekeeping.yml`, `landing.yml`, plus the one reusable `container-image.yml`. `scripts/__tests__/workflows.test.mjs` asserts this set and is updated with the same kind of comment `landing.yml` carried.
- **ADR 0016 D10** — three rebuild mechanisms. The weekly rebuild-and-republish becomes a detector (D42); Dependabot on the base digest and `NODE_VERSION` bumps are unchanged.
- **ADR 0016 D33** — the descriptions job's gating rationale, which moves with the job (D43).

ADR 0018 (Docker Hub as the only registry) is unchanged and assumed throughout. ADR 0016 D29's installer contract — the `SHA256SUMS` and tarball asset names, and `bin/actana` inside the archive — is untouched: releases still cut a GitHub Release with all three tarballs (D9 restricts *betas* only).

## Considered Options

- **Keep the trunk and rename the channel (rejected).** `main` merges publish `beta-x.y.z` instead of `:edge`, a `v*` tag promotes. Zero branch topology, and it would have delivered the two-stage consumer story. Rejected because it cannot deliver the *byte* story: with `main` as the trunk, the released image is still a rebuild of a commit, and a promotion has nothing to retag.
- **A single long-lived `beta` branch (rejected).** The GitFlow shape. With squash-merge enabled it fails on the second promotion, not the first — `beta`'s commits never become ancestors of `main`, so every subsequent promotion diffs the whole history. Disposable per-version trains (D4) avoid the failure by construction.
- **Squash-merge the promotion (rejected).** Collapses every PR in the train into one commit, destroying the CHANGELOG's source material, and produces a `main` commit whose SHA differs from the tested one — which would make D16's assertion unimplementable.
- **Rebuild at promotion (rejected).** What ADR 0016 did. It is the thing this ADR exists to stop.
- **`pull_request_target` for fork PR images (rejected outright, D34).** A credential-exfiltration hole in a public repository, in exchange for a convenience.
- **Keeping the weekly rebuild's publish (rejected, D42).** Cheaper, and it keeps CVE latency under seven days unattended. It also falsifies the design's headline claim every Monday.

## Consequences

- **A freeze window on every release** (D2), bounded by promotion speed, documented in `CONTRIBUTING.md`.
- **A GitHub App must exist and be a bypass actor on two rulesets** before any of this works (D39). Without it the promotion silently does nothing.
- **Two new Docker Hub repositories and a second, delete-scoped credential** (D36, D38), the latter restricted to `-dev` by both token scope and a hard-coded allowlist in the sweep.
- **A base-image CVE now costs a patch release** (D42).
- **The pull request image is a maintainer convenience, not a contributor one** (D34), and the documentation must say so.
- **`container-image.yml`'s build-and-push path stays alive** for backport mode (D26) — the one place a released image is built rather than promoted.
- **Two human gates per release** — train acceptance and the macOS pause (D15). If that proves to be one more than the risk warrants, the macOS checklist folds into the acceptance checklist and the pause is dropped; that is a later amendment, not a thing to leave ambiguous now.

## Sequencing

The admin-console steps and the code steps interlock, and getting the order wrong locks the repository — a required check whose job does not exist yet leaves every pull request Pending forever. The order is: create the App and the `-dev` repositories → land the workflow changes on `main` by the old process → add the new required checks to the rulesets → create the `beta/*` ruleset → cut `beta/0.1.0` → promote it as the first release.

`beta/0.1.0` is the maiden voyage deliberately: the machine ships nothing until it has shipped once, and a zero-merge train still has an image to promote because the cut itself publishes one (D7).
