# The Actana Core image — a Core you *run*, not a machine you install one on.
# Spec: ADR 0016 §B and §C.
#
# The image is the install (D13). There is no versioned tree, no `current`
# symlink, no unit file, no lingering to enable and no init system inside:
# the image tag is the version, the ENTRYPOINT is the unit, `restart:
# unless-stopped` is the auto-start, and `docker compose pull && up -d` is the
# update. The metal path — install.sh, `actana setup`, a user service — is
# untouched and unrelated; this is a second distribution, not a replacement.
#
# CVE posture, stated accurately (D6) — measured on this file, on 2026-08-04,
# and written up in docs/research/core-base-measure/core-image-2026-08-04.md.
#
# The base did change, but the base is NOT the mechanism, and anyone
# summarising it that way will mislead the next reader. The base contributes
# **6** distinct CVEs. The package set is where the number lives:
# `build-essential` pulls `libc6-dev` pulls `linux-libc-dev`, and
# `linux-libc-dev` alone accounts for **1200 of the 1227** distinct findings
# in this image. Take that one package out and the same build measures 15.
#
# The toolchain stays anyway (D7), because it is what the product is: a Core
# exists to run Harnesses against real repos, and `npm install` on any project
# with a native addon invokes node-gyp, which needs make, g++ *and* python3.
# This repo is the proof — it depends on better-sqlite3 and node-pty, so a
# Core without the toolchain cannot even `pnpm install` Actana Control. Those
# findings are kernel headers under /usr/include with no executable code, on a
# kernel that belongs to the host. D7 suppresses them with a single justified
# entry in a checked-in allowlist — `.trivyignore.rego` at the repo root,
# landed by #38 along with the gate that reads it. A raw scan of this image
# still reports 1246 distinct; 46 survive the suppression, and none of the
# 1200 is a fixable CRITICAL or HIGH.
#
# Two figures from D6 do NOT survive measurement, and this file is the wrong
# place to repeat them:
#
#   ~38 distinct  → measured 46 after suppression. The extra rows are Node and
#                   npm, which the D6 baseline did not carry.
#   ~190 MB       → measured 805 MB, and ~190 MB is not reachable with the
#                   toolchain in: it is the toolchain-free row. build-essential
#                   and python3 are +272 MB, Node and the Core tarball +330 MB.
#                   ADR 0016 records the correction.

# Both halves of this pin are load-bearing and they do different jobs (D5).
#
#   The digest, because `24.04` is a *rolling* tag — it moves on every point
#   release, so the tag on its own is not a pin at all.
#
#   `apt-get upgrade -y`, in the same RUN below, because apt resolves
#   `noble-security` at build time. That is what lets a weekly rebuild on an
#   *unchanged* digest still collect every fix Canonical has shipped since.
#   Without it the digest freezes the CVEs too and the rebuild cadence is
#   theatre.
#
# This is deliberately against the stock "pin it and stop" advice: here,
# drifting toward noble-security is the point, and the digest bounds the drift.
# Alpine and node:24-alpine were eliminated on the musl gate — the glibc Node
# bundled in the Core tarball exits 127 for a missing ELF interpreter.
#
# ubuntu:24.04 == noble-20260730.1 at the time of writing.
FROM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

# ARG, not ENV: `noninteractive` is right for this build and wrong for the
# interactive shells a Harness opens later, so it must not survive the build.
ARG DEBIAN_FRONTEND=noninteractive

# One layer, upgrade before install — see the pin note above. Out, on purpose:
# `zip`, `wget`, `gnupg`, and every init-system package the dev fixture needed.
# In, newly: `lsof`, without which pty-manager.ts's port-conflict probe is
# silently a no-op — which is what it is in today's dev Core.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      bash sudo ca-certificates curl git openssh-client \
      build-essential python3 \
      ripgrep jq less vim-tiny unzip lsof xz-utils \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Node 24 for the *system*, from nodejs.org, SHA-256 verified against that
