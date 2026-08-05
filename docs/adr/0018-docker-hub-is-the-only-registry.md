# Docker Hub is the only registry — GHCR is retired

ADR 0016 shipped a two-registry posture: GHCR always (it authenticates with the workflow's own `github.token`, so it cannot fail on credentials), Docker Hub additionally when `DOCKERHUB_TOKEN` is set, with D31/D32 pinning the ordering and failure semantics that posture forces. In practice Docker Hub was always the canonical registry — the one D32 calls "primary", the one the descriptions job curates a page for, the one operators were meant to pull from — while the docs and the compose file still pointed at `ghcr.io`, and the GHCR packages (including a stale `actana-panel` left over from before the images were renamed) sat beside it as an unadvertised copy. Two registries meant two sets of published bytes to reason about, a soft-fail mirror dance in `container-image.yml` whose comments outweighed its code, and a package list on GitHub that had already drifted.

**This ADR retires GHCR entirely.** `container-image.yml` builds under the Docker Hub name and publishes only there; the callers drop `packages:` permissions; the compose file, docs, and issue template say `actana/panel` / `actana/core`; the GHCR packages are deleted from the org. D26's registry inventory shrinks by one, and D31/D32's "must not be fixed later" clauses are superseded — the ordering problem they pinned no longer exists when there is one registry.

The credential posture inverts cleanly:

- A **non-pushing build** (the PR path, `push: false`) needs no credentials, exactly as before.
- A **missing** credential on a pushing build fails in `resolve`, before anything is built, on any repo — there is no longer a registry that authenticates for free, so "publish to GHCR alone and succeed" is not a state that can exist.
- A **broken** credential fails at `docker login`, before any tag is pushed. The old soft-fail ("publish GHCR completely, fail at the very end") existed to keep a broken *mirror* from costing the primary; with one registry there is nothing to protect and a hard fail is honest.

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
