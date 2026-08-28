#!/usr/bin/env bash
# The regression guard for #346 — no expansion in `install.sh` may be followed
# immediately by a non-ASCII byte.
#
# What it is guarding against, in one paragraph. macOS ships bash 3.2.57, and
# its default `LC_CTYPE` is a UTF-8 locale. Under that pair, bash's identifier
# scan reads past the end of a variable name into the bytes of a following
# multi-byte character, so `"Downloading $asset…"` is expanded as a variable
# named `asset?` — and `install.sh` opens with `set -eu`, so an unbound name is
# not a typo in a message, it is the installer aborting on the first machine
# the product is ever run on:
#
#     bash: line 537: asset?: unbound variable
#
# The fix for that line is three ASCII bytes and takes ten seconds; this file
# is the deliverable. The hazard is invisible on the screen of the person
# introducing it — a nice-looking `…`, `—` or `→` typed after a variable is
# indistinguishable from a correct one until it runs on a Mac, and CI runs on
# Linux under a bash 5 that handles it. So the rule is mechanical and it lives
# here rather than in a review checklist.
#
# **This script only reads.** It never rewrites `install.sh`. That matters for
# one line in particular: `LINE="x.y.z"` is the release-train stamp that
# decides which line a fetched copy of the installer installs (ADR 0036 D1, D2)
# and that `Train rules` asserts against the train's version. It carries no
# non-ASCII byte, so it passes here like every other ordinary line — but a
# guard that "fixed" what it found would be a second thing editing that stamp,
# and there must be exactly one (the cut's `sed`).
#
# ── Portability ─────────────────────────────────────────────────────────────
#
# bash 3.2 is the target, because the bug being guarded is a bash 3.2 bug and
# an operator reproducing it on their Mac must be able to run this. Nothing
# below is newer than 3.2: no `mapfile`, no associative arrays, no `${x^^}`.
# The scan runs under `LC_ALL=C` so that "non-ASCII" means the bytes 0x80-0xFF
# and not whatever the caller's locale would fold them into.
#
# Usage: scripts/install-sh-ascii-guard.sh [path-to-install.sh]
set -euo pipefail

TARGET="${1:-install.sh}"

if [ ! -f "$TARGET" ]; then
  echo "::error title=The installer is missing::$TARGET is not a file, so the expansion guard for #346 has nothing to scan. A guard that reports green over a file it never read is worse than no guard at all."
  echo "install-sh-ascii-guard: $TARGET does not exist." >&2
  exit 1
fi

export LC_ALL=C

# The bytes that are not ASCII, as a literal range for a bracket expression.
# Built with `printf` rather than written into the pattern, so that this file
# stays pure ASCII itself — a guard against non-ASCII bytes that carries a pile
# of them is a guard nobody can grep for.
NON_ASCII="$(printf '\200-\377')"

# A `$` that opens an expansion, immediately followed by one of those bytes:
#
#   $name…      a plain name          — the shape #346 was reported as
#   ${name}…    a braced name         — safe under the bug as reported, and
#                                       still refused: the rule people can hold
#                                       in their head is "put an ASCII byte
#                                       between an expansion and a `…`", not
#                                       "…unless you brace it", and the braces
#                                       are one edit away from being removed
#   $1…  $@…  $?…                     — positional and special parameters
#   $…                                 — a bare `$` against a multi-byte byte
#
# `$(cmd)…` and `$((x))…` are deliberately not matched: they close on an ASCII
# `)`, which is itself the separator this rule is asking for.
EXPANSION='\$([A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|[0-9*@#?$!-])?'
PATTERN="$EXPANSION[$NON_ASCII]"

# The detector, tested against a known-bad and a known-good line before it is
# trusted with the real file. `grep` byte ranges under `LC_ALL=C` are the one
# assumption this script makes about its environment, and the failure mode of
# that assumption breaking is a scan that matches nothing and reports green —
# exactly the silent pass this guard exists to prevent. Two seconds of
# self-test turns that into a red check with a reason on it.
BAD_SAMPLE="$(printf 'say "Downloading $asset\342\200\246"')"
GOOD_SAMPLE='say "Downloading $asset..."'

if ! printf '%s\n' "$BAD_SAMPLE" | grep -qE "$PATTERN"; then
  echo "::error title=The install.sh expansion guard is broken::Its own known-bad sample did not match, so this scan cannot be trusted and is reporting failure rather than green. \`grep -E\` here does not support the 0x80-0xFF byte range under LC_ALL=C that the check is built on."
  echo "install-sh-ascii-guard: self-test failed — the known-bad sample did not match." >&2
  exit 1
fi

if printf '%s\n' "$GOOD_SAMPLE" | grep -qE "$PATTERN"; then
  echo "::error title=The install.sh expansion guard is broken::Its own known-good sample matched, so the check would refuse correct files. This is a bug in scripts/install-sh-ascii-guard.sh, not in $TARGET."
  echo "install-sh-ascii-guard: self-test failed — the known-good sample matched." >&2
  exit 1
fi

# `|| true`, because no match is this script's success case and `set -e` would
# otherwise abort on it.
HITS="$(grep -nE "$PATTERN" "$TARGET" || true)"

if [ -z "$HITS" ]; then
  echo "  OK  $TARGET: no expansion is followed immediately by a non-ASCII byte (#346)."
  exit 0
fi

echo "$TARGET has an expansion followed immediately by a non-ASCII byte." >&2
echo "Under bash 3.2 with LC_CTYPE=UTF-8 — the pair every macOS ships — the" >&2
echo "identifier scan reads past the variable name into the multi-byte" >&2
echo "character, and 'set -eu' aborts the installer on an unbound variable." >&2
echo >&2

while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  line_no="${hit%%:*}"
  text="${hit#*:}"
  echo "  $TARGET:$line_no: $text" >&2
  echo "::error file=$TARGET,line=$line_no,title=Expansion followed by a non-ASCII byte (#346)::$TARGET line $line_no expands a variable immediately before a non-ASCII character. On macOS bash 3.2 under a UTF-8 locale this reads as a different, unbound variable name and 'set -eu' aborts the install. Put an ASCII byte between them - '...' instead of the ellipsis, or a space before it."
done <<EOF
$HITS
EOF

echo >&2
echo "Fix: replace the multi-byte character with ASCII ('...'), or put a space" >&2
echo "between the expansion and it. Then re-run: $0 $TARGET" >&2
exit 1
