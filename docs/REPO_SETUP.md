# Repository Setup Checklist (Admin)

Templates only work if the platform enforces them. Work through this once for
`actana/control`; most of it is GitHub settings the files in this repo cannot
set for themselves.

Items marked **⚠ before public** must be done before the repository's
visibility is flipped from private to public.

## 1. Placeholders that must become real

- [ ] **⚠ before public** — `TODO-SET-CONDUCT-EMAIL` in
      [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) → a real, monitored inbox.
      A Code of Conduct with no working reporting channel is worse than none.
- [ ] **⚠ before public** — create the **`@actana/maintainers`** team in the
      org and give it write access. Every rule in
      [`.github/CODEOWNERS`](../.github/CODEOWNERS) names it; if the team does
      not exist GitHub assigns nobody, and with "Require review from Code
      Owners" enabled no PR can ever be approved.
- [ ] Confirm the org/repo slug is `actana/control` everywhere
      (`grep -rn "actana/control"` should match; `grep -rn "AgentSystemLabs"`
      should match **only** `NOTICE`, `docs/upstream/`, `docs/agents/upstream-harvest.md`,
      and historical ADRs/specs — those are fork attribution and must not change).

## 2. Secrets and variables

Set under **Settings → Secrets and variables → Actions**.

| Name | Kind | Needed for |
| --- | --- | --- |
| `DOCKERHUB_USERNAME` | Secret | Publishing the Panel image to Docker Hub |
| `DOCKERHUB_TOKEN` | Secret | Same — a Docker Hub **access token**, not the account password |
| `DOCKERHUB_NAMESPACE` | Variable | Docker Hub org to publish under. Optional; defaults to the GitHub owner (`actana`) |

Nothing else is required: GHCR authenticates with the workflow's own
`github.token`. If `DOCKERHUB_TOKEN` is unset, every Docker Hub step is skipped
and releases still publish to GHCR — which is what makes forks and pre-key
builds work. See [`ci-cd.md`](ci-cd.md).

Create the Docker Hub token at **Docker Hub → Account Settings → Personal
access tokens** with **Read & Write** scope, then:

```bash
gh secret set DOCKERHUB_USERNAME --repo actana/control
gh secret set DOCKERHUB_TOKEN    --repo actana/control
gh variable set DOCKERHUB_NAMESPACE --repo actana/control --body actana
```

## 3. Branch ruleset for `main` (Settings → Rules → Rulesets)

- [ ] **Restrict deletions** and **block force pushes**
- [ ] **Require a pull request before merging**
  - [ ] Required approvals: **1**
  - [ ] **Dismiss stale approvals** when new commits are pushed
  - [ ] **Require review from Code Owners** _(only after step 1's team exists)_
  - [ ] Require approval of the most recent reviewable push
  - [ ] **Require conversation resolution** before merging
- [ ] **Require status checks to pass** (and require branches to be up to date):
  - [ ] `PR title (Conventional Commits)`
  - [ ] `Commit messages (commitlint)`
  - [ ] `Branch name convention`
  - [ ] `Typecheck`, `Unit Tests`, `Lint`, `Secret Scan`
  - [ ] `Panel image` — the PR container build
  - [ ] The E2E legs you want blocking. They are slow; a common split is to
        require the fast four plus `Panel image`, and let the installer matrix
        run without blocking.
- [ ] **Require linear history**
- [ ] Do **not** add bypass actors (or restrict to break-glass admins only)

Optional: a second ruleset on branch **creation** restricting new branch names
to the allowed prefixes. GitHub enforces that natively, which turns the
`Branch name convention` job into a friendly error rather than the only gate.

## 4. Merge settings (Settings → General)

- [ ] ✅ **Allow squash merging** — default commit message: **"Pull request title"**
- [ ] ❌ Disallow merge commits
- [ ] ❌ Disallow rebase merging
- [ ] ✅ Automatically delete head branches
- [ ] ✅ Always suggest updating pull request branches

Squash-with-PR-title is what makes the `PR title (Conventional Commits)` check
load-bearing: the title becomes the commit message on `main`, which is what the
changelog is assembled from.

## 5. Features

- [ ] Enable **Discussions** — [`SUPPORT.md`](../SUPPORT.md) and the issue
      template chooser both link to it, and those links 404 until it is on
- [ ] **⚠ before public** — enable **Private vulnerability reporting**
      (Settings → Security). [`SECURITY.md`](../SECURITY.md) makes it the only
      reporting channel
- [ ] Enable Dependabot alerts + security updates
- [ ] Enable secret scanning + push protection
- [ ] Set the GHCR package `actana-panel` to **public** once the repo is public,
      or `docker pull` fails for everyone but org members

## 6. Labels

Two axes. **`type:`** says what a thing is; the bare words are the triage
states the `/triage` skill reads (see
[`agents/triage-labels.md`](agents/triage-labels.md)) — keep those five
spelled exactly as they are, they are a contract.

```
type: bug | type: feature | type: docs | type: task | type: dependencies
needs-triage | needs-info | ready-for-agent | ready-for-human | wontfix
priority: p0 | priority: p1 | priority: p2 | priority: p3
good first issue | help wanted | rfc | pinned | security | blocked | stale
```

Creating them all:

```bash
set -e
repo=actana/control
new() { gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force; }

new "type: bug"           d73a4a "A reproducible defect"
new "type: feature"       a2eeef "New functionality"
new "type: docs"          0075ca "Documentation only"
new "type: task"          cfd3d7 "Chore or maintenance work"
new "type: dependencies"  0366d6 "Dependency updates"

new "needs-triage"        ededed "Awaiting maintainer triage"
new "needs-info"          d4c5f9 "Waiting on the reporter for more information"
new "ready-for-agent"     0e8a16 "Fully specified, ready for an AFK agent"
new "ready-for-human"     1d76db "Requires human implementation"
new "wontfix"             ffffff "Will not be actioned"

new "priority: p0"        b60205 "Drop everything"
new "priority: p1"        d93f0b "Next up"
new "priority: p2"        fbca04 "Scheduled"
new "priority: p3"        fef2c0 "Someday"

new "good first issue"    7057ff "Good for newcomers"
new "help wanted"         008672 "Extra attention is wanted"
new "rfc"                 5319e7 "Design discussion, not yet actionable"
new "pinned"              c5def5 "Never auto-closed as stale"
new "security"            b60205 "Security-relevant; never auto-closed"
new "blocked"             e4e669 "Blocked on something else"
new "stale"               795548 "Inactive; scheduled for auto-close"
```

`pinned`, `security`, `blocked`, and `needs-info` are exempt from the stale bot
([`stale.yml`](../.github/workflows/stale.yml)) — an issue waiting on a
maintainer's question should not be closed for the reporter's silence.

## 7. Local hooks (optional, per clone)

The hooks in `.husky/` run under plain git — husky itself is not a dependency:

```bash
git config core.hooksPath .husky
```

`commit-msg` checks the message against `commitlint.config.mjs`; `pre-push`
checks the branch name. Both mirror the Conventions workflow, so they only tell
you earlier what CI would have told you later. `commit-msg` no-ops with a hint
if commitlint is not installed locally — install it with
`npm install --no-save @commitlint/cli @commitlint/config-conventional`.

## 8. Org-level reuse

- [ ] Put shared community health files into a repo named **`.github`** in the
      actana org — repos without their own copies inherit them automatically
- [ ] Define rulesets at the **organization level** so branch protection is
      uniform and cannot drift per-repo
- [ ] Re-run this checklist when conventions change; settings rot silently
