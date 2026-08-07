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

## 2. Secrets, variables, and environments

Set under **Settings → Secrets and variables → Actions** — except the
environment at the end of this section, which lives under **Settings →
Environments**.

| Name | Kind | Needed for |
| --- | --- | --- |
| `DOCKERHUB_USERNAME` | Secret | Publishing `panel` and `core` to Docker Hub, and syncing each image's README |
| `DOCKERHUB_TOKEN` | Secret | Same — one **personal** access token, `Read & Write`, not the account password |
| `DOCKERHUB_NAMESPACE` | Variable | Docker Hub org to publish under. Optional; defaults to the GitHub owner (`actana`) |

With these set, both images publish to `docker.io/actana/panel` and
`docker.io/actana/core`, and each image's Docker Hub page is rewritten from
`docs/images/`.

Docker Hub is the **only** registry
([ADR 0018](adr/0018-docker-hub-is-the-only-registry.md) — GHCR was retired),
so the pair is required wherever images are published: a release or edge build
without it fails before anything is built. PR builds never push and need no
credentials, so a fork gets green PRs with nothing set. See
[`ci-cd.md`](ci-cd.md).

### It must be a *personal* access token, and one token does both jobs

Pushing an image and editing a repository's description go through different
systems: the image push authenticates to the **registry**, where an
organization access token is fine; the description is set through the **Hub
API**, whose `/v2/users/login` endpoint refuses organization accounts outright —

```
{"detail":"Cannot log into an organization account"}
```

So an OAT would mean paying for a Docker Team or Business subscription **and
still** provisioning a PAT. One PAT does both instead: create it under your
**Account settings → Personal access tokens** with **Read & Write** scope, from
an account with **Admin** on the org, and set `DOCKERHUB_USERNAME` to that
account's own username (not the org — the org goes in `DOCKERHUB_NAMESPACE`).

```bash
gh secret set DOCKERHUB_USERNAME --repo actana/control   # e.g. qcenticadm
gh secret set DOCKERHUB_TOKEN    --repo actana/control
gh variable set DOCKERHUB_NAMESPACE --repo actana/control --body actana
```

A wrong pairing is the single most common way to get
`unauthorized: incorrect username or password` from an otherwise correct setup.

### Rotating it — the token belongs to a person

That is the honest cost of one PAT: it is scoped to an individual Docker Hub
account, and it dies with that account. Nobody notices until a release fails at
the push, which is the worst moment to find out.

- [ ] Record **whose** account owns the token, next to the org's other
      break-glass credentials
- [ ] Rotate on a schedule — Docker Hub PATs can be given an expiry, so set one
- [ ] Rotate immediately when that person's access to the org changes, and treat
      an account that leaves as a compromised credential: revoke first,
      re-provision second

To rotate, create the new token first — overwriting the secret is atomic, so
nothing is unpublishable in between:

```bash
gh secret set DOCKERHUB_USERNAME --repo actana/control
gh secret set DOCKERHUB_TOKEN    --repo actana/control
gh workflow run release.yml --repo actana/control -f tag=<the latest tag>
```

The dispatch re-runs the whole tag, which is what proves the new token pushes
images. `gh workflow run housekeeping.yml --repo actana/control -f
chore=descriptions` proves it still updates the Docker Hub pages. Then delete
the old token in Docker Hub.

### `DOCKERHUB_CLEANUP_TOKEN` — the second, delete-capable token

The weekly `dev-tag-sweep` chore deletes stale `pr-*` and `sha-*` tags from
`panel-dev` and `core-dev`, and delete is a permission the push token must never
have. It is therefore a **second** PAT, and it is the more dangerous of the two:
Docker Hub personal access tokens carry an account-wide permission level rather
than a repository list, so this one can delete from `actana/panel` and
`actana/core` as well, and Docker Hub has no undelete.

The only thing preventing that is the hard-coded, exact-match repository
allowlist in `scripts/lib/dev-tag-sweep.mjs` — re-asserted before every delete
call, refusing to run when empty, and unit-tested against a release repository
handed to it by name ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D38, as amended). Treat
that list the way you would treat a production database credential.

