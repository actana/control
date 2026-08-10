#!/usr/bin/env bash
#
# Pre-flight for the payloads in this directory. It reads; it never writes.
#
# `main.json` and `tag-release-cut.json` are applied as full-body PUTs, so the
# body sent *is* the ruleset afterwards. An `actor_id` that is not the App's
# does not fail at the API — it replaces the live bypass actor list with a
# wrong one and returns 200. A config apply that reports success while deleting
# the identity `promote.yml` depends on is the failure this guards.
#
# So, before any write: the App id the payloads will carry is the App id
# actually installed on the repository, and no bypass actor that is live today
# would be dropped by the PUT. A mismatch is named and refused, not warned
# about.
#
#   export APP_ID=…                       # the value of the APP_ID secret (§2)
#   docs/rulesets/preflight-app-id.sh     # all payloads here
#   docs/rulesets/preflight-app-id.sh docs/rulesets/main.json   # or named ones
#
# Exit 0 means the `apply` helper in ../REPO_SETUP.md §3 is safe to run. Any
# other exit means apply nothing — not this payload and not the ones after it.
#
# Nothing runs this automatically. It is a human step, run from an admin clone
# before the first `apply`, and every API call it makes is a GET.

set -euo pipefail

REPO="${REPO:-actana/control}"
OWNER="${REPO%%/*}"

die() {
  printf '\n❌ %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '   %s\n' "$line" >&2; done
  printf '\n   Applying nothing. Fix the above and re-run.\n' >&2
  exit 1
}

ok()   { printf '  ✅ %s\n' "$1"; }
note() { printf '  ℹ️  %s\n' "$1"; }

command -v gh >/dev/null 2>&1 || die "\`gh\` is not on PATH." \
  "This check needs the GitHub CLI, authenticated as the admin who will apply."
command -v jq >/dev/null 2>&1 || die "\`jq\` is not on PATH." \
  "§3's apply helper needs it too — the substitution is a jq expression."

# 1. APP_ID is set, and is a plausible App id.

[ -n "${APP_ID:-}" ] || die "APP_ID is not set." \
  "Export the value of the APP_ID secret before running this:" \
  "  export APP_ID=…" \
  "§2 has where to read it and what to do when it is missing."

case "$APP_ID" in
  '' | *[!0-9]*)
    die "APP_ID is not a number: '$APP_ID'." \
      "The payloads want the App's numeric id, not its slug, name or client id."
    ;;
esac

[ "$APP_ID" -ne 0 ] || die "APP_ID is 0." \
  "Zero is the placeholder the payloads ship with — the tripwire, not a value." \
  "Read the real id from the APP_ID secret (§2)."

# 2. That id is an App installed on the repository's owner.
#
#    A user token cannot read /repos/{repo}/installation — that endpoint wants
#    the App's own JWT — so the question is asked of the org. Failing to ask it
#    is a refusal, not a pass: an unreadable answer is the case this exists for.

installs="$(gh api "orgs/$OWNER/installations" \
  --jq '.installations[] | [.app_id, .app_slug, .repository_selection] | @tsv' 2>&1)" || die \
  "Could not list the App installations on $OWNER." \
  "$installs" \
  "" \
  "This needs the admin:org scope, which the admin doing the cutover has:" \
  "  gh auth refresh -h github.com -s admin:org" \
  "Do not skip this and apply anyway — it is the assertion, not a formality."

[ -n "$installs" ] || die "No GitHub App is installed on $OWNER." \
  "The payloads name one as their only bypass actor, so there is nothing for" \
  "APP_ID=$APP_ID to be. Install the App first (§2, step 1 of the cutover)."

installed_line="$(printf '%s\n' "$installs" | awk -F'\t' \
  '{ printf "  %s  %s  (%s repositories)\n", $1, $2, $3 }')"

match="$(printf '%s\n' "$installs" | awk -F'\t' -v id="$APP_ID" '$1 == id')"
[ -n "$match" ] || die "APP_ID=$APP_ID names no App installed on $OWNER." \
  "Applying the payloads with it would put an id with no App behind it into" \
  "every bypass actor list — and main.json is a full-body PUT, so it would" \
  "replace the live one rather than sit beside it." \
  "" \
  "Installed on $OWNER:" \
  "$installed_line" \
  "Either APP_ID is stale or the App was reinstalled and has a new id (§2)."

slug="$(printf '%s\n' "$match" | cut -f2)"
selection="$(printf '%s\n' "$match" | cut -f3)"
ok "APP_ID=$APP_ID is '$slug', installed on $OWNER."

if [ "$selection" != "all" ]; then
  note "That installation covers selected repositories, not all of them, and a"
  note "user token cannot list which. Confirm $REPO is among them on the"
  note "installation's settings page before applying."
fi

