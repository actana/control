#!/bin/sh
# Root-only filesystem prep for the Core image, then drop to `core` for good.
#
# The image has no sudo and no sudoers (see #558; retires ADR 0016 D12, whose
# replacement ADR is #554). Root is used only here, at container start:
# create/fix ownership of the home, the Shared folder, the daemon state
# directory, and a root-owned workspace bind mount (#551), then never again.
#
# setpriv comes from util-linux on the Ubuntu base — do not apt-get install
# anything for this drop. tini remains PID 1; this script execs into the
# daemon so the process tree stays tini → daemon.
set -eu

CORE_USER=core
CORE_HOME=/home/core
SHARED_DIR="${CORE_HOME}/shared"
STATE_DIR="${CORE_HOME}/.local/share/actana/data"
CONFIG_DIR="${CORE_HOME}/.config/actana"
# Compose still bind-mounts here; Docker creates a missing host dir as root.
WORKSPACE_DIR="${CORE_HOME}/repos"

# Own the path as core when it exists but is not already uid/gid 1000.
# Directory only — never chown -R a bind-mounted tree of host checkouts.
ensure_core_owned() {
  path=$1
  mkdir -p "$path"
  owner=$(stat -c '%u:%g' "$path")
  if [ "$owner" != "1000:1000" ]; then
    chown "${CORE_USER}:${CORE_USER}" "$path"
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  ensure_core_owned "${CORE_HOME}"
  ensure_core_owned "${CORE_HOME}/.local"
  ensure_core_owned "${CORE_HOME}/.local/bin"
  ensure_core_owned "${CORE_HOME}/.local/share"
  ensure_core_owned "${CORE_HOME}/.local/share/actana"
  ensure_core_owned "${STATE_DIR}"
  ensure_core_owned "${CORE_HOME}/.config"
  ensure_core_owned "${CONFIG_DIR}"
  ensure_core_owned "${SHARED_DIR}"
  ensure_core_owned "${WORKSPACE_DIR}"

  exec setpriv --reuid="${CORE_USER}" --regid="${CORE_USER}" --init-groups -- "$@"
fi

exec "$@"
