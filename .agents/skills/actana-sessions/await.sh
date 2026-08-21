#!/usr/bin/env bash
# x-actana-managed: true
#
# Wait for several Sessions' report files at once, save each one locally, and
# say per Session what happened.
#
# The marker on line 2 is the same marker `SKILL.md` carries in its frontmatter,
# and it means the same thing: this file was written by `actana` and `actana`
# will replace it, edits and all. Delete that line and this copy becomes yours —
# the installer reads the marker as a substring of a file's first bytes rather
# than through a YAML parser, so the escape hatch works here exactly as it works
# on the markdown.
#
# Run it with `bash await.sh` — it is installed without an executable bit, on
# purpose. The installer's whole safety argument is that it is a filesystem
# write and nothing else, and a write that also flips a permission bit is a
# larger act for no gain.
#
#   bash await.sh --out ./reports 7f3a=api:reports/a.md 9c1b=api:reports/b.md
#
# ── Why this is a file and not four paragraphs of advice ──────────────────────
#
# Four things go wrong when this loop is re-derived inline, and each of them has
# gone wrong. They are the reason the script ships:
#
#  1. **The LAST line is the proof; a grep is not.** `ACT-REPORT-END` occurring
#     anywhere in a report — quoted, in an example, inside a diff — settles a
#     Session that has not finished. This reads the tail of the file and
#     compares its last non-blank line to the sentinel. Nothing else counts.
#  2. **Save locally before deleting anything.** The report is copied down and
#     confirmed on this disk before the Session is killed. Delete-then-save is
#     the screen-era failure wearing a new mechanism.
#  3. **Every Session waits in ONE loop.** A per-Session wait serialises the
#     round: a slow lane blocks fast ones that finished minutes ago, and a
#     six-lane round then runs at the speed of its worst lane *summed* rather
#     than its worst lane alone. One loop polls every unfinished lane per tick.
#  4. **A dropped link is "not yet", never failure.** `actana core exec` exits
#     125 when the link to the Core went away mid-command: the command kept
#     running over there and this side has no result. A watcher that read 125 as
#     "the report is not there" would abandon a lane that is perfectly fine.
#
# ── What it needs ────────────────────────────────────────────────────────────
#
# `actana` on PATH and a Core selected (or `--core <name>`). `node` too, only to
# read one field out of `actana project ls --json` — it ships with the CLI, so
# this adds no dependency the CLI has not already made.

set -uo pipefail

SENTINEL="ACT-REPORT-END"
OUT_DIR="."
TIMEOUT=1800
INTERVAL=15
KILL_AFTER=0
CORE_ARGS=()

usage() {
  cat <<'USAGE'
bash await.sh [options] <lane>...

  lane            <session-id>=<project>:<report-path>
                  the report path is the Project's, exactly as `project cp`
                  takes it — `7f3a=api:reports/impl-304-r1.md`

  --out <dir>     where saved reports land. Default: .
  --timeout <s>   give up on the round after this long. Default: 1800
  --interval <s>  seconds between polls. Default: 15
  --sentinel <s>  the last line that means "finished". Default: ACT-REPORT-END
  --kill          kill each Session once its report is safely on this disk
  --core <name>   which Core, passed through to every `actana` call
  -h, --help      this

Exits 0 when every lane's report was saved, 1 when any lane was not.
USAGE
}

LANE_SESSION=()
LANE_PROJECT=()
LANE_REMOTE=()
LANE_LOCAL=()
LANE_STATE=()
LANE_NOTE=()

# A value-taking flag with nothing after it is an error, and has to be said out
# loud. `shift 2` with one argument left shifts nothing and returns non-zero;
# nothing reads that status, so the same branch matched forever and the script
# hung with no output — a symptom indistinguishable from waiting on a Session
# that is still working. The caller here is a model composing a command line,
# and a silent hang is the worst thing it can be handed.
need_value() {
  # $1 is the flag; $2 is how many arguments are still unparsed, this one
  # included. Counting is the check: `${2:-}` would turn a missing operand into
  # an empty string, which is what hid this in the first place.
  [ "$2" -ge 2 ] && return 0
  echo "await.sh: $1 needs a value" >&2
  usage >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) need_value "$1" "$#"; OUT_DIR="$2"; shift 2 ;;
    --timeout) need_value "$1" "$#"; TIMEOUT="$2"; shift 2 ;;
    --interval) need_value "$1" "$#"; INTERVAL="$2"; shift 2 ;;
    --sentinel) need_value "$1" "$#"; SENTINEL="$2"; shift 2 ;;
    --core) need_value "$1" "$#"; CORE_ARGS=(--core "$2"); shift 2 ;;
    --kill) KILL_AFTER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "await.sh: unknown option \"$1\"" >&2; usage >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "await.sh: name at least one lane — <session-id>=<project>:<report-path>" >&2
  usage >&2
  exit 2