# release's own SHASUMS256.txt — the pattern scripts/lib/core-tarball.mjs
# already implements (D8). This Node exists only for `npm i -g @openai/codex`
# and other Harness-run npm work; the daemon execs the Node bundled inside its
# own tarball and never touches this one.
#
# DO NOT "simplify" this to `apt-get install nodejs`. It looks like a dozen
# lines saved and it is two regressions in a single edit: noble ships Node
# **18**, not 24; and `nodejs` lives in *universe*, whose security updates are
# Ubuntu Pro-gated — so the package would be both the wrong major *and* off
# the free security stream. There is no apt answer to reach for instead: no
# stable Debian or Ubuntu suite carries Node 24, and no `-backports` suite
# carries `nodejs` at all. NodeSource and every other third-party apt repo are
# out for the same reason the tarball is in — this is a download we verify,
# not a publisher we trust.
ARG NODE_VERSION=24.19.0
# npm newer than the one Node bundles, because that is where the image's only
# fixable CRITICAL/HIGH live: npm's vendored tar/undici/brace-expansion under
# /usr/local/lib/node_modules/npm. 11.19.0 clears four of the seven measured
# on 2026-08-04, including the lone CRITICAL (tar); no released npm clears all
# seven, so this pays findings down — it does not green a raw scan.
#
# 11.19.0 and NOT 12.x, though 12.0.2's vendored tree is identical for all
# four (measured from both published tarballs, #82): npm 12 ships allowScripts
# off by default, which blocks dependency preinstall/install/postinstall AND
# the implicit `node-gyp rebuild` for any binding.gyp package — the exact
# capability build-essential/python3 above exist to serve, and how Harness
# postinstalls run. Crossing that major is a product decision for an ADR, not
# a rider on a CVE bump.
#
# The tarball is fetched from the registry and SHA-512-checked against the
# digest pinned below — the same "download we verify" footing as the Node
# fetch above (D8); a bare `npm install -g npm@x` would be publisher trust.
# The hex is that release's registry dist.integrity, base64-decoded; the two
# ARGs move together, on the same #51 cadence as NODE_VERSION.
ARG NPM_VERSION=11.19.0
ARG NPM_SHA512=48377f8478372aa1c4e47b763475b135836da82436a5700f2e5e8eb5084fc840f93c7b117eb3ad3b5f7d3194c81b6710a10d59448f6ddbcb21ac3fb672bdc003
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    dist="https://nodejs.org/dist/v${NODE_VERSION}"; \
    archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "${dist}/${archive}"; \
    curl -fsSLO "${dist}/SHASUMS256.txt"; \
    grep " ${archive}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${archive}" -C /usr/local --strip-components=1 \
        --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    rm -f "${archive}" SHASUMS256.txt; \
    npm_tgz="npm-${NPM_VERSION}.tgz"; \
    curl -fsSL -o "${npm_tgz}" "https://registry.npmjs.org/npm/-/${npm_tgz}"; \
    echo "${NPM_SHA512}  ${npm_tgz}" | sha512sum -c -; \
    npm install -g "${npm_tgz}"; \
    rm -f "${npm_tgz}"; \
    npm cache clean --force; \
    rm -rf /root/.npm; \
    node --version; \
    [ "$(npm --version)" = "${NPM_VERSION}" ]

# uid 1000 and gid 1000, by number, always (D12).
#
# Both halves are measured, not guessed. Ubuntu 24.04 ships a stock
# `ubuntu:x:1000:1000` account, so 1000 is already taken, and noble also ships
# a *group* called `operator`. Let useradd pick, and it lands on 1001:100 —
# at which point every file a Harness writes into a bind-mounted repo is owned
# by a uid that exists nowhere on the operator's host, and the operator cannot
# read back their own working tree. So: delete the stock user, then pin both
# ids explicitly.
#
# `core` rather than `operator` because the Operator is already the human who
# logs into the Panel.
RUN userdel --remove ubuntu \
 && groupadd --gid 1000 core \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash core

# NOPASSWD sudo, for `core` and for nobody else (D12). A Core's entire purpose
# is arbitrary work on real repos, and without this a mid-session "install a
# system dependency" is a dead end.
#
# There is deliberately no accommodation for overriding `user:` in compose.
# It half-works, and half-working is worse than a refusal: sudoers matches by
# name/uid, so an overridden uid gets no sudo at all, and NPM_CONFIG_PREFIX
# below points at a home that uid cannot write — so `actana harnesses install`
# fails even if sudo were widened. A host whose login user is not uid 1000 has
# two supported answers: chown the bind-mounted directory to 1000:1000, or use
# a named volume and let the Core own the repos.
RUN echo "core ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/core \
 && chmod 0440 /etc/sudoers.d/core

