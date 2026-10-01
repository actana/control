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
# CVE posture, stated accurately (D6) — measured on 2026-08-04, across this
# file and cut-down variants of it, scanned with Trivy. The write-up of that
# run was deleted in 96f7b07 and is readable at 96f7b07^.
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
# `sudo` is deliberately absent (#558). System packages a Harness needs are
# baked here; an agent cannot install more at run time. Privilege drop uses
# `setpriv` from util-linux, which is Essential on this base — do not add it.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client \
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

# Two users, both by number (D12, ADR 0041 D11, #559).
#
# `core` is uid 1000 and gid 1000, always. Both halves are measured, not
# guessed. Ubuntu 24.04 ships a stock `ubuntu:x:1000:1000` account, so 1000 is
# already taken, and noble also ships a *group* called `operator`. Let useradd
# pick, and it lands on 1001:100 — at which point every file a Harness writes
# into a bind-mounted repo is owned by a uid that exists nowhere on the
# operator's host, and the operator cannot read back their own working tree. So:
# delete the stock user, then pin both ids explicitly. `core` is who every
# Session runs as; `operator` is taken, because the Operator is already the
# human who logs into the Panel.
#
# `actana` is uid 1001 and gid 1001: the daemon's own system user (D6 of the
# #559 plan), with no login shell and `/var/lib/actana` as its home. It owns
# the pairing identity and the database, which `core` cannot read. The number is
# pinned so the image smoke can assert it and so a volume keeps its owner across
# image upgrades.
RUN userdel --remove ubuntu \
 && groupadd --gid 1000 core \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash core
RUN groupadd --system --gid 1001 actana \
 && useradd --system --uid 1001 --gid 1001 --no-create-home --home-dir /var/lib/actana --shell /usr/sbin/nologin actana

# No sudoers, and no `sudo` package (#558). ADR 0016 D12's NOPASSWD grant is
# retired; the ADR that replaces it is #554. The image never contains a helper
# that lets `core` become root, and there are no file capabilities anywhere:
# `actana` holds CAP_SETUID and CAP_SETGID as ambient capabilities from the
# entrypoint's switch, which is what lets it start a Session as `core`, and a
# file capability or a setuid bit is how a Session would turn that into more.
# Bind-mount ownership repair runs in a separate root one-shot (compose
# `core-init`, or `docker run -u 0 --entrypoint
# /usr/local/libexec/core-fs-prep.sh`); named volumes are seeded with their
# owners below so a plain `docker run` needs no prep.
#
# There is deliberately no accommodation for overriding `user:` in compose. The
# container starts as root for exactly one step, the entrypoint's switch to
# `actana`, and it cannot make that switch from any other user: `user: "1000"`
# or `user: "1001"` stops at the entrypoint with a message. A host whose login
# user is not uid 1000 has two supported answers: chown the bind-mounted
# directory to 1000:1000, or use a named volume and let the Core own the repos.

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

# Harnesses (claude-code, codex, cursor-cli, opencode, pi) are deliberately NOT
# baked (D9). They are ~1.15 GB of what would be a ~1.4 GB image, they add
# about one finding between them, they ship on their own cadences and are
# stale within days of any build, and baking them would redistribute five
# vendors' binaries under licences nobody has cleared. They install at runtime
# — `actana setup --with-<id>`, `actana harnesses install <id>` — into $HOME,
# which is the persistent volume, so they survive every image upgrade and
# self-update in place. Baked binaries would do neither.

# Seed paths Docker will copy into a fresh named volume at these mount points.
# Ownership must be core:core in the image: a root-owned seed makes every new
# deployment unwritable by the daemon. `shared` is the Shared folder (#561's
# contract starts here as an empty local dir). `repos` is seeded for named
# volumes; a host bind mount that Docker created as root is repaired by the
# one-shot `core-fs-prep.sh` (compose `core-init`), mount point only.
RUN mkdir -p /home/core/.local/bin \
             /home/core/shared \
             /home/core/repos \
 && chown -R core:core /home/core

# The daemon's own state (#559) is not in that home: pairing identity, the
# database, the update caches and, later, the Shared-folder key live in
# /var/lib/actana, which compose mounts as the `core-state` volume (seeded from
# this directory, so the owner and the mode below are what a new volume gets).
# `data` and `config` are what AC_USER_DATA_DIR and AC_CORE_MATERIAL_FILE name;
# `shared` is reserved for #561/#562. Mode 0700 and owned by `actana`: `core`,
# whom every Session runs as, cannot read any of it.
#
# /run/actana is the hook miss drop box: the one place a Session may append to
# and the daemon reads, as untrusted input. The directory must exist in the
# image because the daemon may not be able to create it under /run; the file in
# it is made by the daemon at boot (harness-hook-delivery.ts).
RUN mkdir -p /var/lib/actana/data /var/lib/actana/config /var/lib/actana/shared /run/actana \
 && chown -R actana:actana /var/lib/actana /run/actana \
 && chmod 0700 /var/lib/actana /var/lib/actana/data /var/lib/actana/config /var/lib/actana/shared \
 && chmod 0711 /run/actana