fi

for lane in "$@"; do
  session="${lane%%=*}"
  ref="${lane#*=}"
  if [ "$session" = "$lane" ] || [ -z "$session" ] || [ -z "$ref" ]; then
    echo "await.sh: \"$lane\" is not <session-id>=<project>:<report-path>" >&2
    exit 2
  fi
  project="${ref%%:*}"
  remote="${ref#*:}"
  if [ "$project" = "$ref" ] || [ -z "$project" ] || [ -z "$remote" ]; then
    echo "await.sh: \"$ref\" is not <project>:<report-path>" >&2
    exit 2
  fi
  # The destination carries the Session id, because the basename alone does not
  # identify a lane. "Three Sessions, each on a different thing" naturally gives
  # every sub-agent the same report filename inside its own Project, and two
  # lanes writing `report.md` into one directory would overwrite each other,
  # report `saved` twice naming the same file, and under --kill destroy both
  # Sessions — so the second lane's bytes were saved and the first lane's were
  # lost anyway. That is the failure "save before deleting" exists to prevent,
  # arriving by a different route.
  safe_session="$(printf '%s' "$session" | tr -c 'A-Za-z0-9._-' '_')"
  LANE_SESSION+=("$session")
  LANE_PROJECT+=("$project")
  LANE_REMOTE+=("$remote")
  LANE_LOCAL+=("$OUT_DIR/${safe_session}-$(basename "$remote")")
  LANE_STATE+=("waiting")
  LANE_NOTE+=("no report yet")
done

# Prefixing makes a collision unlikely, not impossible: one Session writing two
# reports from different folders still lands on one name. So the remaining case
# is refused here, before a single Session is touched — a usage error costs a
# retype, and a silently discarded report costs the work that produced it.
for i in "${!LANE_LOCAL[@]}"; do
  for j in "${!LANE_LOCAL[@]}"; do
    [ "$i" -lt "$j" ] || continue
    [ "${LANE_LOCAL[$i]}" = "${LANE_LOCAL[$j]}" ] || continue
    echo "await.sh: ${LANE_SESSION[$i]} and ${LANE_SESSION[$j]} would both be saved as" >&2
    echo "  ${LANE_LOCAL[$i]}" >&2
    echo "Give them different report filenames, or a --out directory each." >&2
    exit 2
  done
done

mkdir -p "$OUT_DIR" || exit 1

# The Project's path on the Core, so the tail below can name an absolute file.
# Read once per Project rather than per tick: a Project's path is fixed for the
# life of the Project — no verb edits one — so re-reading it every 15 seconds
# would be asking a settled question over and over.
project_root() {
  actana project ls --json "${CORE_ARGS[@]+"${CORE_ARGS[@]}"}" 2>/dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        let rows = [];
        try { rows = JSON.parse(raw); } catch { process.exit(1); }
        const want = process.argv[1];
        const hit = rows.find((row) => row.name === want || row.projectId === want);
        if (!hit || !hit.path) process.exit(1);
        process.stdout.write(hit.path);
      });
    ' "$1"
}

ROOTS=()
for index in "${!LANE_PROJECT[@]}"; do
  root="$(project_root "${LANE_PROJECT[$index]}")"
  if [ -z "$root" ]; then
    echo "await.sh: no Project named \"${LANE_PROJECT[$index]}\" on this Core" >&2
    exit 1
  fi
  ROOTS+=("$root")
done

# Lesson 1. The sentinel has to be the file's LAST line, so this reads the tail
# and nothing else. A few lines rather than exactly one, because a trailing
# blank line an editor left behind is not a Session that failed to finish — and
# a sentinel quoted in the body of the report is still nowhere near the tail.
last_line_is_sentinel() {
  local tail_text="$1" line last=""
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] && last="$line"
  done <<EOF
