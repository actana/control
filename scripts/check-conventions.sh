#!/bin/sh
# The repo's commit and branch rules, in one place (#614).
#
# Three callers read this file and nothing else for the rule: the `commit-msg`
# and `pre-push` hooks in .husky/, and the `Conventions` job in
# .github/workflows/ci.yml. A rule that lives in one script cannot be one thing
# on a laptop and another in CI. The commit rules themselves are in
# commitlint.config.mjs; the branch rule is below.
#
#   check-conventions.sh branch <name>        branch name follows <type>/<kebab-case>
#   check-conventions.sh message <file>       commit message file (as git hands commit-msg)
#   check-conventions.sh message -            commit message on stdin (the PR title)
#   check-conventions.sh range <from> <to>    every commit in `git log <from>..<to>`
#   check-conventions.sh last                 the tip commit alone
#
# Exit 0: passes. 1: breaks a rule. 2: cannot check (commitlint not installed).
#
# CI installs commitlint outside the checkout and points here with
# COMMITLINT_BIN and COMMITLINT_CONFIG; a developer's clone needs neither.
#
# POSIX sh on purpose: it runs from git hooks, where bash is not promised.

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${COMMITLINT_BIN:-$root/node_modules/.bin/commitlint}"
config="${COMMITLINT_CONFIG:-$root/commitlint.config.mjs}"

# Keep this list in sync with CONTRIBUTING.md § Branch naming and the type list
# in commitlint.config.mjs (branch types are the commit types plus the aliases).
branch_types='feat|feature|fix|bugfix|hotfix|release|chore|docs|refactor|perf|test|ci|revert'
branch_pattern="^($branch_types)/[a-z0-9]+([._-][a-z0-9]+)*\$"

check_branch() {
  branch="$1"

  # Bots name their own branches and cannot be asked to stop. Dependabot opens
  # `dependabot/npm_and_yarn/<dep>-<version>`; their commit messages are still
  # linted, which is the part that reaches main.
  if printf '%s\n' "$branch" | grep -qE '^(dependabot|renovate)/'; then
    echo "✅ Branch name '$branch' is bot-generated — convention not enforced."
    return 0
  fi

  # The train (ADR 0023 D1, D3, D46). A promotion pull request's head *is*
  # `beta/x.y.z`, a class the convention below does not know about. The shape is
  # asserted rather than waved through: `beta/` plus a bare `x.y.z`, optionally
  # a `-fN` sub-beta suffix (D46), and nothing else. `-fN` and not `.N`: a
  # fourth dot is not semver and npm refuses it.
  if printf '%s\n' "$branch" | grep -qE '^beta/[0-9]+\.[0-9]+\.[0-9]+(-f[0-9]+)?$'; then
    echo "✅ Branch name '$branch' is a release train (ADR 0023 D1, D46)."
    return 0
  fi

  if printf '%s\n' "$branch" | grep -qE "$branch_pattern"; then
    echo "✅ Branch name '$branch' is valid."
    return 0
  fi

  echo "❌ Branch name '$branch' violates the convention: it must be <type>/<kebab-case-description> with type $branch_types."
  echo ""
  echo "Examples: feat/proj-123-oauth-device-flow, fix/header-crash, release/v1.4.0"
  echo "Rules: lowercase only; words separated by hyphens; no consecutive/leading/trailing separators."
  echo "Fix: rename the branch with 'git branch -m <new-name>'."
  return 1
}

need_commitlint() {
  [ -x "$bin" ] && return 0
  echo "❌ commitlint is not installed at $bin, so the commit rules cannot be checked: run 'corepack pnpm install' in the repo root." >&2
  return 2
}

# commitlint reports on stdout; send it to stderr so a hook's refusal is on the
# stream git shows the developer.
run_commitlint() {
  need_commitlint || return 2
  "$bin" --config "$config" --cwd "$root" --verbose "$@" 1>&2
}

case "${1:-}" in
  branch)
    [ $# -eq 2 ] || { echo "usage: $0 branch <name>" >&2; exit 2; }
    check_branch "$2" >&2 || exit $?
    ;;
  message)
    [ $# -eq 2 ] || { echo "usage: $0 message <file|->" >&2; exit 2; }
    if [ "$2" = "-" ]; then run_commitlint; else run_commitlint --edit "$2"; fi
    ;;
  range)
    [ $# -eq 3 ] || { echo "usage: $0 range <from> <to>" >&2; exit 2; }
    run_commitlint --from "$2" --to "$3"
    ;;
  last)
    run_commitlint --last
    ;;
  *)
    echo "usage: $0 branch <name> | message <file|-> | range <from> <to> | last" >&2
    exit 2
    ;;
esac
