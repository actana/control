#!/bin/sh
# Core image entrypoint (#558).
#
# Image USER is 1000:1000. Filesystem prep for bind mounts is a separate
# root one-shot (compose `core-init`, or `docker run -u 0 --entrypoint
# /usr/local/libexec/core-fs-prep.sh …`) — never a setuid helper, and never
# this process. We never held capabilities, so there is no bounding-set to
# drop; set no-new-privs so setuid binaries in the image stay inert. tini is
# PID 1; this script execs CMD.
set -eu

export HOME=/home/core

exec setpriv --no-new-privs -- "$@"
