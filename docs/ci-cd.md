# CI/CD

What runs, when, and what it publishes. Admin-side setup (secrets, required
checks, labels) lives in [`REPO_SETUP.md`](REPO_SETUP.md).

## At a glance

| Workflow | Trigger | Produces |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | every PR | nothing — it gates |
| [`ci.yml`](../.github/workflows/ci.yml) | push to `main` | `:edge`, `:sha-<short>` |
| [`release.yml`](../.github/workflows/release.yml) | `workflow_call` from the promotion, or a dispatch — **not** a `v*` tag ([ADR 0023](adr/0023-release-trains-and-digest-promotion.md) D40) | Core tarballs + checksums, `:<version>`, `:latest` when it is the highest version, the GitHub Release |
| [`housekeeping.yml`](../.github/workflows/housekeeping.yml) | daily cron | stale labels / closures |
| [`housekeeping.yml`](../.github/workflows/housekeeping.yml) | weekly cron | a rebuilt-and-republished Core image, a `NODE_VERSION` bump PR, and an issue for anything the dev-tree audit or the Harness canary found |
| [`landing.yml`](../.github/workflows/landing.yml) | push to `main` under `landing/**`, or dispatch | `landing/` uploaded to Bunny Edge Storage and the pull zone purged — the page at control.actana.ai |

`ci.yml` is one file doing two jobs, and the trigger is the difference. On a
PR it gates and pushes nothing; on a push to `main` it publishes `:edge` and
`:sha-<short>` from the same reusable build. That fold is [ADR
0016](adr/0016-the-0-1-0-shape.md) D30 — an edge publish that differs from the
PR build only in which tags come out the other end does not need a workflow
file of its own. The repo conventions — PR title, commit messages, branch name
— are the `Conventions` job inside it (D34).

`housekeeping.yml` is everything on a clock and nothing that gates. Its five
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

Both container images have **one** build implementation:
[`container-image.yml`](../.github/workflows/container-image.yml), a reusable
workflow called by the PR, edge, release, and weekly-rebuild paths with
`image: panel` or `image: core`. That is deliberate — the bytes a PR validates
are built exactly the way the bytes a release publishes are, rather than by a
lookalike pipeline that drifts.

## The published images

| Image | What it is |
| --- | --- |
| `actana/panel` | The Panel web service. **This is the one you deploy.** |
| `actana/core` | The Core daemon. **A second, supported way to run a Core.** |

Both are published to Docker Hub (`docker.io/actana/…`) — the only registry
([ADR 0018](adr/0018-docker-hub-is-the-only-registry.md)).

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

A tag therefore publishes exactly four release assets —
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
`packages/core/src/actana-release.ts`, which are required to agree on every
shape, refusals included.

The Panel and the Core are version-locked at runtime: the core-link
handshake exchanges a protocol version, and a mismatched pair renders as "needs
update" in the Panel. So tag both together — one `v*` tag builds both.

## Container image tags

| Tag | Moves | Use it for |
| --- | --- | --- |
| `:latest` | on every non-prerelease version tag | the default; what the reference compose pulls |
| `:<version>` e.g. `:0.1.0` | never | pinning a deployment |
| `:edge` | on every push to `main` | trying what is about to ship |
| `:sha-<short>` | never | pinning to an exact commit, e.g. to bisect |

A prerelease tag (`v1.0.0-rc.1`) publishes `:1.0.0-rc.1` and deliberately does
**not** move `:latest`.

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

**Docker Hub, and nothing else**
([ADR 0018](adr/0018-docker-hub-is-the-only-registry.md) — GHCR was retired).
It authenticates with the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets, so:

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

### `gcr.io` is a second registry, and it is in the build path

Docker Hub as the sole registry is a decision about **publishing**. Pulling
the Panel's runtime base from `gcr.io/distroless/nodejs24` is a different thing
in a different direction: an availability and rate-limit dependency on Google's
registry, on **every single build** — every PR that touches the Panel image,
every push to `main`, every release, and every weekly rebuild. It is accepted
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

[`housekeeping.yml`](../.github/workflows/housekeeping.yml) is the third and
last workflow ([ADR 0016](adr/0016-the-0-1-0-shape.md) D34) and the only one
that is not a check. Seven chores on two crons:

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
the cron it claims — and that the directory still holds exactly three entry
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
permission level rather than a repository list (ADR 0023 D38, as amended), so
that list is the only guard there is. `gh workflow run housekeeping.yml -f
chore=dev-tag-sweep -f dry-run=true` reports what it would delete without
deleting it.

## Cutting a release

> **This section describes the pre-train flow and is being replaced.** Under
> [ADR 0023](adr/0023-release-trains-and-digest-promotion.md) a release is a
> **promotion**, not a tag push: `promote.yml` pauses for the human,
> fast-forwards `main`, pushes `vx.y.z` as a record and calls `release.yml` by
> `workflow_call`. Two clauses of that are already true in `release.yml` and
> contradict what follows, so they are stated here rather than left to
> surprise someone:
>
> - **Pushing a `v*` tag does nothing at all** (D40). The tag trigger is gone;
>   keeping it beside the `workflow_call` would fire two racing release runs.
>   `gh workflow run release.yml -f tag=v0.1.0` is how a release is driven by
>   hand, and it is how a backport releases at all.
> - **The macOS leg no longer waits for anybody** (D15). The pause moved to the
>   head of `promote.yml`, which is upstream of the whole release — so it now
>   also gates the fast-forward onto `main`. Exactly one pause exists.
>
> The full rewrite of this page — the train model, the tag ladder and the
> rollback runbook — is #113.

