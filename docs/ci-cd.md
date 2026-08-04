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
| [`core-release.yml`](../.github/workflows/core-release.yml) | `v*` tag | Core tarballs + checksums, gated on the arm64 installer e2e |
| [`dockerhub-description.yml`](../.github/workflows/dockerhub-description.yml) | `docs/images/**` on `main` | each image's Docker Hub page |
| [`base-pins.yml`](../.github/workflows/base-pins.yml) | weekly cron | a `NODE_VERSION` bump PR, or nothing |
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
| `actana/core` | The Core daemon. **A second, supported way to run a Core.** |

Both are published to GHCR (`ghcr.io/actana/…`) and Docker Hub
(`docker.io/actana/…`) under the same tags.

`actana/core` is built from [`../deploy/core.Dockerfile`](../deploy/core.Dockerfile)
and is a Core you run rather than a machine you install one on: `tini` is PID 1
and `actana daemon` is its child, there is no init system inside, and it needs
neither `--privileged` nor a host cgroup. The image is the install — the tag is
the version, the entrypoint is the unit, and `docker compose pull && up -d` is
the upgrade ([ADR 0016](adr/0016-the-0-1-0-shape.md) §C).

Installing on a machine you own — `install.sh` plus `actana setup` plus a user
service, see [`../INSTALL.md`](../INSTALL.md) — is untouched and equally
supported. The container is a second distribution, not a replacement.

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
- **The Core, as a container** comes from the same workflow → `ghcr.io/actana/core`.
- **The Core** — the thing a real Core actually runs — is a per-platform
  tarball. `core-release.yml` → four targets (`mac-arm64`, `mac-x64`,
  `linux-x64`, `linux-arm64`) with published checksums, which `install.sh` and
  `actana update` verify against.

The Panel and the Core are version-locked at runtime: the core-link
handshake exchanges a protocol version, and a mismatched pair renders as "needs
update" in the Panel. So tag both together — a `v*` tag fires both workflows.

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
| `v*` tag | [`core-release.yml`](../.github/workflows/core-release.yml) `installer-e2e` | ubuntu, debian — **arm64** |

Distro is the axis that earns its place on every PR: PAM, polkit and the logind
rules that decide whether a sudo-less `systemctl --user` and `loginctl
enable-linger` work at all are exactly what differs between distributions.
Architecture is not — the arch-sensitive risk is prebuilt native modules, and
`core-tarball-smoke` already boots the arm64 tarball on an arm64 runner on every
PR. So arm64's installer leg is paid for once per release instead of once per
push, and it **gates `publish`**: an arm64 tarball the one-liner cannot install
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

Only the third row is live as written. `dependency-audit` in
[`ci.yml`](../.github/workflows/ci.yml) still runs without `--prod`, which is
[#47](https://github.com/actana/control/issues/47)'s change and needs
`pnpm update -r postcss @babel/core` alongside it (D39); the weekly dev-tree
audit arrives with `housekeeping.yml`
([#51](https://github.com/actana/control/issues/51)). The table is the policy,
not a description of today's workflow files.

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
| `ARG NODE_VERSION=…` | [`core.Dockerfile`](../deploy/core.Dockerfile) | [`base-pins.yml`](../.github/workflows/base-pins.yml) |
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
each, and prints what has moved. `base-pins.yml` runs it weekly.

It exists because two of the three have failure modes a config file cannot
rule out:

- The distroless pin follows the `latest` tag. If that tag ever leaves the
  registry's tag list, Dependabot's `latest_digest` returns nothing and the
  updater goes **quiet** — no error, no PR, and the Panel's runtime silently
  stops being updated. The checker fails loudly on exactly that.
- `ARG NODE_VERSION` is a nodejs.org tarball (D8), not an image reference.
  Dependabot's `docker` ecosystem cannot see it at all, so without this nothing
  bumps it and the Core's system Node drifts a patch release at a time.
  `base-pins.yml` opens that PR itself.

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

### `gcr.io` is a third registry, and it is in the build path

Docker Hub primary and GHCR mirror is a decision about **publishing**. Pulling
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
  layers are inside the image operators pull from Docker Hub or GHCR.
- **The Core image does not have this dependency.** It builds `FROM ubuntu`,
  which is Docker Hub, so an outage at one registry does not stop both images.
- **Anonymous pulls are rate-limited per source IP**, and GitHub-hosted runners
  share theirs. The build pulls one base per job, so this has room; a fan-out
  that built the Panel image many times in parallel would not.
- **There is no mirror configured, deliberately.** Copying the base into GHCR
  and building `FROM` that would trade Google's availability for a copy that
  can go stale and for a second thing Dependabot would have to be taught to
  update. The pin is a digest, so a `gcr.io` outage delays a build; it cannot
  change what a build produces.

Three registries are therefore in play, doing three different jobs:

| Registry | Role | Fails how |
| --- | --- | --- |
| `gcr.io` | pulls the Panel's runtime base | no Panel image can be built |
| Docker Hub | pulls `ubuntu` and `node`; publishes both images (primary) | no Core image can be built; publishing is skipped if credentials are absent |
| GHCR | publishes both images (always) | release fails — there is no fallback for the primary publish target |

## Cutting a release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

That fires `images-release.yml` and `core-release.yml` in parallel. If a
release needs rebuilding, both workflows accept a `workflow_dispatch` with the
tag name — the tag must already exist on origin.

`core-release.yml` attaches nothing until its arm64 installer legs are green
(see [The installer e2e](#the-installer-e2e-and-why-it-is-one-job-on-two-triggers)),
so a tag takes a few minutes longer than the tarball builds alone.

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
Conventions workflow itself does.

## Notes for forks

Everything works in a fork with no configuration: GHCR uses the fork's own
token and namespace, Docker Hub steps skip, and the PR build never pushes.

PRs *from* a fork run without repository secrets — so `DOCKERHUB_TOKEN` is
empty there and the publishing steps skip. That is expected, not a failure.
