#!/bin/sh
# Bind-mount ownership prep for the Core image (#558 / #551).
#
# Run as root from a one-shot init (compose `core-init`, or
# `docker run -u 0 --entrypoint /usr/local/libexec/core-fs-prep.sh …`), then
# exit. The main Core never runs this and never holds root.
#
# Named volumes are already seeded core:core by the image, so this is only
# needed when a host bind mount is root-owned (Docker creates a missing host
# dir as root). Repair is mount-point only: never `chown -R`, never walk into
# `~/.local` / `~/.config` (those are check-then-use races under a writable
# home). Refuse any path that is a symlink.
#
# Environment is ignored: PATH is pinned, and every path is hard-coded. A
# hostile CORE_HOME / fake `stat` on the caller's PATH cannot redirect this.
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

CORE_HOME=/home/core
SHARED=/home/core/shared
WORKSPACE=/home/core/repos
CORE_UID=1000
CORE_GID=1000
# The daemon's state volume (#559). Owned by the user the daemon runs as, which
# is still core, so the same numbers; they are separate variables so that the
# change to a daemon user of its own touches this pair and not the home above.
STATE=/var/lib/actana
STATE_UID=1000
STATE_GID=1000

fail() {
  echo "core-fs-prep: error: $*" >&2
  exit 1
}

warn() {
  echo "core-fs-prep: warning: $*" >&2
}

# Fix one mount point. No intermediate walk: the path is a single known leaf
# under /home/core (or /home/core itself). Symlinks are refused. Skip chown
# when ownership already matches (root-squashed NFS / rootless).
#
# policy=hard → exit 1 on refusal or chown failure
# policy=warn → message and continue (workspace bind mount)
fix_mount_point() {
  path=$1
  policy=$2
  # The state directory is not the home: its own owner, and mode 0700 when it
  # has to be created. Defaults are the home's.
  want_uid=${3:-$CORE_UID}
  want_gid=${4:-$CORE_GID}
  want_mode=${5:-0755}

  if [ -L "$path" ]; then
    msg="${path} is a symlink; refusing to repair"
    if [ "$policy" = warn ]; then
      warn "$msg"
      return 0
    fi
    fail "$msg"
  fi

  if [ ! -e "$path" ]; then
    # Parent must be a real directory (not a symlink) before we create a leaf.
    parent=$(dirname "$path")
    if [ -L "$parent" ] || [ ! -d "$parent" ]; then
      msg="cannot create ${path}: parent is missing or a symlink"
      if [ "$policy" = warn ]; then
        warn "$msg"
        return 0
      fi
      fail "$msg"
    fi
    if ! mkdir -m "$want_mode" "$path"; then
      msg="mkdir ${path} failed"
      if [ "$policy" = warn ]; then
        warn "$msg"
        return 0
      fi
      fail "$msg"
    fi
  fi

  if [ -L "$path" ]; then
    msg="${path} became a symlink; refusing to chown"
    if [ "$policy" = warn ]; then
      warn "$msg"
      return 0
    fi
    fail "$msg"
  fi

  if [ ! -d "$path" ]; then
    msg="${path} is not a directory"
    if [ "$policy" = warn ]; then
      warn "$msg"
      return 0
    fi
    fail "$msg"
  fi

  owner=$(stat -c '%u:%g' "$path")
  if [ "$owner" = "${want_uid}:${want_gid}" ]; then
    return 0
  fi

  # -h: if a symlink raced in, only the link inode would change — never the
  # target. We already refused -L above; this is defence in depth.
  if ! chown -h "${want_uid}:${want_gid}" "$path"; then
    msg="chown ${path} failed (root-squashed NFS / rootless?)"
    if [ "$policy" = warn ]; then
      warn "$msg"
      return 0
    fi
    fail "$msg"
  fi
}

if [ -L "$CORE_HOME" ]; then
  fail "${CORE_HOME} is a symlink"
fi

# Home itself when bind-mounted root-owned. Named volumes are image-seeded.
fix_mount_point "$CORE_HOME" hard
fix_mount_point "$SHARED" hard
# Workspace bind mount (#551): mount point only; contents are not walked.
fix_mount_point "$WORKSPACE" warn
# State mount point (#559): a named volume is seeded from the image, so this is
# only for a volume that arrived root-owned. Mount point only; a missing one is
# created 0700 and an existing one keeps its mode.
fix_mount_point "$STATE" hard "$STATE_UID" "$STATE_GID" 0700
