# The Panel as one container (ADR 0010): plain HTTP out, every piece of state
# in the single AC_PANEL_DATA_DIR volume, TLS left to the proxy in front.
#
#   docker build -f deploy/panel.Dockerfile -t actana-panel .   # from the repo root
#   docker run -p 127.0.0.1:7420:7420 -v actana-panel-data:/data actana-panel
#
# The reference deployment with HTTPS lives in deploy/docker-compose.yml;
# every knob the image reads is documented in DEPLOY.md.
#
# The runtime is distroless (ADR 0016 D20–D23). That is a CVE decision, not a
# size one — measured on the built image, 192 findings became 14, of which the
# OS accounts for 12 (libc6 and zlib1g, no CRITICAL and no HIGH). Nothing else
# in the image has a CVE because there is nothing else in the image: no shell,
# no package manager, no toolchain. That last part is a real cost paid on
# purpose: `docker exec panel sh` does not work, and debugging goes through
# `docker exec panel /nodejs/bin/node -e …`, `docker cp`, or a sidecar sharing
# the container's namespaces.

# Same Node CI tests against (scripts/__tests__/panel-image.test.mjs pins the
# match). The full image carries the toolchain better-sqlite3's native build
# needs; none of it — and none of its CVEs — reaches the runtime stage.
#
# trixie, not bookworm, so both stages are Debian 13 (D25). The prototype built
# on bookworm's glibc 2.36 and ran on trixie's 2.41, which works only because
# glibc is backward-compatible in that direction; the reverse breaks. Aligning
# the stages removes the reliance rather than documenting it.
FROM node:26.8.1-trixie AS build

RUN npm install -g pnpm@11.1.2

WORKDIR /app

# Lockfile-only layer first, so dependency installation — the slow, rarely
# changing step — survives source edits in the Docker cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/require-node-24.mjs scripts/
COPY packages/core/package.json packages/core/
COPY packages/panel/package.json packages/panel/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

# Core first: the Panel's build imports its types (devDependency), same
# order as the repo's root `pnpm build`.
RUN pnpm --filter @actana/core build && pnpm --filter @actana/panel build

# A pruned production install of just the Panel. `deploy` excludes gitignored
# files (dist/ among them), so the built output is copied in on top.
RUN pnpm --filter @actana/panel deploy --prod --legacy /srv/panel \
  && rm -rf /srv/panel/dist \
  && cp -R packages/panel/dist /srv/panel/dist \
  && cp -R packages/panel/bin /srv/panel/bin

# Distroless has no shell, so there is no RUN in the runtime stage and /data
# cannot be created there. Stage the empty directory here and COPY it across.
# Deliberately no chown/chmod: it would be discarded (see the COPY below).
RUN mkdir -p /staged/data

# gcr.io/distroless/nodejs24 — Debian 13, Node 24.x, ENTRYPOINT
# ["/nodejs/bin/node"], so CMD below is argv to node rather than a command
# line. Pinned by digest because the repository carries 6,980 tags and not one
# of them contains a version number: four mutable names plus opaque build
# SHAs, so a tag is not a pin and the Node patch version would drift silently
# between builds. Renovate/Dependabot must update the digest (D20).
#
# The default tag, not `:nonroot`: every distroless variant already ships
# `nonroot:x:65532:65532` in /etc/passwd, so the USER below drops privilege
# exactly as the tag would — and states the posture here instead of inheriting
# it from a tag name.
FROM gcr.io/distroless/nodejs24@sha256:2e3b3a96d1d7286c3e4727f9c84b4dc32b6b33e7d7d4425c5a5c8186ad85fa93

# `image.source` is what links the image back to its repository for
# `docker image inspect` and any label-reading registry UI. An ARG rather than
# a literal so a fork's build links to the fork; CI passes its own values.
# Docker Hub ignores all of this and reads its description from the API
# instead (the `descriptions` job in .github/workflows/release.yml).
ARG IMAGE_SOURCE=https://github.com/actana/control
ARG IMAGE_REVISION=
# `image.version` is the **line** these bytes carry — `0.4.1`, never
# `beta-0.4.1` and never `0.4.1-beta`. It is what lets an image say what it is
# rather than only which commit it came from, and it is what
# `container-image.yml` asserts before re-pointing `x.y.z`, `latest` or a beta
# tag at a digest (ADR 0037 D4). Empty by default so a local `docker build`
# still works; CI passes the version out of the manifests it just asserted.
ARG IMAGE_VERSION=
LABEL org.opencontainers.image.title="Actana Panel" \
      org.opencontainers.image.description="Self-hosted web Panel for driving agentic coding work across your machines. Deploy this one; pair a Core per machine." \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    AC_PANEL_DATA_DIR=/data

WORKDIR /srv/panel
COPY --from=build /srv/panel ./

# The --chown here is the whole mechanism, and it is the single easiest thing
# in this file to break by "simplifying". Measured: COPY recreates the
# *destination* directory as root:root 0755 and discards the staged
# directory's ownership *and* mode — ownership only survives for entries
# *inside* a copied tree, and /staged/data is empty. Docker seeds a fresh
# named volume from the image's content and mode at this path, so a staged
# `chown` instead of this flag gives every new deployment a /data the Panel
# cannot write to. The prototype's first build shipped exactly that bug.
#
# A bind mount is still the operator's own permission problem — and the uid to
# chown it to is 65532, not the 1000 the `node` user used to have.
COPY --from=build --chown=65532:65532 /staged/data /data

# Numeric, not `nonroot`: Kubernetes' runAsNonRoot admission check cannot
# resolve a username and fails the pod rather than the check. The `node` user
# (uid 1000) does not exist in this base at all.
USER 65532:65532

EXPOSE 7420
VOLUME /data

# Exec form with an absolute path. `["node", ...]` does NOT work: HEALTHCHECK
# argv bypasses ENTRYPOINT and distroless's PATH has no /nodejs/bin, so the
# naive form reports UNHEALTHY even for a script that cannot fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["/nodejs/bin/node", "-e", "const p=process.env.AC_PANEL_PORT??7420;fetch(`http://127.0.0.1:${p}/api/healthz`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The script path alone — node is the ENTRYPOINT, so this is argv to it.
# Leaving "node" in the array makes node try to run a file literally named
# `node`.
CMD ["bin/panel.mjs"]
