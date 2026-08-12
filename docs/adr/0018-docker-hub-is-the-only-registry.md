# Docker Hub is the only registry — GHCR is retired

ADR 0016 shipped a two-registry posture: GHCR always (it authenticates with the workflow's own `github.token`, so it cannot fail on credentials), Docker Hub additionally when `DOCKERHUB_TOKEN` is set, with D31/D32 pinning the ordering and failure semantics that posture forces. In practice Docker Hub was always the canonical registry — the one D32 calls "primary", the one the descriptions job curates a page for, the one operators were meant to pull from — while the docs and the compose file still pointed at `ghcr.io`, and the GHCR packages (including a stale `actana-panel` left over from before the images were renamed) sat beside it as an unadvertised copy. Two registries meant two sets of published bytes to reason about, a soft-fail mirror dance in `container-image.yml` whose comments outweighed its code, and a package list on GitHub that had already drifted.

**This ADR retires GHCR entirely.** `container-image.yml` builds under the Docker Hub name and publishes only there; the callers drop `packages:` permissions; the compose file, docs, and issue template say `actana/panel` / `actana/core`; the GHCR packages are deleted from the org. D26's registry inventory shrinks by one, and D31/D32's "must not be fixed later" clauses are superseded — the ordering problem they pinned no longer exists when there is one registry.

The credential posture inverts cleanly:

- A **non-pushing build** (the PR path, `push: false`) needs no credentials, exactly as before.
- A **missing** credential on a pushing build fails in `resolve`, before anything is built, on any repo — there is no longer a registry that authenticates for free, so "publish to GHCR alone and succeed" is not a state that can exist.
- A **broken** credential fails at `docker login`, before any tag is pushed. The old soft-fail ("publish GHCR completely, fail at the very end") existed to keep a broken *mirror* from costing the primary; with one registry there is nothing to protect and a hard fail is honest.

## Amended 2026-08-12 by [#159](https://github.com/actana/control/issues/159): npm is a second registry

**Read the title as "Docker Hub is the only registry the images go to".** As of [#129](https://github.com/actana/control/issues/129) D13 this repository also publishes two npm packages — `@actana/sdk` and `@actana/cli` — from `release.yml`, on the same tag that builds the images and at the same version as everything else. That is the first npm publish this repository has ever done, and it makes "one registry" false as a sentence about the repository while leaving every argument in this ADR intact.

**Nothing above is reversed.** GHCR stays retired; the images have one registry and it is Docker Hub; `container-image.yml` is untouched by this amendment. The reason is that GHCR and Docker Hub were two copies of *the same bytes* — a mirror, and the whole case against it was that a mirror doubles what you must reason about and buys nothing. npm is not a copy of anything. It is a different artifact for a different consumer: an operator pulls an image to run a Panel or a Core, and a developer installs a package to write a program against one. Publishing both is not a two-registry posture; it is one artifact per audience.

**The credential posture extends by exact analogy, with one addition.** A missing `NPM_TOKEN` is fatal in `resolve`, before anything is built, in the same shape and for the same reason as the Docker Hub pair — the two checks are deliberately separate steps, because "a credential is missing" is not an actionable sentence when there are two. A broken token fails at `npm publish`. The addition is that a `publish` needs `id-token: write` on its job to attest what it published; that permission is granted to the `npm` job and to no other job in the workflow.

**What does not carry over is the property this ADR's central mechanism rests on.** A container tag is a pointer: promote mode re-points `beta-x.y.z` at `x.y.z` and builds nothing, and the entire immutability claim ([ADR 0023](0023-release-trains-and-digest-promotion.md) D16, D17) is stated in terms of digests that can be re-pointed and re-pushed. **An npm version number is consumed by its first publish.** Unpublishing within npm's 72-hour window frees the bytes and not the name, so `@actana/sdk@0.2.2` can never mean anything else, on any later train, and the only recovery from a bad publish is to burn the next number too. Three things follow, and they are why this is an amendment rather than a line in a workflow:

- **The npm job is last.** It waits on both tarball legs, the installer e2e, and both image publishes. Everything else in a release either has not happened yet or can be redone; a version number cannot, so nothing is burned until every gate that could stop a release has passed.
- **The publish is rehearsed before it can happen.** `scripts/rehearse-npm-publish.mjs` packs every publishable package and asserts the tarball — the engines floor, the absence of any install-time lifecycle script, compiled JS with `.d.ts` beside it, and a file list that is a whitelist. It runs on **every pull request** through `pnpm test`, long before a tag exists, and again in the release on the tarballs that are then published. There is no equivalent for an image because there does not need to be: a bad image is replaced by a better one under the same tag.
- **Provenance is asserted, not arranged.** `npm publish --provenance` from a job without `id-token: write` fails; a publish that quietly stopped passing the flag *succeeds*, and is indistinguishable in the log from one that did not. So the release reads the attestation back off the registry afterwards and fails if it is absent, and `publishConfig.provenance` is set inside the package as well — the trap here is a silent success, and a check that only ever ran before the fact could not catch it.

**Docker Hub keeps one thing npm does not have: a curated page.** `housekeeping.yml`'s weekly `descriptions` chore ([ADR 0023](0023-release-trains-and-digest-promotion.md) D43) syncs four Docker Hub repositories from `docs/images/`. npm renders the package's own `README.md` out of the published tarball, so there is nothing on a clock to keep in step and no fifth surface to drift — which is the same reasoning D43 used, arriving at the opposite mechanism because the registry offers one.

## Considered Options

- **Keep GHCR as a mirror (status quo, rejected).** The mirror was doing no work: no deployment pulled from it, the docs that mentioned it contradicted the ADR that called Docker Hub primary, and its existence forced the most convoluted code in the pipeline — the dual-login, soft-fail, stitch-per-registry dance.
- **Keep GHCR and drop Docker Hub (rejected).** GHCR's free authentication is genuinely convenient, but the Docker Hub org, its curated per-image pages, and operator muscle memory (`actana/panel` with no registry prefix) all point the other way — and Docker Hub is where the pull traffic already is.
- **Flip the mirror direction — Docker Hub primary, GHCR best-effort (rejected).** Keeps every line of the soft-fail complexity and both package lists, for a copy nobody is told about.

## Consequences

- **Forks can no longer publish images with zero configuration.** The PR path still works untouched, but a fork that wants edge tags or releases must set `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` (and usually `DOCKERHUB_NAMESPACE`). This was the one real property GHCR bought; it is traded away knowingly.
- **The GHCR packages (`panel`, `core`, `actana-panel`) are deleted manually** — the org packages UI, or a token with `read:packages` + `delete:packages`. Anything still pulling `ghcr.io/actana/…` breaks on its next pull; as of this writing nothing is known to.
- **`packages: write` disappears from every workflow**, shrinking the workflow token's blast radius.
- The OCI `image.source` / `image.description` labels stay: Docker Hub ignores them, but `docker image inspect` and any label-reading UI still finds the source repository.
- D26's note that `gcr.io` is a "third registry" now reads as second; the dependency itself is unchanged.
