# CI/CD

What runs, when, and what it publishes. Admin-side setup (secrets, required
checks, labels) lives in [`REPO_SETUP.md`](REPO_SETUP.md).

## At a glance

**Five entry points and one reusable workflow** ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md), amending [ADR
0016](adr/0016-the-0-1-0-shape.md) D34):

| Workflow | Trigger | Produces |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | every PR | nothing published on a fork or a docs-only diff; otherwise `pr-<prid><YYYYMM>` in `panel-dev` / `core-dev`. It gates |
| [`ci.yml`](../.github/workflows/ci.yml) | push to `beta/**` | `beta-x.y.z` in `panel` / `core`, `sha-<short>` in `panel-dev` / `core-dev` |
| [`promote.yml`](../.github/workflows/promote.yml) | dispatch, naming a train | the human pause, the digest verification, the fast-forward of `main`, the `vx.y.z` tag, the release line, retiring the promoted train |
| [`release.yml`](../.github/workflows/release.yml) | `workflow_call` from the promotion, or a dispatch — **not** a `v*` tag (D40) | Core tarballs + checksums, `:<version>`, `:latest` when it is the highest version, the GitHub Release |
| [`housekeeping.yml`](../.github/workflows/housekeeping.yml) | daily cron | stale labels / closures |
| [`housekeeping.yml`](../.github/workflows/housekeeping.yml) | weekly cron | a `NODE_VERSION` bump PR, the `-dev` tag sweep, the four Docker Hub pages, and an issue for anything the release detector, the dev-tree audit or the Harness canary found |
| [`landing.yml`](../.github/workflows/landing.yml) | push to `main` under `landing/**`, or dispatch | `landing/` uploaded to Bunny Edge Storage and the pull zone purged — the page at control.actana.ai |

There is no `push: main` row, and its absence is the whole design. Commits
reach `main` only by a promotion fast-forwarding a train whose every commit
`ci.yml` already gated and published (D41), so a second run there would
re-prove what the train proved. `:edge` is retired with it (D13): it published
from `main`, and under the train model `main` is only ever a released version,
so `:edge` would have been a second name for `:latest`.

