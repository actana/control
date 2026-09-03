#!/usr/bin/env bash
# The promotion gate is a gate, and this is what makes that true of the merge
# button as well as of the prose (ADR 0023 D5, D16; #264).
#
# A pull request from `beta/x.y.z` into `main` exists so that checks and an
# approval can accumulate on it. `promote.yml` consumes it and advances `main`
# by fast-forward. GitHub does not know that: on such a pull request the merge
# button is present, enabled, and green, and the repository's only enabled
# merge method is `squash` — the one that rewrites the SHA.
#
# On 2026-08-18 it was pressed on #259. The squash gave `main` a new commit with
# the same tree and a different SHA, so the train tip stopped being an ancestor
# of `main` and the SHA the D16 digest assertion verifies against ceased to
# exist on any branch. `v0.3.1` became unreleasable by `promote.yml`, by
# `release.yml` promote mode and by `release.yml` backport mode, and was
# abandoned. Nothing went red at the moment the button was pressed.
#
# This script is the mechanism that turns that into a red required check. It is
# the whole decision, in one file, so that both of its branches can be executed
# by a test rather than read out of a YAML string
# (`scripts/__tests__/promotion-gate.test.mjs`).
#
# ── Two properties this must keep ───────────────────────────────────────────
#
# 1. **Every pass case is an early successful exit, never a skip** (ADR 0023
#    D33). A required check whose job is skipped stays Pending forever and
#    blocks the pull request permanently — including the pull request that
#    would remove the requirement. The `Promotion gate` job therefore carries
#    no job-level `if:` at all, and every "nothing to enforce here" path below
#    ends in `exit 0` with a `::notice`, so "the check ran and found nothing"
#    and "the check did not run" stay distinguishable from the outside.
#
# 2. **It refuses one thing and waves through everything else.** A pull request
#    into an open train passes here. A pull request into `main` from a
#    non-`beta/*` head passes *here* and is refused by `Train rules` for D1's
#    reason — that refusal belongs to the branch model, not to this guard, and
#    two checks failing for one cause would make the fix harder to read.
#
# What it does not catch is what no option in #264 catches: an admin editing
# ruleset 20390421, or a future bypass actor. That bound is inherent.
#
# Environment:
#   EVENT_NAME  github.event_name
#   BASE        github.event.pull_request.base.ref
#   HEAD        github.event.pull_request.head.ref
#   HEAD_SHA    github.event.pull_request.head.sha   (optional, quoted in the refusal)
#   PR_NUMBER   github.event.pull_request.number     (optional, quoted in the refusal)
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
BASE="${BASE:-}"
HEAD="${HEAD:-}"
HEAD_SHA="${HEAD_SHA:-}"
PR_NUMBER="${PR_NUMBER:-}"

# `::error` is a single line to the runner: a literal newline would end the
# command and print the rest as plain log text, which is exactly the message
# not standing alone on screen. GitHub renders `%0A` back to a line break in
# the annotation, so the refusal arrives whole in the Checks tab without a
# link being followed.
encode() {
  local s="$1"
  s="${s//%/%25}"
  s="${s//$'\r'/%0D}"
  s="${s//$'\n'/%0A}"
  printf '%s' "$s"
}

# The annotation, the log and the run summary all carry the same text. The
# summary is written only when the runner gave us one, so the script runs the
# same way under the test harness as it does on a runner.
announce() {
  local title="$1" body="$2"
  printf '%s\n' "$body"
  echo "::error title=$title::$(encode "$body")"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '## %s\n\n' "$title"
      printf '```\n%s\n```\n' "$body"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [[ "$EVENT_NAME" != "pull_request" ]]; then
  # Not a skip — a run. There is no merge button on a push or a dispatch, so
  # there is nothing here to guard, and saying so costs one green job and buys
  # a required check that has no Pending state anywhere (D33).
  echo "::notice title=No merge button to guard::This is a '$EVENT_NAME' run, not a pull request. The promotion gate guards GitHub's merge button, which only exists on a pull request."
  exit 0
fi

echo "Base: $BASE"
echo "Head: $HEAD"

if [[ "$BASE" != "main" ]]; then
  echo "::notice title=Not a promotion gate::This pull request is based on \`$BASE\`, not \`main\`. Only a pull request into \`main\` can be the promotion gate, so there is nothing here to refuse."
  echo "✅ Nothing to guard: the base is \`$BASE\`."
  exit 0
fi

if [[ "$HEAD" != beta/* ]]; then
  # D1's refusal is `Train rules`', and deliberately not this check's. Work
  # reaches `main` only by promoting a train — but a pull request that should
  # never have targeted `main` is a branch-model violation, and it must keep
  # failing under the check whose message explains the branch model. This one
  # is about the merge button on a gate, and this pull request is not a gate.
  echo "::notice title=Not a promotion gate::This pull request is based on \`main\` with head \`$HEAD\`, which is not a train. It is not a promotion gate, so this check has nothing to refuse — \`Train rules\` is what holds it to ADR 0023 D1."
  echo "✅ Nothing to guard: the head is \`$HEAD\`, not \`beta/*\`."
  exit 0
fi

train="$HEAD"
sha="${HEAD_SHA:-not reported by the event payload}"
pr="${PR_NUMBER:+ (#$PR_NUMBER)}"

# A sub-beta head is still red here, and that is the point (ADR 0023 D46).
# Waving it through would exit 0, satisfy `docs/rulesets/main.json`'s required
# context, and re-enable the merge button on a pull request that must never be
# merged — the exact failure this file exists to make impossible. What changes
# is only the dispatch printed below: `promote.yml` refuses a sub-beta, so
# telling a reader to run it against one would send them to a second refusal
# instead of to the merge-back that is the actual next step.
if [[ "$train" =~ ^beta/[0-9]+\.[0-9]+\.[0-9]+-f[0-9]+$ ]]; then
  plain="${train%-f*}"
  next="gh pr create --base $plain --head $train   # then promote $plain"
else
  next="gh workflow run promote.yml -f train=$train"
fi

announce "Do not merge this pull request — it is a gate, not a merge" \
"DO NOT PRESS THE MERGE BUTTON ON THIS PULL REQUEST$pr.

This is the promotion gate for the train \`$train\`. Its checks and its approval
are the point; a workflow performs the advance. This check is red on purpose,
it stays red for the life of this pull request, and red is the healthy state
for a promotion gate.

Do this instead:

    $next

ADR 0023 D5 — \`main\` advances only by fast-forward. Not a squash, not a merge
commit. A fast-forward makes the commit on \`main\` byte-identical to the tip
that was tested, which is what the digest verification depends on.

ADR 0023 D16 — the promoted digest is verified, not trusted: promotion asserts
that the image's \`org.opencontainers.image.revision\` label equals THIS pull
request's head SHA, which is $sha.

Squash is the only merge method this repository enables, so the button in front
of you writes a NEW commit with a NEW SHA. The tested SHA then exists on no
branch, D16's assertion can never pass again, and the release becomes
unreachable by \`promote.yml\`, by \`release.yml\` promote mode and by
\`release.yml\` backport mode alike. That is not hypothetical: it happened to
#259 on 2026-08-18 and \`v0.3.1\` was abandoned.

\`promote.yml\` never reads this check. It reads that this pull request exists
and is unique, takes its head SHA, re-checks ancestry and fast-forwards \`main\`
to that exact commit — then GitHub closes this pull request as merged by
itself (D14). A permanently red gate does not block the release; pressing the
button is what blocks it."

exit 1
