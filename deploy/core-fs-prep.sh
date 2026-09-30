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
    if ! mkdir -m 0755 "$path"; then
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
  if [ "$owner" = "${CORE_UID}:${CORE_GID}" ]; then
    return 0
  fi

  # -h: if a symlink raced in, only the link inode would change — never the
  # target. We already refused -L above; this is defence in depth.
  if ! chown -h "${CORE_UID}:${CORE_GID}" "$path"; then
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
