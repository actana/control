#!/bin/sh
# Core image entrypoint (#558, #559).
#
# This is the one step of the container that runs as root, under tini (PID 1):
# it checks the state volume and switches to `actana` (uid/gid 1001), keeping
# exactly CAP_SETUID and CAP_SETGID as inheritable, ambient and bounding
# capabilities, with no-new-privs. That pair is what lets the daemon start a
# Session as `core` (the `asCore` wrapper) and nothing else. Docker gives a
# non-root USER no capabilities and never sets ambient ones, so this switch
# cannot be done by `USER actana`; it needs a process that still has them.
#
# After the `exec` below no process of this container is root except tini, which
# holds only what compose granted (cap_drop ALL, cap_add SETUID SETGID).
#
# It refuses anything that is not that shape, and says why:
#   - not uid 0: a run as 1000 or 1001 cannot make the switch (`user:` in compose,
#     `docker run -u`). The daemon must not start as `core`, and as `actana` it
#     would have no capabilities.
#   - /var/lib/actana is not actana:actana mode 0700 (or is a link): the state
#     volume arrived with the wrong owner or mode. It is never repaired here, and
#     never with `chown -R`: the owner is repaired by the root one-shot (compose
#     `core-init`, or `docker run -u 0 --entrypoint
#     /usr/local/libexec/core-fs-prep.sh …`), which does not touch the mode of
#     a directory that exists.
#
# Absolute paths for everything run as root: the image PATH starts with the
# volume-writable ~/.local/bin, and a fake `id`, `stat` or `setpriv` planted there
# would run as root with CAP_SETUID.
set -eu

ACTANA_UID=1001
ACTANA_GID=1001
CORE_UID=1000
CORE_GID=1000
STATE=/var/lib/actana

uid=$(/usr/bin/id -u)
if [ "$uid" -ne 0 ]; then
  echo "core-entrypoint: must start as root (uid 0), not uid ${uid}: the entrypoint's one root step is the switch to actana (uid ${ACTANA_UID})" >&2
  echo "core-entrypoint: do not set user: in compose or run with -u; use docker exec -u core or -u actana for a shell" >&2
  exit 1
fi

if [ -L "$STATE" ] || [ ! -d "$STATE" ]; then
  echo "core-entrypoint: ${STATE} must be a directory, not a link and not missing; mount the core-state volume there" >&2
  exit 1
fi
found=$(/usr/bin/stat -c '%u:%g %a' "$STATE")
if [ "$found" != "${ACTANA_UID}:${ACTANA_GID} 700" ]; then
  echo "core-entrypoint: ${STATE} is ${found} (uid:gid mode), expected ${ACTANA_UID}:${ACTANA_GID} 700; refusing to start and not repairing it here" >&2
  echo "core-entrypoint: the owner is repaired by core-init (core-fs-prep.sh, as root); a mode other than 0700 is for you to chmod, as root" >&2
  exit 1
fi

# The daemon's own environment. HOME is actana's, not root's; the identity of
# `core` is for the daemon only (a CLI run by `docker exec -u core` must not
# take it, see core.Dockerfile).
export HOME="$STATE" USER=actana LOGNAME=actana
export AC_CORE_HOME=/home/core AC_CORE_UID="$CORE_UID" AC_CORE_GID="$CORE_GID"

exec /usr/bin/setpriv \
  --reuid="$ACTANA_UID" --regid="$ACTANA_GID" --clear-groups \
  --inh-caps=+setuid,+setgid --ambient-caps=+setuid,+setgid --bounding-set=+setuid,+setgid \
  --no-new-privs -- "$@"