```bash
gh workflow run release.yml --repo actana/control -f tag=v0.1.0
```

The two Linux tarball legs and the installer e2e run straight away, the mac
tarball builds alongside them, and the two image jobs and the GitHub Release
follow. Each image's Docker Hub page is no longer part of it — that syncs on a
weekly clock now (D43). The tag must already exist on origin.

`release.yml` resolves one of **two modes** from where that tag lives (D26). A
tag reachable from `main` is a **promotion**: the image jobs re-point the
`beta-x.y.z` digest a human already ran at `<version>` and build nothing, after
asserting the digest was built from the promoted commit (D16, D17). A tag on a
`release/*` branch is a **backport**: no beta train exists for an old line, so
its images are built from that branch — the one documented exception in the
design, and it keeps the CVE gate. A backport never moves `:latest`, on Docker
Hub or on GitHub (D28).

`release.yml` attaches nothing until its arm64 installer legs are green
(see [The installer e2e](#the-installer-e2e-and-why-it-is-one-job-on-two-triggers)),
so a tag takes a few minutes longer than the tarball builds alone.

**Two preconditions the workflow does not check for you.** Neither is enforced
in `release.yml`, so both are yours:

- **CI is green on the commit you are tagging.** There is no `release-gate` job
  reading the tagged commit's check runs — a tag on a red commit builds and
  publishes exactly like a tag on a green one. Look at the commit's checks
  before you push the tag.
- **The `macos-release` environment exists with required reviewers on it.**
  Without it there is no pause at all: GitHub auto-creates a referenced
  environment with no protection rules, so the gated job runs immediately and
  the release publishes unreviewed — silently, not as a red build. The
  environment is no longer referenced from `release.yml` (D15); it is
  `promote.yml` that will hold it, and until that lands nothing references it.
  See [`REPO_SETUP.md`](REPO_SETUP.md) §2.

`resolve` does fail the run outright when `DOCKERHUB_USERNAME` or
`DOCKERHUB_TOKEN` is missing on `actana/control`, before anything is built —
that one the workflow does check.

### The approval pause — a release waits for a person

> **The pause has moved out of `release.yml` (ADR 0023 D15).** What follows
> describes it correctly except for *where* it sits: it is the first step of
> `promote.yml` rather than the `tarball-macos` job, which means it now gates
> the fast-forward onto `main` as well, and the reviewer builds their tarball
> from the train tip rather than from the tag. Exactly one pause exists.

The gated job goes to **waiting** the moment the run starts, and only
unpublished machine work proceeds while it waits.

**Nothing leaves the repository until a reviewer approves.** Every publishing
job sits downstream of the pause: no image, no moved `:latest`, no GitHub
Release ([ADR 0016](adr/0016-the-0-1-0-shape.md) D28, as amended; ADR 0023
D15).

That ordering costs a release the reviewer's own latency, and it buys the one
thing that makes "reject" a real answer: an image push is not undoable, and
`:latest` is a pointer with no history to roll back to. A reviewer who hits a
blocker and rejects has to be able to believe nothing shipped. For the same
reason a `SHA256SUMS` covering fewer architectures than the docs promise is
worse than a release that is late.

The pause is the manual test window, not a rubber stamp. Before approving,
the reviewer:

1. Builds the tarball on their own Mac from the commit under review —
   `pnpm core:tarball` on Apple silicon produces exactly the `mac-arm64` asset
   the release will. Nothing has been built yet, so there is nothing to
   download.
2. Works through
   [`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md)
   against it — Gatekeeper on an unsigned bundle, the LaunchAgent surviving a
   reboot and a logout, the lifecycle verbs, a clean uninstall. Ten minutes.
3. Approves in the run's UI. Only then does the mac leg spend a runner minute,
   and only then do the images and the Release publish.

An unticked box is a reason to **reject**: no release is better than one whose
macOS asset a person could not get working, because the assets an operator
downloads are the ones somebody said work. Who may approve is set up once, as
an admin step: [`REPO_SETUP.md`](REPO_SETUP.md) §2.

Because of the wait, a release no longer "lands in under six minutes" — the
automated part still does, and the rest is however long the person takes.

Push one tag deliberately, never `git push --tags` — a clone made from the fork
parent carries tags that would fire a release run each for versions this
repository never made; see [`REPO_SETUP.md`](REPO_SETUP.md) §6.

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
d=$(mktemp -d) && cp commitlint.config.mjs "$d"
(cd "$d" && npm init -y >/dev/null && npm install @commitlint/cli @commitlint/config-conventional)
"$d"/node_modules/.bin/commitlint --config "$d"/commitlint.config.mjs \
  --cwd "$PWD" --from origin/main --to HEAD --verbose
```

The detour through a temp directory is not ceremony: this is a pnpm workspace,
and the root `package.json` declares `workspace:*` dependencies that npm
refuses to parse (`EUNSUPPORTEDPROTOCOL`). Installing outside the checkout —
with the config copied alongside, so `extends` still resolves — is what the
`Conventions` job itself does.

## Notes for forks

The PR path works in a fork with no configuration: a PR build never pushes,
so it needs no registry credentials at all. Publishing — the edge tags on a
push to `main`, and releases — requires setting `DOCKERHUB_USERNAME` /
`DOCKERHUB_TOKEN` (and optionally `DOCKERHUB_NAMESPACE`) on the fork; without
them a pushing build fails in `resolve` with an annotation naming the fix.

PRs *from* a fork run without repository secrets — that is fine, because the
PR build is the non-pushing one.
