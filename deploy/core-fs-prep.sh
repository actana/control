#!/bin/sh
# Filesystem prep for the Core image home volume (#558 / #551).
#
# Runs as root (either because the entrypoint started as root, or via the
# setuid wrapper). Never follows a symlink out of CORE_HOME: a `core` process
# that planted `ln -s /usr ~/.local` must not turn the next boot into
# `chown core /usr/bin`. Directory only — never `chown -R`, and the workspace
# bind mount is repaired at the mount point only (contents stay as the host
# left them).
#
# CORE_HOME may be overridden in tests; production leaves it at /home/core.
set -eu

CORE_USER="${CORE_USER:-core}"
CORE_HOME="${CORE_HOME:-/home/core}"
CORE_UID="${CORE_UID:-1000}"
CORE_GID="${CORE_GID:-1000}"

SHARED_DIR="${CORE_HOME}/shared"
STATE_DIR="${CORE_HOME}/.local/share/actana/data"
CONFIG_DIR="${CORE_HOME}/.config/actana"
WORKSPACE_DIR="${CORE_HOME}/repos"

# True when every existing component of $1 under CORE_HOME is a real directory
# (not a symlink), and $1 is CORE_HOME or a path beneath it.
path_safe_under_home() {
  target=$1
  case "$target" in
    "$CORE_HOME" | "$CORE_HOME"/*) ;;
    *) return 1 ;;
  esac

  if [ -L "$CORE_HOME" ]; then
    return 1
  fi
  if [ -e "$CORE_HOME" ] && [ ! -d "$CORE_HOME" ]; then
    return 1
  fi

  rel=${target#"$CORE_HOME"}
  rel=${rel#/}
  [ -z "$rel" ] && return 0

  cur=$CORE_HOME
  oldifs=$IFS
  IFS=/
  # shellcheck disable=SC2086
  set -- $rel
  IFS=$oldifs
  for comp; do
    [ -n "$comp" ] || continue
    next="$cur/$comp"
    if [ -L "$next" ]; then
      return 1
    fi
    if [ -e "$next" ] && [ ! -d "$next" ]; then
      return 1
    fi
    cur=$next
  done
  return 0
}

# Create $1 one component at a time, refusing if any component is a symlink.
mkdir_safe_under_home() {
  target=$1
  case "$target" in
    "$CORE_HOME" | "$CORE_HOME"/*) ;;
    *) return 1 ;;
  esac

  if [ ! -e "$CORE_HOME" ]; then
    mkdir -m 0755 "$CORE_HOME"
  fi
  if [ -L "$CORE_HOME" ] || [ ! -d "$CORE_HOME" ]; then
    return 1
  fi

  rel=${target#"$CORE_HOME"}
  rel=${rel#/}
  [ -z "$rel" ] && return 0

  cur=$CORE_HOME
  oldifs=$IFS
  IFS=/
  # shellcheck disable=SC2086
  set -- $rel
  IFS=$oldifs
  for comp; do
    [ -n "$comp" ] || continue
    next="$cur/$comp"
    if [ -L "$next" ]; then
      return 1
    fi
    if [ ! -e "$next" ]; then
      mkdir -m 0755 "$next"
    elif [ ! -d "$next" ]; then
      return 1
    fi
    cur=$next
  done
  return 0
}

# policy=hard → non-zero on refusal or chown failure (home / state).
# policy=warn → message on stderr, zero exit (workspace bind mount).
ensure_core_owned() {
  path=$1
  policy=$2

  if ! path_safe_under_home "$path"; then
    msg="refusing to repair ${path}: leaves ${CORE_HOME} or passes through a symlink"
    if [ "$policy" = warn ]; then
      echo "core-fs-prep: warning: $msg" >&2
      return 0
    fi
    echo "core-fs-prep: error: $msg" >&2
    return 1
  fi

  if ! mkdir_safe_under_home "$path"; then
    msg="cannot create ${path} without following a symlink or leaving ${CORE_HOME}"
    if [ "$policy" = warn ]; then
      echo "core-fs-prep: warning: $msg" >&2
      return 0
    fi
    echo "core-fs-prep: error: $msg" >&2
    return 1
  fi

  # Re-check after mkdir: a race could have swapped in a symlink.
  if [ -L "$path" ] || ! path_safe_under_home "$path"; then
    msg="refusing to chown ${path}: path is a symlink or left ${CORE_HOME}"
    if [ "$policy" = warn ]; then
      echo "core-fs-prep: warning: $msg" >&2
      return 0
    fi
    echo "core-fs-prep: error: $msg" >&2
    return 1
  fi

  owner=$(stat -c '%u:%g' "$path")
  if [ "$owner" = "${CORE_UID}:${CORE_GID}" ]; then
    return 0
  fi

  # -h: never dereference. Mount-point only for the workspace — no -R.
  if ! chown -h "${CORE_USER}:${CORE_USER}" "$path"; then
    msg="chown ${path} failed"
    if [ "$policy" = warn ]; then
      echo "core-fs-prep: warning: $msg" >&2
      return 0
    fi
    echo "core-fs-prep: error: $msg" >&2
    return 1
  fi
  return 0
}

ensure_core_owned "${CORE_HOME}" hard
ensure_core_owned "${CORE_HOME}/.local" hard
ensure_core_owned "${CORE_HOME}/.local/bin" hard
ensure_core_owned "${CORE_HOME}/.local/share" hard
ensure_core_owned "${CORE_HOME}/.local/share/actana" hard
ensure_core_owned "${STATE_DIR}" hard
ensure_core_owned "${CORE_HOME}/.config" hard
ensure_core_owned "${CONFIG_DIR}" hard
ensure_core_owned "${SHARED_DIR}" hard
# Workspace bind mount (#551): host dir Docker created as root. Warn and
# continue — a root-squashed NFS mount must not crash-loop the Core. Only the
# mount point is owned; contents are not walked.
ensure_core_owned "${WORKSPACE_DIR}" warn
