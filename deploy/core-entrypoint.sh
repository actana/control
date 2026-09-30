#!/bin/sh
# Core image entrypoint (#558).
#
# Image USER is 1000:1000. Filesystem prep for bind mounts is a separate
# root one-shot (compose `core-init`, or `docker run -u 0 --entrypoint
# /usr/local/libexec/core-fs-prep.sh …`) — never this process. We never held
# capabilities, so there is no bounding-set to drop; set no-new-privs so any
# remaining privileged bits stay inert. Refuse to start as uid 0: a mistaken
# `docker run -u 0` must not boot the daemon as root. tini is PID 1.
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "core-entrypoint: refusing to start as root; use USER 1000:1000" >&2
  echo "core-entrypoint: bind-mount prep is: docker run -u 0 --entrypoint /usr/local/libexec/core-fs-prep.sh …" >&2
  exit 1
fi

export HOME=/home/core

exec setpriv --no-new-privs -- "$@"