- [ ] Create a PAT with **Read, Write & Delete** scope, from an account with
      Admin on the org
- [ ] `gh secret set DOCKERHUB_CLEANUP_TOKEN --repo actana/control`
- [ ] Rotate it on the same schedule and under the same conditions as the push
      token above
- [ ] Prove it before trusting it: `gh workflow run housekeeping.yml --repo
      actana/control -f chore=dev-tag-sweep -f dry-run=true` reports every tag
      it would delete and every tag it would keep, and deletes nothing

Unset, the chore skips with a notice rather than failing — which is the right
answer on a fork, and the wrong answer to ignore here.

### The `macos-release` environment — the one human gate in a release

Set under **Settings → Environments**, not under Secrets and variables. It
holds no secrets at all; the only thing it carries is a list of people.

> **Do this before the first `v*` tag, not after.** A missing environment is
> not a red build — GitHub auto-creates a referenced environment with **no
> protection rules** on first use, so the mac leg would run immediately and the
> whole release would publish unreviewed, silently. `GET
> /repos/actana/control/environments` returning `total_count: 0` means the gate
> described below does not exist yet.

- [ ] Create an environment named exactly **`macos-release`**
- [ ] **Required reviewers** → the people who own a Mac and can run the
      checklist. At least one, and give it more than one — until somebody
      approves, nothing a release would publish is published
- [ ] Leave **deployment branches** unrestricted: the job that uses it runs on
      a `v*` tag, and a branch restriction would refuse the tag
- [ ] Confirm it took: `gh api repos/actana/control/environments --jq
      '.environments[].name'` lists `macos-release`

