# The Panel as one container (ADR 0010): plain HTTP out, every piece of state
# in the single AC_PANEL_DATA_DIR volume, TLS left to the proxy in front.
#
#   docker build -t actana-panel .
#   docker run -p 127.0.0.1:7420:7420 -v actana-panel-data:/data actana-panel
#
# The reference deployment with HTTPS lives in deploy/docker-compose.yml;
# every knob the image reads is documented in DEPLOY.md.

# Same Node CI tests against (scripts/__tests__/panel-image.test.mjs pins the
# match). The full bookworm image carries the toolchain better-sqlite3's
# native build needs; none of it reaches the runtime stage.
FROM node:24.15.0-bookworm AS build

RUN npm install -g pnpm@11.1.2

WORKDIR /app

# Lockfile-only layer first, so dependency installation — the slow, rarely
# changing step — survives source edits in the Docker cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/require-node-24.mjs scripts/
COPY packages/core/package.json packages/core/
COPY packages/panel/package.json packages/panel/
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

FROM node:24.15.0-bookworm-slim

# `image.source` is what links the package to its repository on GHCR — without
# it the package page has no README and no provenance. An ARG rather than a
# literal so a fork's build links to the fork; CI passes its own values.
# Docker Hub ignores all of this and reads its description from the API
# instead (.github/workflows/dockerhub-description.yml).
ARG IMAGE_SOURCE=https://github.com/actana/control
ARG IMAGE_REVISION=
LABEL org.opencontainers.image.title="Actana Panel" \
      org.opencontainers.image.description="Self-hosted web Panel for driving agentic coding work across your machines. Deploy this one; pair a Core per machine." \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    AC_PANEL_DATA_DIR=/data

WORKDIR /srv/panel
COPY --from=build /srv/panel ./

# The volume must be writable by the unprivileged user before Docker seeds it;
# a bind mount is the operator's own permission problem (see DEPLOY.md).
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 7420
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const p=process.env.AC_PANEL_PORT??7420;fetch(\`http://127.0.0.1:\${p}/api/healthz\`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "bin/panel.mjs"]