# 3. Every Integration actor in every payload is either the placeholder or that
#    same id. A payload naming some third App is the mismatch this refuses on.

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -gt 0 ]; then payloads=("$@"); else payloads=("$here"/*.json); fi

# The two payloads §3 applies as PUTs, and the live rulesets they overwrite.
live_ruleset_for() {
  case "$1" in
    main.json)            echo 20390421 ;;
    tag-release-cut.json) echo 20390424 ;;
    tag-immutable.json)   echo 20390423 ;;
    *)                    echo ""       ;;
  esac
}

for payload in "${payloads[@]}"; do
  name="$(basename -- "$payload")"
  [ -f "$payload" ] || die "No such payload: $payload"
  jq -e . "$payload" >/dev/null 2>&1 || die "$name is not valid JSON."

  checked=0
  while IFS= read -r actor_id; do
    [ -n "$actor_id" ] || continue
    checked=1
    if [ "$actor_id" = "0" ]; then
      ok "$name: placeholder actor_id 0 — §3's jq substitutes APP_ID into it."
    elif [ "$actor_id" = "$APP_ID" ]; then
      ok "$name: names App $actor_id, which is APP_ID."
    else
      die "$name names App $actor_id, but APP_ID is $APP_ID." \
        "One of the two is wrong, and applying resolves it the destructive way:" \
        "the payload is sent whole, so whichever id is in the file becomes the" \
        "ruleset's entire bypass actor list." \
        "" \
        "Either substitute $APP_ID into $name, or restore the 0 placeholder and" \
        "let the apply helper substitute it."
    fi
  done <<<"$(jq -r '[.bypass_actors[]? | select(.actor_type == "Integration") | .actor_id] | .[]' "$payload")"

  # 4. A PUT is a replacement. Anything live that the payload does not carry is
  #    deleted by applying it — silently, with a 200.

  ruleset_id="$(live_ruleset_for "$name")"
  if [ -z "$ruleset_id" ]; then
    # Said out loud, because a payload that quietly checks nothing and a
    # payload whose bypass actor someone deleted look identical in silence.
    [ "$checked" -eq 1 ] || note "$name: no App bypass actor, and applied as a POST — nothing to assert."
    continue
  fi

  live_json="$(gh api "repos/$REPO/rulesets/$ruleset_id" 2>&1)" || die \
    "Could not read live ruleset $ruleset_id ($name's target)." \
    "$live_json" \
    "Without it there is no way to know what the PUT would replace."

  # A 200 is not an answer. An empty body, a whitespace-only body, a redacted
  # `"bypass_actors": null` and a response with the key absent all reduce to an
  # empty actor list below, and an empty list is indistinguishable from "this
  # ruleset has no bypass actors" — which is the one thing that must not be
  # assumed here. GitHub redacts bypass_actors to null for a token that can
  # read the ruleset but is not an admin, so this is the likely case, not the
  # exotic one. Same rule as the installations call above: an answer that
  # cannot be read is a refusal, not a pass.
  printf '%s' "$live_json" |
    jq -e 'type == "object" and has("bypass_actors") and (.bypass_actors | type == "array")' \
    >/dev/null 2>&1 || die \
    "Live ruleset $ruleset_id ($name's target) read back without a usable bypass_actors list." \
    "The request succeeded, so this is not a network failure: either the response" \
    "was empty or unparseable, or the token can read the ruleset but not its" \
    "bypass actors — GitHub redacts them to null for non-admins." \
    "An answer that cannot be read is not an answer of 'no bypass actors'." \
    "" \
    "Re-run as an admin of $REPO:" \
    "  gh auth refresh -h github.com -s admin:org" \
    "and confirm the read returns a bypass_actors array before applying anything."

  live_actors="$(printf '%s' "$live_json" |
    jq -r '[.bypass_actors[]? | "\(.actor_type):\(.actor_id):\(.bypass_mode)"] | sort | .[]')"

  payload_actors="$(jq -r --argjson app "$APP_ID" \
    '[.bypass_actors[]? | "\(.actor_type):\(if .actor_id == 0 then $app else .actor_id end):\(.bypass_mode)"] | sort | .[]' \
    "$payload")"

  # `comm` wants both sides sorted the same way; jq's sort is byte order, so
  # pin the locale rather than trust the shell's.
  dropped="$(LC_ALL=C comm -23 \
    <(printf '%s\n' "$live_actors" | LC_ALL=C sort -u) \
    <(printf '%s\n' "$payload_actors" | LC_ALL=C sort -u) | sed '/^$/d')"
  if [ -n "$dropped" ]; then
    die "Applying $name over live ruleset $ruleset_id would delete a bypass actor." \
      "A full-body PUT replaces bypass_actors wholesale, and these are live" \
      "today but absent from the payload:" \
      "$(printf '%s\n' "$dropped" | sed 's/^/  /')" \
      "" \
      "Add them to $name if they should survive, or delete them deliberately" \
      "in the admin console first — not as a side effect of a config apply."
  fi
  ok "$name: PUT over $ruleset_id drops no live bypass actor."
done

printf '\n✅ Pre-flight passed. §3'"'"'s apply helper is safe to run with APP_ID=%s.\n' "$APP_ID"
