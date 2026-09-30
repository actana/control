#!/bin/sh
# Root filesystem prep for the Core image, then drop to `core` for good.
#
# The image has no sudo and no sudoers (see #558; retires ADR 0016 D12, whose
# replacement ADR is #554). Image USER is `core` so `docker exec` / compose
# exec stay non-root. Prep escalates only through the setuid wrapper
# `/usr/local/libexec/core-fs-prep-wrap` (or runs inline when already root,
# e.g. `docker run -u 0` in smoke). Then setpriv drops every capability and
# sets no-new-privs before exec'ing CMD. tini remains PID 1.
set -eu

CORE_USER=core
PREP_SCRIPT=/usr/local/libexec/core-fs-prep.sh
PREP_WRAP=/usr/local/libexec/core-fs-prep-wrap

run_prep() {
  if [ "$(id -u)" -eq 0 ]; then
    "$PREP_SCRIPT"
  else
    "$PREP_WRAP"
  fi
}

run_prep

# Complete drop: real+effective uid/gid, supplementary groups, no inherited
# or bounding capabilities, and no-new-privs so setuid binaries stay inert.
if [ "$(id -u)" -eq 0 ]; then
  exec setpriv \
    --reuid="${CORE_USER}" \
    --regid="${CORE_USER}" \
    --init-groups \
    --inh-caps=-all \
    --bounding-set=-all \
    --no-new-privs \
    -- "$@"
fi

exec setpriv \
  --inh-caps=-all \
  --bounding-set=-all \
  --no-new-privs \
  -- "$@"