# Bind-mount prep only — run as root from compose `core-init` or an equivalent
# one-shot `docker run -u 0 --entrypoint …`. No privilege-escalating binary.
RUN mkdir -p /usr/local/libexec
COPY core-fs-prep.sh /usr/local/libexec/core-fs-prep.sh
RUN chown root:root /usr/local/libexec/core-fs-prep.sh \
 && chmod 0755 /usr/local/libexec/core-fs-prep.sh

COPY core-entrypoint.sh /usr/local/bin/core-entrypoint.sh
RUN chmod 0755 /usr/local/bin/core-entrypoint.sh

# Last root step (#558): strip every setuid/setgid bit the base packages ship
# (su, mount, passwd, ssh-keysign, unix_chkpwd, …). no-new-privs on the daemon
# and on compose exec is not enough — a plain `docker exec` shell has neither.
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} +

# The image starts as root, on purpose and for one step only (#559). Docker gives
# a non-root USER no capabilities, and Docker never sets ambient ones, so a
# daemon that must keep CAP_SETUID and CAP_SETGID cannot be started as `actana`
# directly: the entrypoint, which needs uid 0, switches to it with `setpriv` and
# keeps exactly those two. After that `exec` no process of this container runs
# as root except tini (PID 1), which holds nothing but the compose capability
# set. `docker exec` without `-u` is therefore root *without* any DAC override:
# it cannot read /home/core or /var/lib/actana. Use `docker exec -u core` for a
# Session's view and `docker exec -u actana` for `actana pair`.
#
# WORKDIR is `/`, not the home: that root has no CAP_DAC_OVERRIDE, and the home
# is 0750 core:core, so a start or an exec that tried to enter it would fail.
USER 0:0
WORKDIR /

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
#
# **ACTANA_ROOT is what makes that true of `daemon` as well.** The `daemon` verb
# has to find `app/core-entry.cjs`, and it looks in ACTANA_ROOT first and then at
# the managed install's `current` symlink. The tarball's own `bin/actana` exports
# ACTANA_ROOT for itself, so CMD works — but an `npm i -g @actana/cli` inside the
# container lands its shim first on PATH with neither answer available, and the
# next start would say "no Core is installed here" instead of booting a daemon.
# Setting it in the image is what leaves the collision with no outcome to decide:
# whichever `actana` runs, it is the same program and it finds the same tree.
#
# There is no `HOME` here (#559): the image no longer has one user. The runtime
# sets it from the account of whoever runs, so `docker exec -u core` gets
# /home/core and `-u actana` gets /var/lib/actana; the entrypoint sets the
# daemon's. The identity of `core` (AC_CORE_HOME, AC_CORE_UID, AC_CORE_GID) is
# not here either: only the daemon needs it, the entrypoint exports it for the
# daemon alone, and a CLI run with `docker exec -u core` must not believe it is
# the daemon and wrap its own children in a `setpriv` it has no capability for.
#
# The two AC_ paths are the state directory, not the home (#559). They are spelt
# out here because an ENV line cannot call a function; `CORE_STATE_DIR` in
# packages/shared/src/actana-container-contract.ts is the one the code uses, and
# a test compares the two.
ARG ACTANA_PORT=8443
ENV ACTANA_PORT=${ACTANA_PORT} \
    ACTANA_CONTAINER=1 \
    AC_CORE_REMOTE=1 \
    AC_CORE_LINK_HOST=0.0.0.0 \
    ACTANA_ROOT=/opt/actana \
    AC_APP_PATH=/opt/actana/app \
    AC_USER_DATA_DIR=/var/lib/actana/data \
    AC_CORE_MATERIAL_FILE=/var/lib/actana/config/material.json \
    NPM_CONFIG_PREFIX=/home/core/.local \
    PATH=/home/core/.local/bin:/opt/actana/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# The same ARG, so the exposed port cannot drift from the documented default.
EXPOSE ${ACTANA_PORT}

# tini is PID 1; the entrypoint checks the state volume, then switches to
# `actana` (uid 1001) with CAP_SETUID and CAP_SETGID as ambient capabilities and
# no-new-privs, and execs CMD (D14 + #558 + #559). Bind-mount prep is not here —
# see core-fs-prep.sh / core-init.
#
# node-pty forks a shell and the shell forks a Harness, so when the shell
# exits first that Harness reparents to PID 1 — and libuv only waitpid()s
# children Node spawned itself. A Core running as PID 1 therefore accumulates
# zombies until the PID table fills. Baked in rather than left to `--init` /
# `init: true`, because those are opt-in and anyone copying a bare `docker
# run` off a README would get the broken configuration by default. tini is
# 10 kB and is not a supervisor.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/core-entrypoint.sh"]
CMD ["actana", "daemon"]