# The Core itself, from the release tarball built for this architecture. It
# arrives as a named build context because artifacts/ is .dockerignore'd:
#
#   docker build --build-context tarball=artifacts/core -f deploy/core.Dockerfile
#
# Extracted flat into /opt/actana rather than into the versioned
# `versions/<v>` + `current` layout `actana setup` builds on metal: in a
# container the image tag is the version, so a `current` symlink would point
# at exactly one tree for the life of the image.
#
# It has to arrive as a named context: the build context is `deploy/`, and the
# tarball is built into `artifacts/` at the repo root, which is outside it.
#
# Bind-mounted rather than COPYed, and that is worth 47 MB: a COPY of the
# tarball is its own layer, so `rm`ing it in the next instruction deletes it
# from the filesystem and not from the image. `--build-context` already
# requires BuildKit, so `--mount=…,from=<context>` asks for nothing new.
#
# The architecture check is in the build rather than in a smoke step because
# an arch-mismatched tarball is a build input error, and finding it here names
# the cause instead of surfacing as `exec format error` at first boot.
RUN --mount=type=bind,from=tarball,target=/mnt/tarball \
    set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) target=linux-x64 ;; \
      arm64) target=linux-arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    set -- /mnt/tarball/actana-core-*-linux-*.tar.gz; \
    [ "$#" -eq 1 ] || { echo "expected exactly one Core tarball, found $#: $*" >&2; exit 1; }; \
    case "$1" in \
      *"-${target}.tar.gz") ;; \
      *) echo "tarball $1 is not built for ${target}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/actana; \
    tar -xzf "$1" -C /opt/actana --strip-components=1; \
    chown -R root:root /opt/actana

# Harnesses (claude-code, codex, cursor-cli, opencode) are deliberately NOT
# baked (D9). They are ~1.15 GB of what would be a ~1.4 GB image, they add
# about one finding between them, they ship on their own cadences and are
# stale within days of any build, and baking them would redistribute four
# vendors' binaries under licences nobody has cleared. They install at runtime
# — `actana setup --with-<id>`, `actana harnesses install <id>` — into $HOME,
# which is the persistent volume, so they survive every image upgrade and
# self-update in place. Baked binaries would do neither.

USER core
WORKDIR /home/core

# Created here, owned by `core`, because Docker seeds a fresh named volume
# from the image's content *and* mode at the mount path: get this wrong and
# every new deployment gets a home the Core cannot write to.
RUN mkdir -p /home/core/.local/bin \
             /home/core/.local/share/actana/data \
             /home/core/.config/actana

# The operator contract is three variables, and the minimum for a working
# Core is one (D15):
#
#   ACTANA_PUBLIC_HOST  required — the host a Panel will dial.
#   ACTANA_PORT         8443
#   ACTANA_LABEL        the name the Panel shows for this Core
#
# The image never guesses the public host. choosePublicHost() takes the first
# routable IPv4, which is reasonable on metal and a trap in a container: a
# bare `docker run` has a container-ID hostname, so a guessing default would
# silently change the cert SAN on every recreation.
#
# Everything below is a private image constant and NOT part of that contract.
# ACTANA_CONTAINER is how container mode is detected — never by sniffing
# /.dockerenv (D16) — and is what makes `setup`/`install`/`start`/`stop`/
# `restart`/`update`/`uninstall` refuse and name their Docker equivalent. The
# client nouns — `core`, `project`, `harness`, `events`, `session` — are never
# refused here: since #288 the tarball's `actana` is the *whole* command, so a
# Session running on this Core can drive Cores out of the box and the
# `actana-sessions` skill the Core installs is honest on the machine it lands
# on. That is also why NPM_CONFIG_PREFIX's bin coming first on PATH no longer
# decides anything: `npm i -g @actana/cli` would put the same program there.
# There is deliberately no `npm install` in this image — an image whose
# contents depend on what is on the registry at build time is not reproducible
# from this repository (ADR 0032 D7).
ARG ACTANA_PORT=8443
ENV ACTANA_PORT=${ACTANA_PORT} \
    ACTANA_CONTAINER=1 \
    AC_CORE_REMOTE=1 \
    AC_CORE_LINK_HOST=0.0.0.0 \
    AC_APP_PATH=/opt/actana/app \
    AC_USER_DATA_DIR=/home/core/.local/share/actana/data \
    AC_CORE_MATERIAL_FILE=/home/core/.config/actana/material.json \
    NPM_CONFIG_PREFIX=/home/core/.local \
    PATH=/home/core/.local/bin:/opt/actana/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# The same ARG, so the exposed port cannot drift from the documented default.
EXPOSE ${ACTANA_PORT}

# tini is PID 1; the daemon is PID 2 (D14). node-pty forks a shell and the
# shell forks a Harness, so when the shell exits first that Harness reparents
# to PID 1 — and libuv only waitpid()s children Node spawned itself. A Core
# running as PID 1 therefore accumulates zombies until the PID table fills.
# Baked in rather than left to `--init` / `init: true`, because those are
# opt-in and anyone copying a bare `docker run` off a README would get the
# broken configuration by default. tini is 10 kB and is not a supervisor.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["actana", "daemon"]