`ci.yml` is one file doing two jobs, and the trigger is the difference. On a
pull request it gates, and publishes a `pr-` image a reviewer can run; on a
push to a train it publishes the image a promotion will re-point. The repo
conventions — PR title, commit messages, branch name — are the `Conventions`
job inside it ([ADR 0016](adr/0016-the-0-1-0-shape.md) D34), and the branch
model itself is the `Train rules` job beside it. A third, `Promotion gate`,
refuses one thing only: a pull request from a train into `main`, which is a
gate and must never be merged by hand (#264).

`promote.yml` is the fifth entry point, and the only thing in the repository
that writes to `main`. It is described under [Cutting a
release](#cutting-a-release).

`housekeeping.yml` is everything on a clock and nothing that gates. Its seven
chores share no subject; what they share is that **none of them can be caused or
fixed by a pull request**, which is why they are not in `ci.yml`. It is
described in full under [Housekeeping](#housekeeping).

`landing.yml` is the fourth entry point, and the only one that publishes to
somewhere other than a registry: it uploads `landing/` to Bunny Edge Storage
and purges the pull zone in front of it. It is a separate file rather than a
path-filtered job inside `ci.yml` for a reason that bites hard —
**`ci.yml`'s checks are required by the "Protect main" ruleset, and a required
check whose workflow is filtered out of a run stays Pending forever, blocking
every PR that does not touch the filtered path.** The same rule applies going
forward: if the landing page ever grows a validation step, it belongs in
`landing.yml` on a `pull_request` trigger with the same path filter, and it must
never be added to the ruleset's required checks. The page has no build, so
there is nothing to gate today. See [`landing-page.md`](landing-page.md) §7.

**That reasoning is still true and now covers more than one job.** ADR 0023 D33
is the same failure reached from the other side: `Panel image` and `Core image`
are pinned required checks too, so "skip the build on a draft or a
documentation-only diff" cannot be a job-level `if:` — a skipped required check
stays Pending forever just the same. It is implemented as an early *successful*
exit instead, which is why those checks go green in seconds on a docs PR rather
than disappearing from the list. The mode a run took is announced in its log,
so a green check is self-describing (D38, *one check name, four behaviours*).
One rule, three places it bites; see [The pull request
image](#the-pull-request-image-and-what-it-is-not).

Both container images have **one** build implementation:
[`container-image.yml`](../.github/workflows/container-image.yml), a reusable
workflow called by the PR, train and release paths with `image: panel` or
`image: core`. That is deliberate — the bytes a PR validates are built exactly
the way the bytes a release publishes are, rather than by a lookalike pipeline
that drifts. It has no trigger of its own, which is why it is not a sixth entry
point. Nothing on a clock calls it at all (D42).

`scripts/__tests__/workflows.test.mjs` asserts this inventory: five entry
points plus one reusable workflow, nothing else.

## The train model

Work does not go to `main`. It goes to a **train** — one `beta/x.y.z` branch,
open at a time — and `main` accepts exactly one kind of change: the promotion
of a whole train ([ADR 0023](adr/0023-release-trains-and-digest-promotion.md)
D1).

```
  PR ──squash──▶ beta/0.2.0 ──┬──▶ beta-0.2.0   (a person pulls this and approves)
                              │
                              └──▶ promotion ──▶ main (fast-forward) ──▶ 0.2.0, latest
                                                                          ▲
                                                        the same digest ──┘
```

Five things follow from that, and each is enforced rather than asked for:

- **A pull request targets the open train, never `main`.** GitHub bases new
  pull requests on the default branch, which is still `main` (D6) — so the
  first PR anyone opens targets the wrong thing and has to be retargeted. The
  `Train rules` check says so by name. It is a check rather than a ruleset
  setting because **GitHub rulesets cannot restrict a pull request's source
  branch**; no such setting exists.
- **Exactly one train is open at a time, and nothing chose that.** Promotion is
  a fast-forward (D5), which needs `main` to be an ancestor of the train tip.
  The moment one train promotes, a second train cut from the same `main` is
  behind a commit `main` has moved past and can never fast-forward again. The
  check catches a stranded train on the pull request rather than at the
  dispatch.
- **There is a freeze window.** From the moment a train is frozen for approval
  until it promotes, nothing merges anywhere. It is bounded by how fast
  promotion runs, and it is written down in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md) rather than discovered mid-review.
- **`main` advances only by fast-forward** — not a squash, not a merge commit.
  A squash would collapse every PR in the train into one commit and produce a
  `main` commit whose SHA differs from the tested one, which would make the
  digest assertion unimplementable.
- **The promotion pull request is a gate, not a merge.** Its checks and its
  approval are the point; `promote.yml` performs the advance. Do not press
  GitHub's merge button on it — and since #264 you cannot: the `Promotion
  gate` check is red on every such pull request by construction, which is what
  disables the button. Red is the healthy state for a gate.

Every package manifest — root, `packages/cli`, `packages/core`, `packages/panel`,
`packages/sdk`, `packages/shared` — carries the train's version, written by the
cut itself, and a required check asserts they still agree (D3, amended by #152
and #157). Nothing else should be editing them. The check also asserts that its
own list covers every workspace package, so the next package fails it rather
than being silently left out.

## The published images

| Image | What it is |
| --- | --- |
| `actana/panel` | The Panel web service. **This is the one you deploy.** |
| `actana/core` | The Core daemon. **A second, supported way to run a Core.** |
| `actana/panel-dev` | Pre-merge and pre-release handles for the Panel. **Not released, not scanned-clean, do not deploy.** |
| `actana/core-dev` | The same for the Core. |

All four are published to Docker Hub (`docker.io/actana/…`) — the only registry
the images go to ([ADR 0018](adr/0018-docker-hub-is-the-only-registry.md), as
amended: npm is a second registry, for the two published **packages** rather
than for any image).

The split is by **audience**, and it is load-bearing rather than tidy: the
`-dev` repositories hold handles for people debugging, the release repositories
hold things people deploy. Two consequences fall out of that. A
wrong-repository pull is impossible — `actana/core:latest` is never a
pre-merge build, whatever anybody types. And the delete-capable credential that
sweeps the `-dev` tags weekly is confined to two repository names that are not
the ones holding `:latest`; Docker Hub personal access tokens carry an
account-wide permission level rather than a repository list, so that
hard-coded list is the only guard there is ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D36, D38 — *the
delete-capable credential* — and D45).

`actana/core` is built from [`../deploy/core.Dockerfile`](../deploy/core.Dockerfile)
and is a Core you run rather than a machine you install one on: `tini` is PID 1
and `actana daemon` is its child, there is no init system inside, and it needs
neither `--privileged` nor a host cgroup. The image is the install — the tag is
the version, the entrypoint is the unit, and `docker compose pull && up -d` is
the upgrade ([ADR 0016](adr/0016-the-0-1-0-shape.md) §C).

Installing on a machine you own — `install.sh` plus `actana setup` plus a user
service, see [`../INSTALL.md`](../INSTALL.md) — is untouched and equally
supported. The container is a second distribution, not a replacement.

### Where each image's description comes from

Docker Hub does not read a README from GitHub on its own — it stores its own
per-repository description, set through its API. The `descriptions` job in
[`housekeeping.yml`](../.github/workflows/housekeeping.yml) pushes one file per
image, on the weekly tick, for all four repositories —
[`panel.md`](images/panel.md), [`core.md`](images/core.md),
[`panel-dev.md`](images/panel-dev.md) and [`core-dev.md`](images/core-dev.md).
(The images also set the `org.opencontainers.image.source` / `description`
labels at build time; Docker Hub ignores them, but `docker image inspect` and
any label-reading UI finds its way back to the source.)

It used to hang off `release.yml`'s two image publishes, so that a page could
not describe a version nobody can pull (ADR 0016 D33). That reason did not
survive the move ([ADR 0023](adr/0023-release-trains-and-digest-promotion.md)
D43): the `-dev` pages have nothing to do with a release, and four pages
drifting until someone happens to cut a release is the larger problem. On a
clock the drift is self-healing.

Edit those four files to change what Docker Hub shows. Merge the fix and the
next Monday publishes it, or `gh workflow run housekeeping.yml -f
chore=descriptions` publishes it now. The sync authenticates with the same
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` the image push uses — not the cleanup
token — which is why that token must be a *personal* access token: the API
endpoint rejects organization ones; see [`REPO_SETUP.md`](REPO_SETUP.md) §2.

## The release artifacts

The product ships as three things, on one pipeline, from the same tag:

- **The Panel** is a container. `release.yml` → `docker.io/actana/panel`.
  No installer, no signing — the image is
  the release artifact ([ADR 0010](adr/0010-panel-becomes-a-self-hosted-web-service.md)).
- **The Core, as a container** comes from the same workflow → `docker.io/actana/core`.
- **The Core** — the thing a real Core actually runs — is a per-platform
  tarball. `release.yml` → `linux-x64`, `linux-arm64` and `mac-arm64` with
  published checksums, which `install.sh` and `actana update` verify against.

A release therefore publishes exactly four release assets —
`actana-core-<version>-linux-x64.tar.gz`,
`actana-core-<version>-linux-arm64.tar.gz`,
`actana-core-<version>-mac-arm64.tar.gz` and `SHA256SUMS`. `install.sh` is
deliberately **not** one of them: it is served from `main`, so a broken
installer is fixable without cutting a release
([ADR 0016](adr/0016-the-0-1-0-shape.md) D29).

There is no `mac-x64`, and there never will be
([ADR 0016](adr/0016-the-0-1-0-shape.md) D28, as amended): the on-device macOS
install is Apple silicon only, and an Intel Mac runs its Core from the
container image. Both front doors refuse it at detection and name that path —
`install.sh`'s `detect_target` and `releaseTargetFor` in
`packages/cli/src/actana-release.ts`, which are required to agree on every
shape, refusals included.

The Panel and the Core are version-locked at runtime: the core-link
handshake exchanges a protocol version, and a mismatched pair renders as "needs
update" in the Panel. They therefore ride the same train and promote together —
one version, both images, and one `ACTANA_TAG` in the reference compose that
moves both.

The images on that release are **retagged, not rebuilt** — see [The digest
guarantee](#the-digest-guarantee-where-it-starts-and-where-it-stops). The Core
tarballs are not: they are built by the release, from the promoted commit, and
the digest claim is about the container images only.

### Integrity is published checksums, not signatures

**Nothing a release ships is code-signed.** The three Core tarballs and both
container images are unsigned: no Apple notarization, no Windows Authenticode —
there is no Windows artifact to sign — and no detached GPG or Sigstore signature
over a tarball or an image manifest. `release.yml` carries no signing secret at
all — its one signing-adjacent capability, `id-token: write` on the `npm` job,
is keyless OIDC rather than a key. Three credentials sit on the release path
and none of them signs anything: `github.token` for the Release assets, the
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` PAT for the images, and `NPM_TOKEN`
for the packages. The last two are each mandatory, gated by their own `resolve`
step that fails the release before anything is built when they are unset.

Integrity is **the published checksums**, and both paths that put a Core on a
machine verify them. `install.sh` fetches `SHA256SUMS` *before* the tarball, and
`actana update` does the same for an in-place upgrade
([`actana-update.ts`](../packages/cli/src/actana-update.ts)); each compares the
SHA-256 it computed against the release's own line and refuses to install on a
mismatch. What that proves is bounded, and both call sites say so in a comment:
the tarball is the one the release's checksum file describes. The checksums came
over the same channel as the bytes, so this catches corruption and truncation —
not a release channel someone else controls. That is the gap a signature would
close, and it is open.

One release surface is attested, and it is not a counter-example: the npm
packages are published with `--provenance`, so `@actana/sdk` and `@actana/cli`
carry a SLSA provenance attestation that the release reads back off the registry
before it succeeds ([npm](#npm)). Provenance attests *where a package was
built*. It is not a signature over a released binary, and it covers neither the
tarballs nor the images.

**Why unsigned is safe for the way this ships.** The distribution path is
`curl | bash`, and `curl` — like `wget` — does not set the
`com.apple.quarantine` extended attribute. Nothing arriving by that path is ever
quarantined, so **Gatekeeper never intervenes**, and there is no dialog for
notarization to buy off. This is a claim about the *transport*, not about the
bytes: revisit it the moment a browser-download distribution is added, because a
browser does set the attribute. That case is already the operator's, not the
installer's — [`../INSTALL.md`](../INSTALL.md) documents `xattr -dr
com.apple.quarantine` as the escape hatch for a tarball fetched in Safari or
Chrome.

**The corollary, which already cost one review cycle: do not add `xattr -dr
com.apple.quarantine` to `actana setup`.** It is a recursive attribute strip run
on every install to undo a state the install path cannot produce. On the paths
`actana setup` actually runs on there is nothing to clear, so it buys nothing;
on any other path it silently clears quarantine on files that legitimately carry
it, turning a Gatekeeper decision into something the installer made on the
operator's behalf without saying so. The strip stays where it is, in `INSTALL.md`,
run by hand by the person who knows they used a browser.

This is the current posture, not a permanent refusal.
[ADR 0010](adr/0010-panel-becomes-a-self-hosted-web-service.md) voided the
Panel's desktop signing story and deferred the question to Harness distribution
planning; this section is that answer, and
[#24](https://github.com/actana/control/issues/24) — sign the release, publish
an SBOM and provenance — is where it changes. Until that lands, treat every
statement above as load-bearing rather than incidental: `install.sh`'s checksum
comment points here, and the macOS prerelease checklist's Gatekeeper box assumes
it.

## The tag ladder

Five published tag classes, each answering exactly one question ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D7):

| Tag | Repository | Published when | Moves | Arch |
| --- | --- | --- | --- | --- |
| `pr-<prid><YYYYMM>` | `panel-dev` / `core-dev` | every push to a non-draft, non-docs-only PR | per push | amd64 |
| `sha-<short>` | `panel-dev` / `core-dev` | every train merge | never | multi-arch |
| `beta-x.y.z` | `panel` / `core` | the train cut, and every train merge | per merge | multi-arch |
| `x.y.z` | `panel` / `core` | promotion | never | multi-arch |
| `latest` | `panel` / `core` | promotion of the highest version | per release | multi-arch |

Read it as a ladder of decreasing mutability and increasing audience: `pr-` is
what is under discussion, `beta-` is what is about to ship, `x.y.z` is what
shipped, and `latest` is what an operator gets by typing nothing.

- **`pr-<prid><YYYYMM>` means "the current state of that pull request"** and is
  mutable on purpose (D10). The prefix is deliberately *not* `sha-`, which this
  repository already uses for the opposite thing — an immutable commit pin —
  and one prefix meaning both would misread exactly when it matters. The
  six-digit month suffix is fixed-width so the PR id parses off the front. A
  pull request open across a month boundary starts a new tag; the old one is
  swept (D45).
- **`sha-<short>` now lives in the `-dev` repositories** (D11), not beside
  `beta-x.y.z`. It is the only immutable handle on pre-release bytes, and it
  answers "which commit introduced this" — which is the question a misbehaving
  beta produces. **So if you are bisecting a beta, pull from `actana/core-dev`
  and `actana/panel-dev`, not from the release repositories.** It sits there
  because the sweep that deletes it needs a delete-capable credential, and that
  credential is kept permanently out of the repositories holding `latest`.
- **`beta-x.y.z` is not a semver prerelease, and that is deliberate** (D8).
  Semver's own form is `1.2.3-beta.1` and the tooling parses it correctly; this
  shape was chosen because it matches the branch that produced it. The mismatch
  is safe **only because betas never become GitHub Releases** (D9) — nothing
  that parses versions ever sees one. If a beta ever gains a Release, that
  clause has to be revisited before the change lands, not after.
- **Betas are Docker-only.** No git tag, no GitHub Release, no Core tarballs.
  The metal install path therefore has no beta channel: a beta is testable as a
  container and in no other way.
- **A prerelease version tag** (`v1.0.0-rc.1`) publishes `:1.0.0-rc.1` and
  deliberately does **not** move `:latest`.

### `<stage>-<arch>` tags are build scaffolding, not tags to pull

You will see names like `pr-116-amd64`, `beta-0.2.0-arm64` and `0.2.0-amd64` in
the registry. **They are not for you.**
[`container-image.yml`](../.github/workflows/container-image.yml) pushes one
per-architecture tag per leg and then stitches the multi-arch manifest over
them; they are a real, visible, previously undocumented part of the registry,
and they are an implementation detail of the stitch (D12). Pulling one gets you
one architecture with no manifest in front of it.

The `stage` discriminator has to be unique per concurrent build, which is why
it is `pr-<number>` on the pull request path and `beta-x.y.z` on the train
path rather than a shared literal. Two open pull requests sharing `stage: ci`
would overwrite each other's per-architecture tags, and the stitch could then
assemble a manifest out of another pull request's bytes. That was harmless
while PR builds pushed nothing; it corrupts from the moment they do.

The `-dev` sweep recognises `pr-<number>-<arch>` and cleans it up. The release
repositories' scaffolding is left where it is — nothing unattended deletes from
a repository holding `latest`.

### The digest guarantee: where it starts, and where it stops

**The digest guarantee runs from `beta-x.y.z` to `x.y.z`, and no further.**

That is the whole claim this pipeline exists to make, and it is worth stating
in its narrow form because it is exactly the kind of claim that grows in the
retelling until somebody relies on a link in the chain that was never there.

What is true:

- A train merge builds an image and publishes it as `beta-x.y.z`.
- A person pulls **that** image, runs it, and works the [beta acceptance
  checklist](beta-acceptance-checklist.md) against it.
- Promotion resolves `beta-x.y.z` to a digest, asserts the image's
  `org.opencontainers.image.revision` label equals the promotion pull request's
  head SHA, and only then re-points `<version>` and `latest` at **that same
  digest** with `docker buildx imagetools create` (D16, D17).
- Nothing is built in between. A promotion cannot produce different bytes
  because it produces no bytes.

What is **not** true, and never was:

- **The `pr-` image is not the beta image.** Pull requests squash-merge, so a
  train commit is a *new* commit and its image is a fresh build. Different
  bytes, deliberately (D18). The `pr-` image is a convenience for reviewing a
  change; the beta image is the artifact that gets promoted.
- **The guarantee does not reach backwards past the train merge**, and it does
  not reach forwards past `x.y.z` either — `latest` is a pointer that moves,
  and the next release moves it.
- **A backport is the one documented exception.** No beta train exists for an
  old line, so there is no digest to promote and its images are built from the
  release branch. See [Backports and the supported
  lines](#backports-and-the-supported-lines).

The assertion is made twice, on purpose: once in `promote.yml` **before**
`main` moves — which is what stops an unapproved commit reaching `main` at all
— and again inside `container-image.yml` immediately before the retag. Both
run on every architecture and both images, because the manifest is per-platform
and a half-verified release is not a verified one.

If the train moved after the approver tested it, the assertion fails with *"the
train moved; re-approve"* and nothing is published. That is the design working.

## The pull request image, and what it is not

Every push to a non-draft pull request publishes an image a reviewer can *run*
rather than read ([ADR 0023](adr/0023-release-trains-and-digest-promotion.md)
D32). It is the half of the design that is useful on its own, and it comes with
three limits worth knowing before you file one of them as a bug.

`Panel image` and `Core image` are two pinned required check names covering
four behaviours, and every run announces which one it took (D38, *one check
name, four behaviours*):

| Mode | When | What happens |
| --- | --- | --- |
| build + push | same-repo, non-draft, touches code | `pr-<prid><YYYYMM>` to `panel-dev` / `core-dev` |
| build, no push | the head is a fork | built and smoked; nothing published (D34) |
| verify | the promotion pull request | the digest assertion instead of an hour of rebuilding (D19) |
| pass | draft, or a documentation-only diff | green immediately, having built nothing (D33) |

They are four modes of one job rather than four jobs precisely because the
ruleset pins these names — the same reason `landing.yml` is its own file.

**Undrafting re-resolves.** `ready_for_review` is one of the trigger's named
activity types (#137), so the moment a draft is marked ready a new run starts
and the mode resolves against `draft: false` — a real build replaces the
draft-time `pass` greens. Without it, the greens a draft got in seconds would
stand over a head that was never built, under the same check names a real
build reports under (D33), and nothing about the pull request would say so.

**Fork pull requests build without pushing, and that is by design.** GitHub
does not expose repository secrets to a `pull_request` run from a fork.
`pull_request_target` — which would run the base branch's workflow with secrets
against contributor-authored code — is rejected outright: the Docker Hub
credential it would expose can push `:latest` and rewrite both public image
pages, and a malicious Dockerfile or `postinstall` script is all it would take.
So **the pull request image is a maintainer convenience, not a contributor
one.** A fork PR with a green image check and no image behind it is working
correctly.

**PR images are amd64 only** (D35). Everything an operator deploys is
multi-arch and built natively; the arch-specific failure is almost always the
`better-sqlite3` build, which the amd64 leg already exercises. Emulation is
acceptable for a developer poking at a change and is not acceptable for
`beta-x.y.z`, `x.y.z` or `latest`.

**A CVE-flagged image still fails the merge.** The gate is unchanged — a
fixable CRITICAL or HIGH blocks the pull request — but the intent (D37) is that
the image still reaches `-dev`, because the image you most need to pull and
inspect is the one that failed the scan. As built, a failed scan suppresses the
push, so today that image is built, scanned, reported and *not* published; the
scan JSON is uploaded either way. Changing it means unpicking the invariant
`scripts/__tests__/image-cve-gate.test.mjs` pins for the release path — "an
image that fails the gate never reaches a registry" — which is a decision to
take deliberately rather than as a side effect. Nothing CVE-flagged reaches a
release repository under either reading.

## Architectures

Every published image is a multi-arch manifest over `amd64` and `arm64`, and
each architecture is built on a **native runner** of its own kind. Neither
image could be cross-built honestly: the Panel compiles `better-sqlite3` during
its build, and the Core bakes in the Core tarball for that architecture.
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

**Core** — [`scripts/smoke-core-image.mjs`](../scripts/smoke-core-image.mjs)
boots the image with a plain `docker run` — nothing privileged, no host cgroup,
one volume — and then pairs a real Panel with it end to end. Along the way it
proves what a *build* can get wrong (the identity is `core` at 1000:1000,
`tini` is PID 1 with the daemon as its child, and the Core tree in `/opt/actana` is the
*architecture-matched* one) and what the *contract* can get wrong: the
lifecycle verbs refuse and name their Docker equivalent, `docker restart` is a
no-op for pairing, and destroying the volume is the one thing that unpairs.

It replaced `panel-e2e-core-in-a-box`, which needed `--privileged` and the host
cgroup to boot a systemd fixture and asserted against bytes no operator ever
received. It does **not** replace the installer e2e — that is a different
arrival, a different PID 1 and a different install location
([ADR 0016](adr/0016-the-0-1-0-shape.md) D36). The Trivy gate below runs in the
same job, on the same built image.

### What no longer runs on a PR, and what picks it up

Two seams came off the PR gate. One moved; the other has no automation at all,
which is written down here rather than discovered:

- **`actana harnesses install <id>`** — that a vendor's official installer
  still leaves a CLI on `PATH`. Deliberately non-hermetic, so no PR can cause
  its failure and no PR author can fix it; gating on it is how a team learns
  that red means nothing ([ADR 0016](adr/0016-the-0-1-0-shape.md) D38). It runs
  weekly as `housekeeping.yml`'s `harness-canary` job — `pnpm
  core:harnesses:e2e` against four vendors' real installers — and a failure
  arrives as an issue rather than a red check. It is failing on `opencode`
  today ([#31](https://github.com/actana/control/issues/31)).
- **The macOS install path** — `actana setup` against launchd, Gatekeeper on an
  unsigned bundle, and whether the LaunchAgent survives a reboot and a logout.
  A release-tag runner builds and smokes the `mac-arm64` tarball, and that is
  all it can do: a runner is destroyed rather than restarted, so nothing
  automated answers the persistence questions. [The pre-release
  checklist](core-macos-prerelease-checklist.md) is the rest of it, and it is a
  **release gate** — see "Cutting a release" below.

## The installer e2e, and why it is one job on two triggers

There is **one** installer e2e — `scripts/e2e-actana-setup-linux.mjs` — and it
is entered at the real `curl … | bash` one-liner. Install, the lifecycle verbs,
in-place upgrade, `update`, `token regenerate` and `uninstall` all run against
the machine the one-liner produced, rather than against a second machine that a
duplicated install phase set up ([ADR 0016](adr/0016-the-0-1-0-shape.md) D36).

install-sh's negative cases — bad checksum, unknown platform, `--version`
pinning, non-TTY behaviour, exit codes — are covered hermetically, in under a
second, by `scripts/__tests__/install-sh.test.mjs`, so the container leg does
not repeat them. Each one would cost a whole extra one-liner run on a real
container to prove something already proven.

Its axes are `distro × arch`, and they split across two triggers:

| Trigger | Workflow | Legs |
| --- | --- | --- |
| every PR | [`ci.yml`](../.github/workflows/ci.yml) `installer-e2e` | ubuntu, debian — **x64** |
| `v*` tag | [`release.yml`](../.github/workflows/release.yml) `installer-e2e` | ubuntu, debian — **arm64** |

Distro is the axis that earns its place on every PR: PAM, polkit and the logind
rules that decide whether a sudo-less `systemctl --user` and `loginctl
enable-linger` work at all are exactly what differs between distributions.
Architecture is not — the arch-sensitive risk is prebuilt native modules, and
`core-tarball-smoke` already boots the arm64 tarball on an arm64 runner on every
PR. So arm64's installer leg is paid for once per release instead of once per
push, and it **gates `github-release`**: an arm64 tarball the one-liner cannot install
is not a release asset worth attaching.

Both jobs are declared once, in `scripts/lib/container-matrix.mjs`.
`scripts/__tests__/container-matrix.test.mjs` reads that module *and* both
workflow files, so a distro added to one and forgotten in the other is a failing
unit test rather than a leg nobody notices is missing.

## Dependency and CVE policy

Three populations, three owners, one gate each. They are written out separately
because nobody should later "simplify" one into another: `pnpm audit` cannot see
the base image at all, and Trivy has no dev/prod notion, so neither substitutes
for the other ([ADR 0016](adr/0016-the-0-1-0-shape.md) D37).

| Population | Gate | Runs |
| --- | --- | --- |
| Shipped npm packages | `pnpm audit --prod --audit-level high` | every PR |
| Dev-tree packages | `pnpm audit --audit-level high` — opens an issue, does not gate | weekly |
| The image: OS layer + the `node_modules` it ships | Trivy, fails on **fixable** CRITICAL/HIGH | every PR, on the built image |

All three rows are live as written. The weekly dev-tree audit is
`housekeeping.yml`'s `dev-audit` job; a finding there opens an issue labelled
`needs-triage` rather than failing anything, and it files at most one at a time
— a recurrence while the first is still open is silent, because the run link on
that issue already leads to the newest output.

The Trivy leg is [`scripts/scan-core-image.mjs`](../scripts/scan-core-image.mjs),
run from `container-image.yml` against the image that was just built and before
anything is pushed. Run it yourself with `pnpm core:image:scan --image <tag>`,
or against a saved tarball with `--input <image.tar>`.

**Fixable only.** An unfixed CRITICAL does not fail the build: there is nothing
a contributor can do about it, and a gate that is red for work nobody can do is
a gate everyone learns to click past. Medium and low are printed on every run
and never gate. The same reasoning is why `--prod` is on the npm gate — it still
catches `postcss` and `@babel/core`, which reach the runtime image through the
Panel's production graph, while dropping dev-only findings no contributor caused.

### What is suppressed, and what is merely out of scope

Two things stay out of the gate. They are different in kind and the difference
matters, so they live in different places rather than one hiding inside the
other.

**One suppression, one file, one entry:
[`.trivyignore.rego`](../.trivyignore.rego).** It suppresses `linux-libc-dev`,
which is ~1200 of the 1323 findings a raw scan of the Core image reports —
1246 distinct before the suppression, 46 after — and the
justification is written beside the rule: the package is kernel headers, 1008 of
its 1015 files are under `/usr/include`, it contains no executable code, and the
kernel a Core runs is the *host's*. The toolchain that pulls it in stays because
it is what the product is — `npm install` on any project with a native addon
invokes node-gyp, which needs `make`, `g++` and `python3` (D7). Nothing else is
suppressed anywhere in this repository, and adding a second entry is an ADR
change, not a build fix.

It is a Rego ignore policy rather than a plain `.trivyignore` for one measured
reason: `.trivyignore` and `.trivyignore.yaml` match on CVE **id** only. Naming a
package in either parses cleanly, filters nothing, and warns about nothing.
Because that failure is silent, the scan script asserts the suppression actually
took effect and fails if any `linux-libc-dev` row survives.

**One scope exclusion, in the gate rather than the allowlist: the system Node's
own bundled npm** (`usr/local/lib/node_modules/npm/`). Every fixable
CRITICAL/HIGH in the Core image today is in that one directory — `tar`,
`undici`, `brace-expansion`, `ip-address`, vendored inside npm — and no released
npm clears them: npm 12.0.2, the newest there is, still ships
`brace-expansion` 5.0.7 against fixes at 5.0.8 and 5.0.9, and `ip-address`
10.2.0 against a fix at 10.3.1. Bumping `NODE_VERSION` clears none of it either.
This is a second suppression and calling it anything else would be laundering
it; what makes it a different *kind* is that it is bounded by path rather than
by CVE, so a new finding in that tree is silently non-gating too. That is the
cost, accepted knowingly. Every one of those findings is printed by name on
every run, and paying them down belongs to the weekly rebuild, not to a PR.

The boundary is deliberately narrow. The Core's own shipped tree under
`/opt/actana` gates normally — it is fixable with `pnpm update`, and it is clean
today because [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) pins fixed versions
through `overrides` rather than suppressing anything. So does anything else
installed beside npm under `/usr/local/lib/node_modules`.

## The image bases, and what moves them

Three pins and one un-pinned layer decide what OS and what Node end up inside a
published image. No single mechanism moves all four, and the split is not an
accident — it is [ADR 0016](adr/0016-the-0-1-0-shape.md) D10's "three rebuild
mechanisms, because they catch different drift".

| Input | Where | Moved by |
| --- | --- | --- |
| `ubuntu:24.04@sha256:…` | [`core.Dockerfile`](../deploy/core.Dockerfile) | Dependabot, `docker` ecosystem |
| `gcr.io/distroless/nodejs24@sha256:…` | [`panel.Dockerfile`](../deploy/panel.Dockerfile) | Dependabot, `docker` ecosystem |
| `ARG NODE_VERSION=…` | [`core.Dockerfile`](../deploy/core.Dockerfile) | [`housekeeping.yml`](../.github/workflows/housekeeping.yml)'s `base-pins` job |
| everything `apt` installs | `core.Dockerfile`'s one `RUN` | the weekly rebuild, via D5's in-layer `apt-get upgrade` |

The last row is why the digest pin and the upgrade are *both* load-bearing:
apt resolves `noble-security` at build time, so a weekly rebuild on an
unchanged digest still collects every fix Canonical has shipped. Pin without
upgrade freezes the CVEs too, and the cadence becomes theatre (D5).

### The two digests are pinned in different shapes on purpose

Dependabot updates a digest from a *tag*, and which tag depends on whether the
pin carries one:

- **`ubuntu:24.04@sha256:…` — tag and digest.** Within the LTS line the tag
  does not move, so a point release is a digest-only change; the jump to the
  next LTS shows up as a tag change in a PR somebody reads. `24.04` is a
  *rolling* tag, so the digest is the pin and the tag is the boundary on how
  far it may roll.
- **`gcr.io/distroless/nodejs24@sha256:…` — digest, no tag.** This is the only
  pin the registry supports: 7,040 tags, and not one of them carries a version
  number — four mutable names plus per-arch build SHAs (D20). Dependabot's
  tagless branch resolves the update from the **`latest` tag's digest**, which
  is exactly what this pin means. Writing `:latest@sha256:…` instead would take
  the other branch and hunt for a tag *newer than* `latest`, which cannot
  exist.

### Why there is a checker as well as a config

`pnpm bases:check` ([`check-base-pins.mjs`](../scripts/check-base-pins.mjs))
resolves all three pins against their real upstreams — the registry HTTP API
and `nodejs.org/dist/index.json` — using the same tag Dependabot would use for
each, and prints what has moved. `housekeeping.yml`'s `base-pins` job runs it
weekly.

It exists because two of the three have failure modes a config file cannot
rule out:

- The distroless pin follows the `latest` tag. If that tag ever leaves the
  registry's tag list, Dependabot's `latest_digest` returns nothing and the
  updater goes **quiet** — no error, no PR, and the Panel's runtime silently
  stops being updated. The checker fails loudly on exactly that.
- `ARG NODE_VERSION` is a nodejs.org tarball (D8), not an image reference.
  Dependabot's `docker` ecosystem cannot see it at all, so without this nothing
  bumps it and the Core's system Node drifts a patch release at a time.
  the `base-pins` job opens that PR itself.

  What the bump buys is Node's own security fixes, and **not** a greener CVE
  gate. D10 calls it "the only thing that clears the Node-attributed findings";
  D10's own amendment measured that false, and D11's amendment then scoped the
  system Node's bundled npm tree out of the gate entirely — every fixable
  CRITICAL/HIGH in the Core image is in that tree, and no released npm clears
  them. Anyone merging one of these PRs expecting the scan to change will be
  disappointed; merge it because running an old Node is its own problem.

To see it work rather than take its word for it, edit either digest in
`deploy/` to something wrong and run `pnpm bases:check`: it reports the pin as
drifted and names the digest that should replace it — which, for both
registries, is the one Dependabot's own `digest_of(<tag>)` resolves. Put the
digest back afterwards.

The checker deliberately does **not** open PRs for the digests. Dependabot
already does, with its own cooldowns, grouping and dashboard, and two bots
racing to open the same PR is worse than one; a drifted digest is a job summary
pointing at `/network/updates` instead.

That the config *reaches* both Dockerfiles is asserted in
[`base-pins.test.mjs`](../scripts/__tests__/base-pins.test.mjs), against the
rules Dependabot actually applies rather than the ones its documentation
implies. Three of them bite:

1. Its docker fetcher matches `/dockerfile|containerfile/i` against the **file
   name**, which is why `core.Dockerfile` and `panel.Dockerfile` are seen at
   all despite not being named `Dockerfile`.
2. It lists a configured directory's own contents and **does not recurse**.
   `deploy/dev/core.Dockerfile` is therefore outside the `/deploy` entry —
   deliberately: it is a local fixture, published nowhere, and deleted entirely
   by D40. A new Dockerfile that is neither shipped nor listed with a reason
   fails that test.
3. There has to be a digest to move, so every shipped base is digest-pinned.

The `node:24.15.0-trixie` build stage in `panel.Dockerfile` is a fourth image
and is tag-pinned rather than digest-pinned. Nothing from it reaches the runtime
(D20), so it is not a CVE surface; it is pinned to the exact patch CI tests
against, and `panel-image.test.mjs` asserts the two agree. A Dependabot PR that
bumps it and not CI's Node is *meant* to go red there.

## Registries

**Docker Hub for the images, npm for the packages**
([ADR 0018](adr/0018-docker-hub-is-the-only-registry.md) — GHCR was retired;
npm was added by [#159](https://github.com/actana/control/issues/159)).

### Docker Hub

**The only registry any image goes to.** It authenticates with the
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets, so:

- A **non-pushing build** — the PR path, `push: false` — needs no credentials
  at all. Forks get green PR builds with zero configuration.
- A **pushing build with the keys missing** fails in `resolve`, before
  anything is built: there is nowhere to publish, and a missing credential
  costs nothing to catch early.
- A **pushing build with the keys wrong** fails at the `docker login`, before
  any tag is pushed — nothing is half-published.

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

The image name is derived, never hardcoded:
`docker.io/<DOCKERHUB_NAMESPACE or repo owner>/panel`. A fork that sets its
own keys publishes under its own namespace with no edit to any workflow; see
[`REPO_SETUP.md`](REPO_SETUP.md) §2.

### npm

`@actana/sdk` and `@actana/cli`, published by `release.yml`'s `npm` job on the
same tag that builds the images and at the same version as everything else
([#129](https://github.com/actana/control/issues/129) D13). It authenticates
with `NPM_TOKEN`, and a missing one fails in `resolve` in exactly the shape the
Docker Hub check does — before anything is built.

**An npm version number is burned by its first publish.** Unpublishing within
the 72-hour window frees the bytes and not the name, so nothing about a
container tag's re-pointability transfers, and three things follow:

- The `npm` job is **last** — after both tarball legs, the installer e2e, and
  both image publishes. Everything else in a release can be redone; a version
  number cannot.
- The publish is **rehearsed on every pull request**, long before a tag exists.
  `pnpm npm:rehearse` (`scripts/rehearse-npm-publish.mjs`) packs each
  publishable package with `pnpm pack` and asserts the tarball: the `>=22`
  engines floor, no install-time lifecycle script, a `repository` for the
  attestation to name, one version line with the CLI pinned to this train's
  SDK, and a file list that is a whitelist — so `scripts/require-node-24.mjs`
  cannot reach a tarball by any route, including a rename. The last rules
  depend on which kind of package it is: the SDK is **imported**, so every
  compiled module has a `.d.ts` beside it; the CLI is **run**, so the `bin`
  path npm links is in the tarball, starts with a node shebang, and has its
  bundle beside it. `pnpm test` runs it; the release runs the same script on
  the tarballs it then publishes, in dependency order — the SDK before the CLI
  that depends on it.
- Every publish is **attested**. The job carries `id-token: write` and passes
  `--provenance`; afterwards it reads the attestation back off the registry and
  fails if it is not there, because a publish that lost the flag succeeds and
  looks identical in the log. That read-back distinguishes its two failures:
  "the registry answered and there is no attestation" says cut the next version,
  and "the registry never answered" says explicitly not to — it is a re-run, and
  a re-run is free because an already-published version is treated as published.

**The dist-tag is decided, never defaulted.** `npm publish` with no `--tag`
takes `latest`, which is the same unwritten default as `gh release create`'s
`make_latest` and the same one the old `resolve` had in its Docker tag list —
so npm is the third surface of the `latest` guard (ADR 0023 D28), not an
exception to it. `resolve` emits `npm_tag` from
[`scripts/lib/release-latest.mjs`](../scripts/lib/release-latest.mjs), the same
module that decides the other two, and `release.yml` passes it explicitly:

| release | dist-tag | what `npm i @actana/sdk` gets |
| --- | --- | --- |
| the highest version, promoted | `latest` | this release |
| a prerelease on the main line (D30) | `next` | unchanged |
| a backport of an old line | `release-<major>.<minor>` | unchanged |
| a backport's release candidate | `release-<major>.<minor>-next` | unchanged |

A consumer pinned to an old line gets its patches with
`npm i @actana/sdk@release-0.1`. The `resolve` guard step fails the release if a
backport ever resolves `latest` on **any** of the three surfaces, and if the
dist-tag comes out empty — `npm publish --tag ""` is rejected by npm, and it
would be rejected after both images had already shipped.

A package is published exactly when its workspace manifest drops
`private: true`. `scripts/lib/npm-packages.mjs` holds the intended set and
checks the discovered one against it both ways: an unexpected package
publishing is an error, and so is `@actana/sdk` not publishing.

`@actana/sdk` declares `engines: ">=22"` while the monorepo, the Core and the
Panel keep `>=24 <25`. That is not a contradiction — one is the runtime this
repository is developed and released on, the other is the floor a consumer of
the SDK needs, measured against a live Core in
[`experiment/findings-151-node22-mtls.md`](../experiment/findings-151-node22-mtls.md).
The tarball ships compiled JavaScript because a consumer on Node 22 has no type
stripping; inside the workspace the SDK is consumed as TypeScript source, and
`publishConfig.exports` — applied by **pnpm** at pack time and ignored by npm —
is what reconciles the two. That is why the rehearsal packs with `pnpm` and
asserts that the packed map no longer points at `src/`.

### `gcr.io` is a second registry, and it is in the build path

Docker Hub as the sole registry is a decision about **publishing**. Pulling
the Panel's runtime base from `gcr.io/distroless/nodejs24` is a different thing
in a different direction: an availability and rate-limit dependency on Google's
registry, on **every single build** — every PR that touches the Panel image and
every merge into a train. It is accepted
([ADR 0016](adr/0016-the-0-1-0-shape.md) D26) and written down here so that
during an outage it is a known dependency rather than a surprise.

What that means in practice:

- **When `gcr.io` is down or throttling, the Panel image cannot be built.** Not
  degraded — the `FROM` fails and the job is red. Nothing already published is
  affected: pulling `actana/panel` never touches `gcr.io`, because the base's
  layers are inside the image operators pull from Docker Hub.
- **The Core image does not have this dependency.** It builds `FROM ubuntu`,
  which is Docker Hub, so an outage at one registry does not stop both images.
- **Anonymous pulls are rate-limited per source IP**, and GitHub-hosted runners
  share theirs. The build pulls one base per job, so this has room; a fan-out
  that built the Panel image many times in parallel would not.
- **There is no mirror configured, deliberately.** Copying the base into
  another registry and building `FROM` that would trade Google's availability
  for a copy that can go stale and for a second thing Dependabot would have to
  be taught to update. The pin is a digest, so a `gcr.io` outage delays a
  build; it cannot change what a build produces.

Two registries are therefore in play, doing two different jobs:

| Registry | Role | Fails how |
| --- | --- | --- |
| `gcr.io` | pulls the Panel's runtime base | no Panel image can be built |
| Docker Hub | pulls `ubuntu` and `node`; publishes both images | no Core image can be built; a pushing build without working credentials is red |

## Housekeeping

[`housekeeping.yml`](../.github/workflows/housekeeping.yml) is the only entry
point that is not a check and not a publish. Seven chores on two crons:

| Job | Cron | What it does |
| --- | --- | --- |
| `stale` | daily, 03:17 UTC | labels and closes inactive issues and PRs |
| `base-pins` | Mondays, 07:00 UTC | opens the `NODE_VERSION` bump PR, reports digest drift |
| `release-detector` | Mondays, 07:00 UTC | base drift or a new fixable CVE in a *released* image, both images — **opens an issue**, publishes nothing |
| `dev-tag-sweep` | Mondays, 07:00 UTC | deletes stale `pr-*` and `sha-*` tags from `panel-dev` and `core-dev` |
| `descriptions` | Mondays, 07:00 UTC | syncs all four Docker Hub pages from `docs/images/` |
| `dev-audit` | Mondays, 07:00 UTC | `pnpm audit --audit-level high` over the dev tree — **opens an issue** |
| `harness-canary` | Mondays, 07:00 UTC | the four vendors' real installers — **opens an issue** |

An eighth job, `release-ref`, resolves the newest published release for
`release-detector`; it is a job rather than a step only because a matrix job
cannot compute its own inputs.

One file, because a workflow file's unit is not a subject but a relationship to
a pull request, and these seven share one: no PR causes them and no PR fixes
them. Jobs are gated on `github.event.schedule`, which is how one file carries
two cadences; `workflow_dispatch` takes a `chore` input naming one of them, or
`weekly` for the six that share the Monday tick.
`scripts/__tests__/workflows.test.mjs` reads the file and asserts each job is on
the cron it claims — and that the directory still holds exactly five entry
points plus `container-image.yml`.

**Nothing on a clock publishes an image.** This file used to rebuild the newest
release every Monday and push over `:<version>` and `:latest`, on the argument
that a rebuild is what makes the digest pin honest — `apt-get upgrade` runs
inside the Core image's own layer (D5) and resolves `noble-security` at *build*
time, so even an unchanged base collects every fix Canonical has shipped since.
Under digest promotion that republish overwrites a promoted digest with bytes no
beta contained and no human approved, while the `revision` label still names the
promoted commit — so the promotion assertion keeps passing against changed
bytes, and the immutability claim survives about seven days
([ADR 0023](adr/0023-release-trains-and-digest-promotion.md) D42).

`release-detector` asks the same two questions and answers them with an issue.
It resolves the newest published non-prerelease release, checks that release's
own `FROM` digests against what upstream serves today, and runs Trivy over the
published image. Both images, not just Core: the distroless argument — a Panel
rebuild collects nothing because there is no apt — is an argument about
*rebuilds*, and a Chainguard base moving under a released Panel is worth knowing
about either way. Unfixable findings are deliberately excluded (ADR 0016 D11).
The accepted trade is that a base-image CVE now costs a patch release and a
person, shipped through a hotfix train like any other change.

Weekly rather than nightly (D10): Canonical does not ship security updates
nightly, and a nightly sweep of a registry is a property of a vendor's build
farm, not something worth imitating here.

**Three chores end in `gh issue create` rather than a red run.** `dev-audit`
(D37) is red for advisories in packages that never ship; `harness-canary` (D38)
is red when a vendor changes their installer; `release-detector` (ADR 0023 D42)
is red when a base image someone else maintains grows a CVE. None is payable by
the person whose PR happens to be open, and a permanently red scheduled workflow
is how a team learns that red means nothing. All three file at most one open
issue at a time: a recurrence while the first is still open is silent, and a
closed issue means someone decided it was handled, so the next recurrence earns
a fresh one.

**The `-dev` tag sweep is the only destructive unattended job here**, and Docker
Hub has no undelete. Every decision it makes lives in
`scripts/lib/dev-tag-sweep.mjs`, which is pure and unit-tested: which tag names
it recognises (`pr-<number><YYYYMM>`, `pr-<number>-<arch>`, `sha-<short>`, each
an anchored pattern rather than a prefix), which are stale, and — the part that
matters — which repositories it may touch at all. That last one is an
exact-match list of two names, re-asserted immediately before every delete call,
refusing to run when empty. `DOCKERHUB_CLEANUP_TOKEN` is a *second* credential
from the one the image push uses, and it can delete from the release
repositories too: Docker Hub personal access tokens carry an account-wide
permission level rather than a repository list ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D38 — *the
delete-capable credential*, as amended), so that list is the only guard there
is. `gh workflow run housekeeping.yml -f chore=dev-tag-sweep -f dry-run=true`
reports what it would delete without deleting it.

What goes: a pull request's images when it closes, last month's `pr-` tag when
the month rolls (D10), and anything unclaimed at 30 days — `sha-<short>` pins
included, because they are a debugging handle rather than an archive. The set
of open pull requests is a required input and never an optional one: "we could
not list them" must not read as "they are all closed", which is how a sweep
deletes every open review's image at once. A dry run reports the keeps as well
as the deletions, because a sweep that printed only its deletions would look
identical to one whose tag listing was silently truncated. The whole clause is
D45.

## Cutting a release

A release is a **promotion**, not a tag push. Nothing is rebuilt: the images an
operator pulls are the ones a person already ran. The whole flow is four
things, and three of them are a person's: the cut names the version, the
acceptance approves the bytes, and the dispatch asks for the publish.

```
  cut the train  ──▶  merge PRs into it  ──▶  freeze + accept  ──▶  promote
   (a person)          (each publishes         (a person)           (dispatch)
                        beta-x.y.z)
```

### Cutting a train

**A person cuts the train, by hand, and that is the normal path.** No workflow
cuts one and nothing guesses a version, because the version *is* the decision:
the next release may be a patch, a minor or a major, and only a person knows
which (D3, D22 and D25, all as amended by
[#325](https://github.com/actana/control/issues/325)). Until #325 a promotion
cut `beta/<next-minor>.0` on its way out and the runbook told you to delete and
re-cut it when the guess was wrong — which it was on the first promotion after
the clause was written.

The cut creates `beta/x.y.z` from `main` and writes that version into every
manifest in one commit (D3, amended by #152 and #157), **and into `install.sh`'s
line stamp beside them** ([ADR 0036](adr/0036-the-beta-release-channel.md) D1). A
required check on the train asserts every manifest equals the branch's version,
so drift afterwards is impossible rather than merely discouraged. That commit
**is** the stamp: a branch created without it is a train that looks right and
carries the previous train's versions, and it stays quiet until the first pull
request into it goes red with six errors at once, on whoever happened to open it.

The stamp in `install.sh` is a seventh file and **not** a seventh manifest. It is
what makes the copy of the installer on this train install this train's beta and
the copy on `main` install the release, out of bytes that become identical at the
promotion fast-forward (0036 D1 and D2) — so a train cut without it serves the
previous line's beta from its own door, silently. It is edited on its own line
below rather than added to `files=()` because `install.sh` is not a workspace
package, and `Train rules`' manifest set deliberately refuses to grow past the
packages (0036 D4).

```bash
git fetch origin --prune
git switch -c beta/x.y.z origin/main

# The six manifests. This list and `MANIFESTS` in `ci.yml`'s `Train rules` job
# are the same set by construction, and a test asserts it: the array below is
# read out of this file by `scripts/__tests__/workflows.test.mjs`, which fails
# when the two drift. Extending one without the other is the bug that assertion
# exists to catch — a seventh package would be cut unstamped and found by
# `Train rules` afterwards, on somebody else's pull request.
files=(package.json packages/cli/package.json packages/core/package.json
       packages/panel/package.json packages/sdk/package.json packages/shared/package.json)

# One line changed in each, edited in place on purpose: `jq` and most editors
# reserialise the whole file, and a cut whose diff is not six lines is a cut a
# reviewer cannot check at a glance.
VERSION=x.y.z node -e '
  const fs = require("node:fs");
  const version = process.env.VERSION;
  for (const file of process.argv.slice(1)) {
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, before.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`));
  }
' "${files[@]}"

for file in "${files[@]}"; do jq -r --arg f "$file" '"\($f): \(.version)"' "$file"; done

# The line stamp (ADR 0036 D1) — one assignment on one line, so this is a `sed`
# and the diff stays one line like the six above. `-i.bak` because BSD `sed` on
# macOS requires an argument to `-i` and GNU `sed` accepts one.
sed -i.bak 's/^LINE=".*"$/LINE="x.y.z"/' install.sh && rm -f install.sh.bak
grep -n '^LINE=' install.sh                    # must print LINE="x.y.z"

git commit -a -F cut-message.txt               # Conventional Commits, see below
git push --no-verify origin beta/x.y.z         # --no-verify: see below
```

The push is what publishes `beta-x.y.z`, so the train has an image before
anything merges into it and a zero-merge train is still promotable (D7). It also
needs an actor that bypasses the `beta/*` ruleset — the repository owner does;
[`docs/rulesets/beta.json`](rulesets/beta.json) is what it is being bypassed.

Four things this has to get right, because nothing checks any of them until far
too late:

- **`--no-verify` on that push, or the hooks off for the cut.**
  `.husky/pre-push` does not know the `beta/*` class: its line 9 matches the
  branch against the naming convention alone, without the `beta/x.y.z`
  exemption that [`ci.yml`](../.github/workflows/ci.yml) carries at line 167
  for exactly this branch class (D1). So the hook refuses the push and hints
  `git branch -m`, which is the wrong thing to do to a train — the branch name
  *is* the version. You only meet this if you took `CONTRIBUTING.md`'s advice
  and ran `git config core.hooksPath .husky`, which you should have. Tracked
  as #269; when the hook learns the class, drop the `--no-verify`.
- **The diff is only the cut.** `git diff origin/main beta/x.y.z` is exactly
  those six manifests, `install.sh`'s stamp, and seven lines.
- **The line stamp.** [ADR 0036](adr/0036-the-beta-release-channel.md) D1 gives
  `install.sh` a stamped line version and says it is *"written by the cut exactly
  as the six manifests are"*. That is this procedure — the cut is the hand that
  writes it. [#317](https://github.com/actana/control/issues/317) put the stamp
  in the file and the resolution that reads it, and
  `scripts/__tests__/install-sh.test.mjs` asserts that the stamp is a plain
  `x.y.z` equal to the workspace version and that nothing in the file names a
  channel. **The separate `Train rules` assertion 0036 D4 asks for is not there
  yet**: #317 landed without touching `.github/workflows`, which another ticket
  held open across the same wave. Until it lands, nothing goes red on the train
  when a cut forgets the stamp — the check is this step and the test above it,
  so measure the `grep` output before you commit.
- **Every body line of the message is at most 132 characters.** `commitlint`
  lints every commit in a pull request, not just its title — but no pull
  request puts a cut commit in front of it until the promotion gate, when the
  only remedy left is deleting the train and starting over. Measure before
  committing, and again before promoting:

```bash
awk 'length($0) > 132 { print FILENAME " line " FNR ": " length($0) }' cut-message.txt
git log origin/main..beta/x.y.z --pretty=%B | awk 'length($0) > 132 { print FNR ": " length($0) }'
```

The commit message is the one the cut has always carried, and it is
Conventional Commits because it reaches `main` through the next promotion pull
request, where `ci.yml`'s `Conventions` job lints every commit in it:

```
chore(release): cut beta/x.y.z

Every manifest carries the train's version (ADR 0023 D3). Cut from main after
promoting <previous>, so a train is always open and work can always be
proposed (D25).
```

#### Nothing lets you forget

The invariant D25 protects — *a train is always open, so work can always be
proposed* — used to be held by the automatic cut. It is now held by two jobs
that cut nothing and name no version:

- **`promote.yml`'s `train-invariant`** runs at the end of every promotion. It
  says in the run's own log that the promotion cut no branch and computed no
  version, then asks origin whether a `beta/*` exists. When none does — the
  ordinary state one second after the promoted train is deleted — it opens the
  tracking issue *"No open train: nothing can be proposed until one is cut"*,
  carrying a link to this section.
- **`housekeeping.yml`'s `open-train`** asks the same question every morning
  and reuses that exact title, so the state cannot be closed away: an issue
  closed while no train exists is filed again on the next daily tick, and the
  one you cut the train for is closed by you, in the same gesture.

Neither is a red run. Every non-hotfix promotion ends with no train open, so a
job that failed on it would be red after every good release — which is how a
team learns that red means nothing.

#### Re-cutting a train

The version was wrong, or the train is being abandoned. **Before anything has
merged into it** this is one delete and one cut:

```bash
git push origin --delete beta/x.y.z            # nothing has merged into it
```

then the procedure above, with the name you actually want. There is no
delete-and-re-cut *dance* any more, because nothing guessed the name in the
first place — this is the same cut, done again.

**After something has merged into it**, the branch carries work and deleting it
throws that work away. Retarget the open pull requests, cherry-pick the squash
commits onto the new train, and only then delete the old one. That is also the
fallback when a post-hotfix rebase conflicts (D24).

### Working the train, and the freeze window

Every pull request targets the open train. Every merge into it republishes
`beta-x.y.z` (multi-arch, in the release repositories) and `sha-<short>` (in
the `-dev` ones). There are no path filters on that build, deliberately (D20):
a documentation-only merge that skipped it would leave `beta-x.y.z`'s revision
label naming an older commit, the promotion assertion would fail, and a README
fix would block the release.

**The freeze window** starts when the train is frozen for acceptance and ends
when it promotes: nothing merges anywhere in between. It exists because
`beta-x.y.z` moves on every merge, so a merge landing after the approver
finished testing would either promote untested bytes or — since it does not —
fail the digest assertion and cost the acceptance run. Its length is however
long promotion takes. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

If a train merge's image build goes red, `beta-x.y.z` does not move and the
train is quietly un-promotable. That is not left to surface at the dispatch,
after somebody has already worked the checklist against a stale image: the
failure opens an issue, and the `Train rules` check blocks the promotion pull
request while the train's latest push is red (D21).

### Accepting the beta

Pull `beta-x.y.z`, run it, and work
[`beta-acceptance-checklist.md`](beta-acceptance-checklist.md). This is the
human gate the whole design is built around — the image you approve is, byte
for byte, the image that ships.

The macOS pre-release checklist is worked at the same time, against the
**train tip** rather than against a tag that does not exist yet. By the digest
assertion that is the same commit, and it is available earlier.

### Promotion

**Before dispatching, delete every other `beta/*` branch on origin.**
`promote.yml`'s *Resolve* job globs `refs/heads/beta/*` and subtracts the train
being promoted: one branch surviving that subtraction *is* the hotfix condition
(D23), so a train that was merely abandoned is rebased onto the new `main` and
force-pushed and its images republished — see [§Hotfix trains](#hotfix-trains)
— while two survivors refuse the dispatch outright.

Open a pull request from `beta/x.y.z` into `main`, let its checks settle, get
it approved — then dispatch:

```bash
gh workflow run promote.yml --repo actana/control -f train=beta/0.1.0
```

**That pull request is a gate, not a merge. Do not press the merge button.** A
squash would produce a `main` commit whose SHA differs from the tested one,
which is exactly what the digest assertion cannot survive. GitHub closes the
pull request as merged on its own once its commits are reachable from `main`,
which the fast-forward makes true.

**`Promotion gate` is red on that pull request, and red is the healthy state**
(#264). Since one gate was squash-merged by hand and the release it carried
was abandoned, the button is not merely wrong — a required check refuses it.
The job runs on every pull request, exits successfully with a `::notice`
everywhere else, and on a `beta/* → main` pull request fails with the reason on
screen: D5, D16, and the dispatch above. So a promotion gate carries one
permanently red required check by design, and the *only* thing to do about it
is dispatch `promote.yml`. Nothing in the promotion reads it: `promote.yml`
reads that the pull request exists and takes its head SHA, and the App bypasses
required checks on the `main` ruleset, so the fast-forward is unaffected.

Its image checks do not rebuild anything, either. `Panel image` and `Core
image` are required on every pull request, and on a promotion they would
otherwise spend an hour producing bytes that already exist — so on a promotion
pull request they perform the digest assertion instead (D19). Seconds, same
check names, still green.

`promote.yml` then runs, in this order:

1. **The human pause.** A job gated on the `macos-release` environment, and
   everything else in the file is downstream of it — so `main` never contains
   unapproved code.
2. **Verify the digest** — every architecture, both images, against the
   promotion pull request's head SHA. The design reduces to this step.
3. **Fast-forward `main`** to that exact commit. Not a squash, not a merge
   commit; a non-fast-forward is an error, never a fallback.
4. **Push `vx.y.z`** as a record — it triggers nothing — then call `release.yml`
   by `workflow_call`.
5. **Cut `release/x.y`** if the line has none and **delete the promoted train**.
   Nothing cuts the next one: the run says so in its own log and opens the
   tracking issue when no train is left open — see
   [§ Nothing lets you forget](#nothing-lets-you-forget).

Every push in that workflow is made with the GitHub App identity and never with
`GITHUB_TOKEN`, and that is not a preference. **GitHub does not trigger
workflows from pushes made with the default token**, so a promotion using it
would push `vx.y.z` and produce no release, and would fast-forward `main`
without ever firing `landing.yml` — a landing-page change merged through a
train would quietly stop deploying, with nothing red anywhere (D39).

**Re-running after a failure.** Up to and including the fast-forward, a failed
run is re-runnable from the top: the promotion pull request is still open and
nothing is published. **After** it, it is not — `main` has moved, GitHub has
closed the pull request as merged, and the workflow will refuse. Recovery is
then per-step and manual: `gh workflow run release.yml -f tag=vx.y.z` re-runs
the publish, and the branch housekeeping is a `git push` each.

### What `release.yml` does with the tag

```bash
gh workflow run release.yml --repo actana/control -f tag=v0.1.0
```

That is the by-hand entry point, and the only way a backport releases at all.
**Pushing a `v*` tag does nothing** (D40): there is no tag trigger, because
keeping one beside the `workflow_call` would fire two release runs that could
not even block each other — `github.ref_name` is the tag under a tag push and
the *caller's* ref under a `workflow_call`, so the two would take different
concurrency keys and race to build the same tarballs and create the same
Release. A stray hand-pushed tag now does nothing at all, which is a stronger
property than a check that catches it.

`release.yml` resolves one of **two modes** from where the tag lives, and says
which in the log:

- **promote** — the tag is reachable from `main`. The image jobs re-point the
  `beta-x.y.z` digest at `<version>` (and `latest`, when the guard allows it)
  and build nothing, after asserting the digest was built from the promoted
  commit.
- **backport** — the tag is on a `release/*` branch. Its images are built from
  that branch, because no beta digest exists to promote.

The two Linux tarball legs and the installer e2e run straight away, the mac
tarball builds alongside them, the two image jobs follow, then the **npm
publish**, and the GitHub Release last of all. The npm job is in that position
deliberately and it is the only one that cannot be redone: it waits on both
image jobs, both tarball legs and the installer e2e, and the Release waits on
it, so a release never announces an `npm i` that 404s. See
[npm](#npm) for what it publishes and under which dist-tag. Each image's Docker
Hub page is no longer part of it — that syncs on a weekly clock now (D43). The
tag must already exist on origin.

`release.yml` attaches nothing until its arm64 installer legs are green
(see [The installer e2e](#the-installer-e2e-and-why-it-is-one-job-on-two-triggers)),
so a release takes a few minutes longer than the tarball builds alone.

**Two preconditions the workflow does not check for you.** Neither is enforced
in `release.yml`, so both are yours:

- **CI is green on the commit being released.** There is no `release-gate` job
  reading the tagged commit's check runs. On the promotion path the train's own
  checks and the promotion pull request cover this; on a hand-driven dispatch
  they do not.
- **The `macos-release` environment exists with required reviewers on it.**
  Without it there is no pause at all: GitHub auto-creates a referenced
  environment with **no protection rules**, so the gated job runs immediately
  and the promotion waves itself through — silently, and green. It is
  `promote.yml` that holds it. See [`REPO_SETUP.md`](REPO_SETUP.md) §2.

`resolve` does fail the run outright when `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`
or `NPM_TOKEN` is missing on `actana/control`, before anything is built — those
three the workflow does check. `NPM_TOKEN` is checked in the same shape and in
the same job as the Docker Hub pair, and for a sharper reason: the npm job is
last in the graph, so a token discovered missing at the publish would be
discovered with both images pushed and their `:latest` already re-pointed.

### The approval pause — a release waits for a person

The pause is the first job of `promote.yml`, and every other job in the file is
downstream of it — including the fast-forward, so `main` never contains
unapproved code. **Exactly one pause exists.** It used to sit on `release.yml`'s
macOS tarball leg; it moved (D15), and a second one reappearing anywhere would
be invisible in a green run, because it would look like a release nobody had
got round to approving yet.

The gated job goes to **waiting** the moment the run starts.

**Nothing leaves the repository until a reviewer approves.** No image moves, no
`:latest` moves, **no package reaches npm**, no GitHub Release appears, and
`main` does not advance.

That ordering costs a release the reviewer's own latency, and it buys the one
thing that makes "reject" a real answer: an image push is not undoable, and
`:latest` is a pointer with no history to roll back to. A reviewer who hits a
blocker and rejects has to be able to believe nothing shipped.

The npm publish is the item on that list that cannot be taken back **at all**.
An image tag is a pointer and can be re-pointed; an npm version number is
consumed by its first publish, and unpublishing inside the 72-hour window frees
the bytes and not the name. That is why it sits behind this pause and last
within the workflow, and why the packing is rehearsed on every pull request
long before a tag exists.

The pause is the manual test window, not a rubber stamp. Before dispatching and
approving, the reviewer:

1. Works [`beta-acceptance-checklist.md`](beta-acceptance-checklist.md) against
   the `beta-x.y.z` images — pull, compose up, pair a Core, check the CHANGELOG.
2. Builds the macOS tarball on their own Mac from the train tip —
   `pnpm core:tarball` on Apple silicon produces exactly the `mac-arm64` asset
   the release will — and works
   [`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md)
   against it: Gatekeeper on an unsigned bundle, the LaunchAgent surviving a
   reboot and a logout, the lifecycle verbs, a clean uninstall. Ten minutes.
3. Approves in the run's UI. Only then does anything publish.

An unticked box is a reason to **reject**: no release is better than one whose
macOS asset a person could not get working, because the assets an operator
downloads are the ones somebody said work. Who may approve is set up once, as
an admin step: [`REPO_SETUP.md`](REPO_SETUP.md) §2.

Because of the wait, a release does not "land in under six minutes" — the
automated part still does, and the rest is however long the person takes.

Never `git push --tags` — a clone made from the fork parent carries tags that
would collide with versions this repository never made; see
[`REPO_SETUP.md`](REPO_SETUP.md) §6.

### Hotfix trains

**A hotfix is an expedited train, not a bypass.** Cut `beta/x.y.z+1` from
`main`, cherry-pick the fix, and run the normal flow at speed. There is no
second publish path, and that is the point: a second path would be the one
used under time pressure, which is exactly when the machinery most needs to be
the one everybody has exercised. If it is too slow, the answer is faster CI.

Nothing is labelled "hotfix". The condition that matters is *a train was
promoted while another train existed*, which the workflow can see for itself
(D23) — a flag would have to be set by a human during an incident, which is
when it would be forgotten.

Promoting the hotfix strands the train that was already open: `main` moves past
its ancestor, so it can never fast-forward again. `promote.yml` therefore
**rebases the surviving train onto the new `main` and force-pushes it** — the
one exception to `beta/*` branch protection, and the only force-push in the
system (D24). Two obligations come with that rebase, and the workflow honours
both because neither is the natural way to write one:

- **The train's images are republished.** Every commit SHA on the train
  changed, so `beta-x.y.z` names an image whose revision label points at a
  commit that no longer exists. Left alone, the digest assertion fails at *that*
  train's promotion — long after the cause, and reading as "the train moved"
  when nothing moved. The workflow waits for the republish and then checks the
  registry, because "the push triggered a workflow" is exactly the assumption
  that is invisible when it is false.
- **Every open pull request into that train is told**, because its base was
  rewritten without it being asked. Approvals survive — they attach to the head
  — but conflicts can appear, and only the author can resolve them.

Nothing is cut after a hotfix promotion, and nothing is cut after any other
one either (D25, as amended by #325) — but the hotfix case is the one where the
invariant needs nothing done about it: the surviving train *is* the open train,
so `train-invariant` reports it and files nothing.

**If the rebase conflicts**, the workflow fails loudly and does not try to
resolve anything. The fallback is: abandon the surviving train, re-cut it from
`main` — per [§ Re-cutting a train](#re-cutting-a-train) — and cherry-pick its
squash commits. `main`, the tag and the release are
unaffected and correct — only that train needs the work.

### Backports and the supported lines

Backports are **the one documented exception to digest promotion**, and the
exception is bounded.

A severe bug's fix for current users rides a hotfix train, with the guarantee
intact. Users on an older line are served by a cherry-pick pull request into
that line's `release/x.y` branch, which publishes its own patch release **built
from the release branch** — no beta train exists for an old version, so there is
no beta digest to promote. The gate is pull request review plus full CI plus a
human-tested release candidate.

- **Release branches are named for the line, `release/x.y`** (D27). A branch
  cut at `1.2.0` that later publishes `1.2.4` is not `release/1.2.0`. Naming it
  for the minor line keeps the name true and makes "the supported lines"
  computable by listing and sorting `release/*`. `promote.yml` cuts the branch
  on the first promotion of a line and leaves it where it is on every later one
  — it marks where the line began, not where its newest patch is. Retired lines
  keep their branches as history.
- **The supported set is the last two minor lines.** **While the product is
  pre-1.0 it is the current line only** (D31): a `0.x` minor bump *is* the
  breaking change under semver, so backporting across `0.x` minors would be
  backporting across breaking changes. Backports begin meaning something at
  `1.0`. Anything older gets "upgrade to latest", which the one-command
  installer and the compose setup make cheap. The `Train rules` check computes
  the supported set and refuses a pull request based on a line outside it.
- **Forward-fix first, backport second, and the order is enforced** (D29). A
  fix that lands on a release line but never on `main` is reintroduced by the
  next minor — the classic silent backport regression. A required check on
  `release/*` pull requests asserts the fix already exists on `main` by
  patch-id, and a weekly housekeeping job diffs the release lines against `main`
  to catch one that is later reverted.
- **A backport publishes a release candidate first** (D30). `1.2.4-rc.1` is
  built from the release branch and pulled by a human before the real tag. It
  keeps "somebody ran these bytes" true of every published release rather than
  most of them — which would otherwise be false for precisely the releases
  carrying urgent fixes to the most conservative users.
- **A backport never moves `latest`, on Docker Hub or on GitHub** (D28), and
  two independent assertions enforce it. This is the failure that reaches every
  existing user: publishing `1.2.4` after `1.4.0` would move `:latest`
  backwards *and* make `/releases/latest` answer `v1.2.4` — which is what
  `install.sh` installs by default and what the in-product update checker
  compares against. Every 1.4.x user would be told to downgrade. Both library
  defaults do the wrong thing here and neither was written by anyone, so
  `--latest` is always passed explicitly and never defaulted.

### Rolling back

**Rollback re-points `latest` and flips the GitHub Release's latest flag.
Nothing else.** ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D44.)

```bash
# 1. Point :latest back at the last good version, on both images.
#    A retag, not a rebuild — the same command a promotion uses.
docker buildx imagetools create -t actana/panel:latest actana/panel:0.1.3
docker buildx imagetools create -t actana/core:latest  actana/core:0.1.3

# 2. Make /releases/latest answer the last good version.
#    install.sh and the in-product update checker both read this endpoint.
gh release edit v0.1.3 --repo actana/control --latest
```

Then verify both surfaces, because these are the two an operator actually
reaches:

```bash
docker buildx imagetools inspect actana/panel:latest   # digest == 0.1.3's
gh release view --repo actana/control --json tagName --jq .tagName
```

**`main`, the `vx.y.z` tag, and the release branch are never rewritten.** Not
reverted-by-force, not deleted, not moved. They are the record of what
happened, and the instinct at 2am is precisely to rewrite them — which is why
this is written down rather than left to judgement. `0.1.4` remains in the
record as a version that shipped and was rolled back, because losing the
ability to reason about the incident afterwards is a worse outcome than a bad
version staying in the history.

Rollback stops new pulls from getting bad bytes. It is not the fix. **The fix
goes forward, through a hotfix train** — see above — and it is what re-points
`latest` at something newer than the version you rolled back to.

Two things rollback does not do, and cannot:

- **It does not un-pull anything.** Operators pinned to `0.1.4`, or who pulled
  `latest` while it pointed there, are unaffected by the retag and need to be
  told. `:latest` is a pointer with no history.
- **It does not touch `beta-x.y.z` or the open train.** Those describe work in
  progress, not what shipped.

## Running CI locally

The five checks that gate every PR:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm scan:secrets
pnpm audit --prod --audit-level high
```

The container build:

```bash
pnpm panel:image:smoke      # builds deploy/panel.Dockerfile, then smokes it
pnpm core:tarball           # the Core image bakes this in, so build it first
pnpm core:image:smoke       # builds deploy/core.Dockerfile, then pairs a Panel with it
```

Commit conventions, without installing anything permanently:

```bash
base=origin/beta/0.2.0          # the branch you targeted — the open train, not main
d=$(mktemp -d) && cp commitlint.config.mjs "$d"
(cd "$d" && npm init -y >/dev/null && npm install @commitlint/cli @commitlint/config-conventional)
"$d"/node_modules/.bin/commitlint --config "$d"/commitlint.config.mjs \
  --cwd "$PWD" --from "$(git merge-base "$base" HEAD)" --to HEAD --verbose
```

`--from` is the merge-base with **the branch this pull request targets**, which
under the train model is the open train and not `main`
([`CONTRIBUTING.md`](../CONTRIBUTING.md#branch-naming)). `--from origin/main`
would lint every commit already merged into the train as well as your own, and
bounce you for somebody else's message. The merge-base is also what the
`Conventions` job passes: it reads `github.event.pull_request.base.sha`, which
is that same commit.

The detour through a temp directory is not ceremony: this is a pnpm workspace,
and the root `package.json` declares `workspace:*` dependencies that npm
refuses to parse (`EUNSUPPORTEDPROTOCOL`). Installing outside the checkout —
with the config copied alongside, so `extends` still resolves — is what the
`Conventions` job itself does.

## Notes for forks

A fork with no configuration still gets green pull request checks: a fork's PR
build never pushes, so it needs no registry credentials at all. Publishing —
the `pr-` images, the train's `beta-x.y.z` and `sha-<short>`, and releases —
requires setting `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` (and usually
`DOCKERHUB_NAMESPACE`) on the fork; without them a pushing build fails in
`resolve` with an annotation naming the fix. The `-dev` tag sweep also needs
`DOCKERHUB_CLEANUP_TOKEN`, and skips with a notice rather than failing when it
is absent.

The image name is derived from the namespace variable, never hardcoded, so a
fork publishes under its own account with no edit to any workflow — and
`ACTANA_IMAGE_NAMESPACE` in the reference compose points at it from the other
end.

PRs *from* a fork run without repository secrets even on this repository — that
is fine for the gate, and it is why the pull request image is a maintainer
convenience rather than a contributor one. See [The pull request
image](#the-pull-request-image-and-what-it-is-not).

Promotion needs more than credentials: `promote.yml` pushes with a GitHub App
that must exist and be a bypass actor on the `main` and `beta/*` rulesets. A
fork that has not set one up can run the gates and publish images, and cannot
promote. See [`REPO_SETUP.md`](REPO_SETUP.md) §2.
