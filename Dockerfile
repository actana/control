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
COPY packages/harness/package.json packages/harness/
COPY packages/panel/package.json packages/panel/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

# Harness first: the Panel's build imports its types (devDependency), same
# order as the repo's root `pnpm build`.
RUN pnpm --filter @actana/harness build && pnpm --filter @actana/panel build

# A pruned production install of just the Panel. `deploy` excludes gitignored
# files (dist/ among them), so the built output is copied in on top.
RUN pnpm --filter @actana/panel deploy --prod --legacy /srv/panel \
  && rm -rf /srv/panel/dist \
  && cp -R packages/panel/dist /srv/panel/dist \
  && cp -R packages/panel/bin /srv/panel/bin

FROM node:24.15.0-bookworm-slim

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
