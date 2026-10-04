#!/bin/sh
# Core image entrypoint (#558, #559).
#
# This is the one step of the container that runs as root: it checks the runtime
# and the state volume, then switches to `actana` (uid/gid 1001), keeping exactly
# CAP_SETUID and CAP_SETGID as inheritable and ambient capabilities (the bounding set
# is the container's, and is checked here, not set), with no-new-privs. That pair is
# what lets the daemon start a Session as `core` (the `asCore` wrapper) and nothing
# else. Docker gives a non-root USER no capabilities and never sets ambient ones,
# so this switch cannot be done by `USER actana`; it needs a process that still
# has them.
#
# The switch comes BEFORE tini, not after it: this script is the container's
# ENTRYPOINT and ends in `exec setpriv … -- tini -- <daemon>`, so tini is still
# PID 1 but is uid 1001 with the same ambient set. A root tini without CAP_KILL
# could not forward SIGTERM to a uid-1001 daemon (EPERM, and tini treats that as
# fatal), so `docker stop` would be a hard kill. As uid 1001 it signals its child
# and reaps what is reparented to it. The only process of this container that is
# ever root is this script, before the `exec`.
#
# It refuses anything that is not that shape, and says why:
#   - not uid 0: a run as 1000 or 1001 cannot make the switch (`user:` in compose,
#     `docker run -u`). The daemon must not start as `core`, and as `actana` it
#     would have no capabilities.
#   - the bounding set is not exactly CAP_SETUID and CAP_SETGID (compose's
#     `cap_drop: ALL` + `cap_add: SETUID SETGID`). `setpriv` cannot narrow it
#     without CAP_SETPCAP, which the daemon must not have, so a wider one is
#     refused instead of silently inherited.
#   - /var/lib/actana is not actana:actana mode 0700 (or is a link): the state
#     volume arrived with the wrong owner or mode. It is never repaired here, and
#     never with `chown -R`: the owner is repaired by the root one-shot (compose
#     `core-init`, or `docker run -u 0 --entrypoint
#     /usr/local/libexec/core-fs-prep.sh …`), which does not touch the mode of
#     a directory that exists.
#
# Absolute paths for everything run as root, and for the daemon, as well as a PATH
# of root-owned directories: a fake `id`, `stat`, `setpriv`, `tini` or `actana`
# planted in the volume-writable ~/.local/bin (which is on a Session's PATH, and on
# no PATH of the image's or the daemon's) must never be found and run with CAP_SETUID.
set -eu

ACTANA_UID=1001
ACTANA_GID=1001
CORE_UID=1000
CORE_GID=1000
STATE=/var/lib/actana
# CAP_SETGID is bit 6 and CAP_SETUID bit 7.
EXPECTED_BOUNDING=00000000000000c0

uid=$(/usr/bin/id -u)
if [ "$uid" -ne 0 ]; then
  echo "core-entrypoint: must start as root (uid 0), not uid ${uid}: the entrypoint's one root step is the switch to actana (uid ${ACTANA_UID})" >&2
  echo "core-entrypoint: do not set user: in compose or run with -u; use docker exec -u core or -u actana for a shell" >&2
  exit 1
fi

bounding=
while read -r field value; do
  [ "$field" = "CapBnd:" ] && bounding=$value
done < /proc/self/status
if [ "$bounding" != "$EXPECTED_BOUNDING" ]; then
  echo "core-entrypoint: the bounding set is ${bounding:-unreadable}, expected ${EXPECTED_BOUNDING} (only CAP_SETUID and CAP_SETGID)" >&2
  echo "core-entrypoint: run with cap_drop: ALL and cap_add: SETUID, SETGID (docker run --cap-drop ALL --cap-add SETUID --cap-add SETGID)" >&2
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
# A PATH of root-owned directories only: nothing a Session can write, or swap a
# binary in, is searched. (The image PATH is the same list; the smoke reads this
# process's PATH back from /proc and checks every directory on it is root-owned.)
export PATH=/opt/actana/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

exec /usr/bin/setpriv \
  --reuid="$ACTANA_UID" --regid="$ACTANA_GID" --clear-groups \
  --inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid \
  --no-new-privs -- /usr/bin/tini -- "$@"