`release.yml`'s `tarball-macos` job declares this environment, so on a tag push
it enters **waiting** and burns no runner minutes until it is approved
([ADR 0016](adr/0016-the-0-1-0-shape.md) D28, as amended). Approval is not a
formality: the reviewer runs
[`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md) on
real Apple hardware — Gatekeeper on an unsigned bundle, and whether the
LaunchAgent survives a reboot and a logout — none of which a runner that is
destroyed rather than restarted can answer. Clicking approve is the statement
that it passed.

**What a reviewer's approval actually controls: everything a release
publishes.** `github-release` needs that job, and so do the `panel` and `core`
image builds. So a rejection stops the GitHub Release, the tarballs, both
images and `:latest`. (The Docker Hub pages are no longer downstream of it —
they sync on a weekly clock now, and a page is not a published artifact.) That
is the property worth protecting: an image push cannot be undone
and `:latest` has no history, so a reviewer who rejects on a Gatekeeper blocker
must be able to believe nothing shipped. The cost is that a release is as slow
as its reviewer, which is the cheaper side of the trade.

## 3. Branch ruleset for `main` (Settings → Rules → Rulesets)

- [ ] **Restrict deletions** and **block force pushes**
- [ ] **Require a pull request before merging**
  - [ ] Required approvals: **1**
  - [ ] **Dismiss stale approvals** when new commits are pushed
  - [ ] **Require review from Code Owners** _(only after step 1's team exists)_
  - [ ] Require approval of the most recent reviewable push
  - [ ] **Require conversation resolution** before merging
- [ ] **Require status checks to pass** (and require branches to be up to date):
  - [ ] `Conventions` — PR title, commit messages, and branch name, in one job
  - [ ] `Typecheck`, `Unit Tests`, `Lint`, `Secret Scan`, `Dependency Audit`
  - [ ] `Panel image` and `Core image` — the PR container builds
  - [ ] The E2E legs you want blocking. They are slow; a common split is to
        require the fast four plus both image builds, and let the installer
        matrix run without blocking.
- [ ] **Require linear history**
- [ ] Do **not** add bypass actors (or restrict to break-glass admins only)

Optional: a second ruleset on branch **creation** restricting new branch names
to the allowed prefixes. GitHub enforces that natively, which turns the
`Conventions` job's branch-name step into a friendly error rather than the only
gate.

## 4. Merge settings (Settings → General)

- [ ] ✅ **Allow squash merging** — default commit message: **"Pull request title"**
- [ ] ❌ Disallow merge commits
- [ ] ❌ Disallow rebase merging
- [ ] ✅ Automatically delete head branches
- [ ] ✅ Always suggest updating pull request branches

Squash-with-PR-title is what makes the `Conventions` job's PR-title check
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
- [ ] Check that **all four Docker Hub pages render** — `actana/panel`,
      `actana/core`, `actana/panel-dev` and `actana/core-dev`. Nothing here is
      manual: `housekeeping.yml`'s `descriptions` job PATCHes each page from
      [`docs/images/`](images/) on the weekly tick ([ADR
      0023](adr/0023-release-trains-and-digest-promotion.md) D43), and a typo is
      fixed by editing the file and waiting for Monday — or dispatching the
      chore. No page has ever been published, so the first tick is the first
      time any of them is seen.

## 6. Tag history

- [ ] `git tag -l` is empty in your clone, and every fork-parent remote is
      configured not to re-import tags (see below)
- [ ] Optional: a **tag ruleset** (Settings → Rules → Rulesets, target *Tags*)
      restricting creation to `v*` and restricting deletions

**This repository's tag history starts at `v0.1.0`.** `actana/control` carries
zero tags and zero releases today, and that is deliberate — clause D27 of ADR
0016, *The 0.1.0 shape*, tracked on
[#23](https://github.com/actana/control/issues/23). The version resets to
`0.1.0` because this repository has shipped zero times; the `0.49.0` that
appears in the fork parent's manifests belongs to a different product.

Clones made from the fork parent inherit **102 tags**, `v0.5.0` … `v0.49.0`,
pointing at commits this repository has never contained — `main` here is a
single squashed commit, and every one of those tags drags the upstream Electron
history behind it. They are **deleted on sight, not merely left unpushed**,
because leaving them in a clone is a loaded gun:

- [`release.yml`](../.github/workflows/release.yml) triggers on `v*`, so a
  single `git push --tags` would both re-import the upstream history into a
  repository that was squashed on purpose **and** fire 102 release runs —
  each one publishing tarballs, two images and a GitHub Release.
- They sort above `0.1.0`, so `git describe` and any future mirror would report
  a version this product has never released.

Nothing is lost by deleting them: those tags are still on the fork parent
(`AgentSystemLabs/mission-control`), where they belong.

Deleting them once is not enough. `git fetch` follows tags by default, so any
remote still pointing at the fork parent re-imports all 102 on the next fetch.
A clone with such a remote needs both halves, and in that order:

```bash
git config remote.origin.tagOpt --no-tags   # repeat for every fork-parent remote
git tag -l | xargs -r git tag -d            # then verify: git tag -l
```

A clone made from `actana/control` alone needs neither — there are no tags to
inherit and no remote to inherit them from.

## 7. Labels

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
([`housekeeping.yml`](../.github/workflows/housekeeping.yml)'s `stale` job) — an issue waiting on a
maintainer's question should not be closed for the reporter's silence.

## 8. Local hooks (optional, per clone)

The hooks in `.husky/` run under plain git — husky itself is not a dependency:

```bash
git config core.hooksPath .husky
```

`commit-msg` checks the message against `commitlint.config.mjs`; `pre-push`
checks the branch name. Both mirror the `Conventions` job in
[`ci.yml`](../.github/workflows/ci.yml), so they only tell
you earlier what CI would have told you later. `commit-msg` no-ops with a hint
if commitlint is not installed locally; the install line is in
[`ci-cd.md`](ci-cd.md#running-ci-locally) — it goes through a temp directory
because npm cannot parse this pnpm workspace's root `package.json`.

## 9. Org-level reuse

- [ ] Put shared community health files into a repo named **`.github`** in the
      actana org — repos without their own copies inherit them automatically
- [ ] Define rulesets at the **organization level** so branch protection is
      uniform and cannot drift per-repo
- [ ] Re-run this checklist when conventions change; settings rot silently