$tail_text
EOF
  [ "$last" = "$SENTINEL" ]
}

started="$(date +%s)"
pending="${#LANE_SESSION[@]}"

echo "await.sh: watching $pending lane(s) for a last line of \"$SENTINEL\"" >&2

# Lesson 3. ONE loop, every unfinished lane per tick. Nothing here blocks on a
# single Session, which is what keeps a six-lane round running at the speed of
# its slowest lane rather than the sum of all six.
while [ "$pending" -gt 0 ]; do
  now="$(date +%s)"
  if [ $((now - started)) -ge "$TIMEOUT" ]; then
    for index in "${!LANE_SESSION[@]}"; do
      [ "${LANE_STATE[$index]}" = "waiting" ] || continue
      LANE_STATE[$index]="timeout"
      # Carry the last thing this lane saw into the timeout line. "The budget
      # ran out" and "the budget ran out while the link kept dropping" are
      # different reports, and the second one is about the network.
      LANE_NOTE[$index]="the round's ${TIMEOUT}s budget ran out — the Session is still running; last: ${LANE_NOTE[$index]}"
    done
    break
  fi

  for index in "${!LANE_SESSION[@]}"; do
    [ "${LANE_STATE[$index]}" = "waiting" ] || continue

    remote_path="${ROOTS[$index]}/${LANE_REMOTE[$index]}"
    tail_text="$(actana core exec "${CORE_ARGS[@]+"${CORE_ARGS[@]}"}" -- tail -n 3 -- "$remote_path" 2>/dev/null)"
    status=$?

    # Lesson 4. 125 is EXIT_LINK_LOST: the tail kept running on the Core and
    # this side has no answer. That is "ask again next tick", never "no report".
    if [ "$status" -eq 125 ]; then
      LANE_NOTE[$index]="the link to the Core dropped mid-poll — retrying, not giving up"
      continue
    fi
    # Any other non-zero is almost always "the file is not there yet", which is
    # the ordinary state of a Session that is still working.
    [ "$status" -eq 0 ] || continue
    LANE_NOTE[$index]="a report file is there, but its last line is not the sentinel yet"
    last_line_is_sentinel "$tail_text" || continue

    # Lesson 2. Save first. The Session is not touched until the bytes are on
    # this disk and the file we wrote is non-empty.
    local_path="${LANE_LOCAL[$index]}"
    if ! actana project cp "${CORE_ARGS[@]+"${CORE_ARGS[@]}"}" \
      "${LANE_PROJECT[$index]}:${LANE_REMOTE[$index]}" "$local_path" >/dev/null 2>&1; then
      LANE_STATE[$index]="failed"
      LANE_NOTE[$index]="the report finished but could not be copied down — it is still on the Core"
      pending=$((pending - 1))
      continue
    fi
    if [ ! -s "$local_path" ]; then
      LANE_STATE[$index]="failed"
      LANE_NOTE[$index]="the copy landed empty — the report is still on the Core, nothing was killed"
      pending=$((pending - 1))
      continue
    fi

    LANE_STATE[$index]="saved"
    LANE_NOTE[$index]="$local_path"
    pending=$((pending - 1))

    if [ "$KILL_AFTER" -eq 1 ]; then
      if actana session kill "${CORE_ARGS[@]+"${CORE_ARGS[@]}"}" "${LANE_SESSION[$index]}" >/dev/null 2>&1; then
        LANE_NOTE[$index]="$local_path (Session killed)"
      else
        LANE_NOTE[$index]="$local_path (saved; the Session would not stop — kill it by hand)"
      fi
    fi
  done

  [ "$pending" -gt 0 ] && sleep "$INTERVAL"
done

failures=0
for index in "${!LANE_SESSION[@]}"; do
  printf '%s\t%s\t%s\n' "${LANE_SESSION[$index]}" "${LANE_STATE[$index]}" "${LANE_NOTE[$index]}"
  [ "${LANE_STATE[$index]}" = "saved" ] || failures=$((failures + 1))
done

# A lane that produced nothing is a fact to report, not a gap to fill in.
exit $([ "$failures" -eq 0 ] && echo 0 || echo 1)
