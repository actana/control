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
      **Still missing:** `GET /orgs/actana/teams/maintainers` returns 404, so
      every ruleset in §3 ships with `require_code_owner_review: false`. That
      flag is the thing to revisit the moment this box is ticked.
- [ ] Confirm the org/repo slug is `actana/control` everywhere
      (`grep -rn "actana/control"` should match; `grep -rn "AgentSystemLabs"`
      should match **only** `NOTICE`, `docs/upstream/`, `docs/agents/upstream-harvest.md`,
      and historical ADRs/specs — those are fork attribution and must not change).

## 2. Secrets, variables, and environments

The secrets and the variable are set under **Settings → Secrets and variables →
Actions**. Three things in this section are not: the GitHub App is created
under the org's **Developer settings**, the two `-dev` image repositories are
created on **Docker Hub**, and the environment at the end lives under
**Settings → Environments**. Each subsection says which.

Every item here is a prerequisite of the ordered cutover in
[§3](#the-cutover-in-order) — that is the sequence these are done *in*; this
section is what each one is.

| Name | Kind | Needed for |
| --- | --- | --- |
| `DOCKERHUB_USERNAME` | Secret | Publishing `panel` and `core` to Docker Hub, and syncing each image's README |
| `DOCKERHUB_TOKEN` | Secret | Same — one **personal** access token, `Read & Write`, not the account password |
| `DOCKERHUB_CLEANUP_TOKEN` | Secret | The weekly `-dev` tag sweep, and nothing else — a **second**, delete-capable PAT |
| `APP_ID` | Secret | The GitHub App's numeric id. Every job in `promote.yml` that pushes |
| `APP_PRIVATE_KEY` | Secret | That App's private key, the whole PEM. Same jobs — **both or neither** |
| `DOCKERHUB_NAMESPACE` | Variable | Docker Hub org to publish under. Optional; defaults to the GitHub owner (`actana`) |

With the Docker Hub pair set, both images publish to `docker.io/actana/panel`
and `docker.io/actana/core`, and each image's Docker Hub page is rewritten from
`docs/images/`. With the App pair set, a promotion can write to `main`. Neither
pair substitutes for the other, and a missing one is a different failure: the
Docker Hub pair fails a build, the App pair fails a promotion.

Docker Hub is the **only** registry
([ADR 0018](adr/0018-docker-hub-is-the-only-registry.md) — GHCR was retired),
so the pair is required wherever images are published: a train build or a
release without it fails before anything is built. PR builds never push and
need no credentials, so a fork gets green PRs with nothing set. See
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

### The two `-dev` image repositories

`actana/panel-dev` and `actana/core-dev`, both **public**, created by hand on
Docker Hub. They are not optional and not cosmetic: a pull request build pushes
`pr-<prid><YYYYMM>` and a train push pushes `sha-<short>`, and with no
repository to push to, the build fails at the push ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D36).

They are separate repositories rather than extra tags on `actana/panel` and
`actana/core` for three reasons: the `descriptions` job exists to make the two
release pages presentable and hundreds of `pr-*` tags undo that; a
wrong-repository pull becomes impossible rather than merely unlikely; and it is
what bounds the blast radius of the delete credential below.

- [ ] Create `panel-dev` and `core-dev` under the same namespace as the release
      repositories, **public**
- [ ] Confirm `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` can push to both — the
      same pair does release and `-dev` pushes, there is no third credential
- [ ] Leave their descriptions empty. The weekly `descriptions` chore fills
      both the short description and the full page from
      [`docs/images/panel-dev.md`](images/panel-dev.md) and
      [`core-dev.md`](images/core-dev.md); typing something now only creates a
      thing to disagree with

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

### `APP_ID` and `APP_PRIVATE_KEY` — the GitHub App that writes to `main`

**If a promotion just failed with *"APP_ID and APP_PRIVATE_KEY must both be
set"*, this subsection is the answer.** Both are repository secrets under
**Settings → Secrets and variables → Actions**, and both come from one GitHub
App. Setting one is the same as setting neither: every pushing job in
[`promote.yml`](../.github/workflows/promote.yml) checks for both and fails the
run when either is empty.

Live today: the App is **`actana-release-train`**, owned by the `actana` org and
installed on `actana/control` with `repository_selection: selected`. Its app id
is **`4516237`** — that is the value of `APP_ID`, and it is also the number §3's
payloads want substituted for `"actor_id": 0`. Confirm rather than trust it:

```bash
gh api repos/actana/control/rulesets/20390421 \
  --jq '.bypass_actors[] | select(.actor_type=="Integration") | .actor_id'
```

#### Why it cannot be `GITHUB_TOKEN`

Two reasons, and **the first fails silently** ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D39):

- **GitHub does not trigger workflows from pushes made with the default
  `GITHUB_TOKEN`.** A promotion pushing `vx.y.z` with it produces a tag and no
  release, with nothing red anywhere; the fast-forward of `main` likewise never
  fires [`landing.yml`](../.github/workflows/landing.yml), so a landing-page
  change merged through a train quietly stops deploying.
- `main` and `beta/*` require a pull request before merging, so a direct push
  needs a **bypass actor**, and `GITHUB_TOKEN` cannot be one.

That is why the credential check is an error and never a fallback. The fallback
is the failure this design exists to prevent, and it is the one that looks
green.

#### What the App does with it

Six operations, all of them in `promote.yml` where they can be read: it writes
the train-cut commit, fast-forwards `main`, pushes the `vx.y.z` tag, creates
the `release/x.y` line, deletes the promoted train, and force-pushes the
post-hotfix rebase of a surviving train — commenting on that train's open pull
requests as it does (D24). Nothing else in the repository uses it. `ci.yml`,
`release.yml`, `housekeeping.yml` and `landing.yml` all run on `GITHUB_TOKEN`,
because none of them writes to a protected ref.

#### Creating it, if it does not exist

- [ ] **Org settings → Developer settings → GitHub Apps → New GitHub App.**
      Owner is the **org**, not a person — an App owned by an individual dies
      with that account, which is the failure mode the Docker Hub PAT already
      has and this one need not
- [ ] **No webhook.** Uncheck *Active*; it receives no events and never should.
      The live App reports `events: []`
- [ ] **Repository permissions — exactly four**, the table below
- [ ] **Install it on `actana/control`** — *Only select repositories*, not *All*
- [ ] **Generate a private key** and download the `.pem`. GitHub shows it once
- [ ] **Set both secrets**, with the commands below
- [ ] Delete the local `.pem` once the secret is set
- [ ] Make it a **bypass actor** on the `main`, `beta/*` and `refs/tags/v*`
      rulesets — §3, and the reason three payloads carry an `actor_id`
      placeholder at all

The four permissions:

| Permission | Level | Why |
| --- | --- | --- |
| Contents | Read & write | Every push: the train-cut commit, the branches, the tag |
| Workflows | Read & write | **The one that is easy to miss.** Without it, any promotion whose train touched `.github/workflows/` is rejected — and only that one, so it looks like an unrelated fault |
| Pull requests | Read & write | The comment on each open pull request into a rebased train (D24) |
| Metadata | Read-only | Mandatory; GitHub adds it for you |

Nothing beyond those four. The App is a bypass actor on the branch that
everything ships from, so its permission list is the blast radius.

```bash
gh secret set APP_ID          --repo actana/control --body 4516237
gh secret set APP_PRIVATE_KEY --repo actana/control < actana-release-train.private-key.pem
```

`APP_PRIVATE_KEY` is the **entire** PEM, including the `-----BEGIN…` and
`-----END…` lines and every newline between them. Piping the file in is what
keeps them; pasting into the web form works too, pasting a single line does
not — and a mangled key is invisible until the first promotion tries to use it.

#### Two things to verify, because neither is visible from outside

Actions secrets are write-only, so a truncated key and a correct one look
identical from the settings page. Both of these were carried forward unverified
from #108.

- [ ] **An App push actually triggers a workflow.** This is the assumption the
      entire promotion rests on. Push a trivial commit to a throwaway branch
      using a token minted from these two secrets, and watch a workflow start.
      Do it before the first promotion, not during it
- [ ] **The private key is a complete, valid PEM.** The same throwaway run
      proves it: `actions/create-github-app-token` fails loudly on a malformed
      key, which is the only cheap way to find out

#### Rotating the key

Same posture as the Docker Hub PAT, with one difference in its favour: the App
belongs to the org rather than to a person, so a maintainer leaving does not
strand it.

- [ ] Generate the new key **first**, set the secret, then delete the old key in
      the App's settings. An App may hold more than one key at a time, so there
      is no window in which promotion is broken
- [ ] Rotate immediately if the `.pem` was ever written somewhere it should not
      have been. A leaked App key is push access to `main` that bypasses the
      ruleset — treat it as the most dangerous credential in the repository
- [ ] Prove the new key before deleting the old one, the same way as above

### The `macos-release` environment — the one human gate in a release

Set under **Settings → Environments**, not under Secrets and variables. It
holds no secrets at all; the only thing it carries is a list of people.

> **Do this before the first promotion, not after.** A missing environment is
> not a red build — GitHub auto-creates a referenced environment with **no
> protection rules** on first use, so the gated job would run immediately and
> the whole release would publish unreviewed, silently. `GET
> /repos/actana/control/environments` returning `total_count: 0` means the gate
> described below does not exist yet.
>
> **It returns `total_count: 0` today.** The repository has no environments at
> all — not `macos-release`, not any other. `promote.yml` has landed and its
> first job declares `environment: macos-release`, so the next promotion
> dispatch will auto-create it unprotected and run straight through the human
> gate. Creating it, **with at least one required reviewer**, is a prerequisite
> for the first promotion, not a tidy-up after it.

- [ ] Create an environment named exactly **`macos-release`**
- [ ] **Required reviewers** → the people who own a Mac and can run the
      checklist. At least one, and give it more than one — until somebody
      approves, nothing a release would publish is published
- [ ] Leave **deployment branches** unrestricted: a branch restriction would
      refuse the ref the gated job runs on
- [ ] Confirm it took: `gh api repos/actana/control/environments --jq
      '.environments[].name'` lists `macos-release`

> **The job that declares this environment is moving.** `release.yml`'s
> `tarball-macos` no longer declares it: under [ADR
> 0023](adr/0023-release-trains-and-digest-promotion.md) D15 the pause is the
> **first** thing `promote.yml` does, so the fast-forward onto `main` is
> downstream of the human as well and `main` never contains unapproved code.
> Exactly one pause exists either way. `promote.yml` has since landed (#111),
> so the environment is now referenced by a real job — the inertness that made
> it safe to defer is gone, and the missing environment is silently unprotected
> rather than red.
>
> The rest of this section is unchanged by that move: same environment name,
> same reviewers, same checklist. What changes is *when* the reviewer is asked
> — before the promotion is dispatched, against the train tip, rather than
> after a tag is pushed. By D16's assertion that is the same commit, and it is
> available earlier.

Approval is not a formality: the reviewer runs
[`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md) on
real Apple hardware — Gatekeeper on an unsigned bundle, and whether the
LaunchAgent survives a reboot and a logout — none of which a runner that is
destroyed rather than restarted can answer. Clicking approve is the statement
that it passed.

**What a reviewer's approval controls: everything a release publishes.** With
the pause at the head of promotion, that is the whole of it — the fast-forward,
the tag, both images and `:latest`, the GitHub Release and its tarballs.
(The Docker Hub pages are not downstream of it — they sync on a weekly clock
now, and a page is not a published artifact.) That is the property worth
protecting: an image push cannot be undone and `:latest` has no history, so a
reviewer who rejects on a Gatekeeper blocker must be able to believe nothing
shipped. The cost is that a release is as slow as its reviewer, which is the
cheaper side of the trade.

## 3. Branch rulesets (Settings → Rules → Rulesets)

Four branch rulesets and one tag ruleset, applied from the JSON payloads in
[`rulesets/`](rulesets/) rather than clicked into the form. The reason is
restorability: a ruleset assembled in a web form is a configuration nobody can
diff, nobody can review, and nobody can put back after somebody edits it at
11pm. The payloads are the source of truth; this section is the order to apply
them in and the preconditions that make each one safe.

| Ruleset | Payload | Applies to |
| --- | --- | --- |
| Protect main | [`rulesets/main.json`](rulesets/main.json) | `main` — update of existing **20390421** |
| Trains — `beta/*` | [`rulesets/beta.json`](rulesets/beta.json) | `refs/heads/beta/**` — new |
| Release lines — `release/*` | [`rulesets/release.json`](rulesets/release.json) | `refs/heads/release/**` — new |
| Retired release lines | [`rulesets/release-retired.json`](rulesets/release-retired.json) | one named retired line — new, one per retirement |
| Release tags | [`rulesets/tag-release-cut.json`](rulesets/tag-release-cut.json) | `refs/tags/v*` — update of existing **20390424** |

The model these encode is [ADR
0023](adr/0023-release-trains-and-digest-promotion.md) D1, D2, D5, D24, D27,
D39: work reaches `main` only by promoting a train, a train is a `beta/x.y.z`
branch, and the App is the one identity allowed to write to protected refs
without a pull request.

### Before you apply anything

> **Getting the order wrong locks the repository.** A required check whose job
> has never run leaves every pull request Pending forever — not red, Pending —
> including the pull request that would remove the requirement. There is no
> way out except an admin editing the ruleset by hand.

- [ ] **`Train rules` has been watched running green at least once.** It has:
      it reports `success` on #116, #130 and #131. Confirm it still does on the
      most recent merged pull request before applying `main.json`, because the
      whole enforcement story rests on that one check name existing.
- [ ] **The App exists and its id is to hand.** `APP_ID` and `APP_PRIVATE_KEY`
      are set (#108, closed). `APP_ID`'s value is the number the payloads want,
      and §2 has where to read it and what to do when it is missing.
- [ ] **All of #109–#113 are merged.** Applying `main.json` is the moment
      "pull requests to `main` only from `beta/*`" stops being advisory, and
      from that moment any foundation pull request still open cannot merge.
- [ ] Everything below is run by a human with admin rights, from a clone, after
      the merge to `main`. **No workflow and no agent branch applies rulesets.**

### The cutover, in order

The admin-console steps and the code steps interlock, and three of the
interlocks are sharp enough to be worth stating before the list rather than
inside it ([ADR
0023](adr/0023-release-trains-and-digest-promotion.md) § *Sequencing*, which
this expands rather than restates):

- **A required check that names nothing is Pending forever**, so `main.json`
  cannot be applied before `Train rules` has been watched running green.
- **A missing environment is not a red build.** GitHub auto-creates a
  referenced environment with no protection rules, so a first promotion run
  before `macos-release` exists sails through the human gate silently.
- **The tag ruleset is the last thing a promotion touches and the worst place
  to fail.** If the App is not a bypass actor there, the run stops *after* it
  has already fast-forwarded `main`.

Steps 1–4 are reversible. From step 5 the repository is enforcing, and from
step 9 something is published that cannot be unpublished.

| # | Step | Where | Reversible? |
| --- | --- | --- | --- |
| 1 | The GitHub App exists, is installed, and `APP_ID` / `APP_PRIVATE_KEY` are set | §2 | yes |
| 2 | `panel-dev` and `core-dev` exist; the Docker Hub pair and `DOCKERHUB_CLEANUP_TOKEN` are set | §2 | yes |
| 3 | `macos-release` exists with at least one required reviewer | §2 | yes |
| 4 | This effort is merged to `main` by the old process — one pull request, the whole of #107 | — | yes |
| 5 | `Train rules` watched green on that merge | — | n/a |
| 6 | `beta.json`, `release.json`, `main.json`, `tag-release-cut.json` applied, in that order | §3a–§3e | by hand |
| 7 | The two binding checks pass | §3 *Verify it actually binds* | n/a |
| 8 | `beta/0.1.0` cut | #115 | yes |
| 9 | The first promotion is dispatched and approved | `ci-cd.md` | **no** |

- [ ] **1. The App.** Created, installed on `actana/control` with the four
      permissions, both secrets set, and an App push confirmed to trigger a
      workflow ([§2](#2-secrets-variables-and-environments)). Everything from
      step 6 onwards assumes the id in `APP_ID` is real, because it is what
      gets substituted into three payloads.
- [ ] **2. The image repositories and their credentials.** `panel-dev` and
      `core-dev` public, `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` able to push
      to all four, `DOCKERHUB_CLEANUP_TOKEN` set and proved with a dry run.
      Before step 4, so the merge's own builds have somewhere to push.
- [ ] **3. The `macos-release` environment, with required reviewers.** Before
      the first promotion and therefore before step 9 — but do it here, while
      it is a checklist item rather than a thing remembered at 2am. `GET
      /repos/actana/control/environments` returning `total_count: 0` means it
      does not exist.
- [ ] **4. Merge the effort to `main`.** One pull request, by the process that
      is live today, while `main` still accepts a pull request from a
      non-`beta/*` head. **This is the step that must precede step 6**: after
      `main.json` is applied, this pull request could not be merged.
- [ ] **5. Watch `Train rules` go green on that merge.** Not on an earlier run
      — on the merge that put it on `main`. This is the check `main.json` is
      about to make required, and the one that turns "only a train may target
      `main`" from a sentence in an ADR into something enforced.
- [ ] **6. Apply the rulesets, in the order §3a–§3e gives them.** Trains first,
      release lines second, `main` third, tags last. `beta/*` before `main`
      because step 8 cuts a train into a ruleset that should already exist;
      tags last because that payload's only change is adding the bypass actor,
      and it is cheap to re-apply if the id was wrong.
- [ ] **7. Prove it binds** — [*Verify it actually
      binds*](#verify-it-actually-binds), below. A throwaway non-`beta/*` pull
      request into `main` is blocked, and a direct push to `main` is refused
      **for the repo owner**. Neither is answered by reading the settings page
      back.
- [ ] **8. Cut `beta/0.1.0`** (#115). The first train, and the first thing to
      confirm that a `beta/*` head passes `Conventions` — which can only be
      confirmed against a real train.
- [ ] **9. Promote it.** Work
      [`beta-acceptance-checklist.md`](beta-acceptance-checklist.md) and
      [`core-macos-prerelease-checklist.md`](core-macos-prerelease-checklist.md)
      against `beta-0.1.0`, then dispatch `promote.yml`. **This step publishes**
      — an image push cannot be undone and `:latest` has no history. Everything
      above exists so that the person approving it is approving something real.

Two items are deliberately *not* in this sequence. Creating the
`@actana/maintainers` team (§1) is a prerequisite for flipping
`require_code_owner_review` to `true`, not for the cutover — every payload
ships with it `false` precisely so the team's absence cannot block this. And
`Dependency Audit` is red repository-wide and stays required; it is a known
condition to note before step 9, not a gate to fix first.

### Substituting the App id

Three payloads carry `"actor_id": 0`. Zero is not a valid App id; it is a
tripwire, so a payload applied without substitution fails at the API instead of
installing a ruleset whose bypass actor silently does not resolve. Substitute
it on the way in:

```bash
export APP_ID=…            # the value of the APP_ID secret
apply() {                  # apply <payload> [ruleset-id]
  jq --argjson app "$APP_ID" \
     '(.bypass_actors[]? | select(.actor_id == 0)).actor_id = $app' "$1" \
  | if [ -n "${2:-}" ]
    then gh api --method PUT  "repos/actana/control/rulesets/$2" --input -
    else gh api --method POST "repos/actana/control/rulesets"    --input -
    fi
}
```

### 3a. `beta/*` — the trains

- [ ] `apply docs/rulesets/beta.json`

Restrict deletions, block force pushes, require a pull request, **1 approval**,
**dismiss stale approvals on new commits**, require conversation resolution.

Dismiss-stale is not housekeeping here. It is the human-side guard behind
digest verification: an approval is a statement about a specific tree, and a
further merge into the train makes it a statement about something the approver
never saw. An approval must not survive the thing it approved.

**"Require branches to be up to date" is off**, deliberately, and this is the
one place the setting differs from `main`. Several pull requests are open into
one train at a time. With strict on, merging any one of them invalidates every
other, and each would re-run the full E2E and installer matrix serially before
it could merge again — turning a train into a queue that gets slower the more
people use it. The train is protected by the gates re-running on merge to
`beta/*`, not by everyone rebasing at each other.

**The E2E and installer legs are not required here.** They are required on
`main`, which sees one pull request per release. On the trains, the bar is the
fast set plus both image builds — the same list `main` has minus the slow legs:

`Conventions`, `Train rules`, `Typecheck`, `Unit Tests`, `Lint`, `Secret Scan`,
`Dependency Audit`, `Panel image / Resolve registries`, `Panel image / Build +
smoke (amd64)`, `Core image / Resolve registries`, `Core image / Build + smoke
(amd64)`.

**The GitHub App is the sole bypass actor** (D24, D39). It needs to be, and for
three named operations only: it writes the train-cut commit, it force-pushes
the post-hotfix rebase, and it deletes the promoted train. That is the
documented exception to "no force-push" — one non-human identity, three
operations, all of them in `promote.yml` where they can be read. No human and
no admin role is a bypass actor on this ruleset.

### 3b. `release/*` — the maintenance lines

- [ ] `apply docs/rulesets/release.json`

Same shape as the trains: restrict deletions, block force pushes, require a
pull request, 1 approval, dismiss stale, conversation resolution, same required
checks. No bypass actor — nothing in `promote.yml` force-pushes a release line;
it only creates one, and creation is not restricted here.

> **The forward-fix-first check (D29) is not in this list, because it does not
> exist yet.** D29 wants a required check on `release/*` pull requests
> asserting by patch-id that the fix is already on `main`. `Train rules`
> covers the other half of the release-line rules — D26 and D31's supported-line
> window — but nothing implements the patch-id assertion. Adding a check name
> for a job that does not exist is exactly the failure this section opens with.
> Implement it, watch it green, then add the context to
> [`rulesets/release.json`](rulesets/release.json) and re-apply.

There are no `release/*` branches yet, so this ruleset governs nothing on the
day it is applied. Apply it anyway — it needs to be in place *before* the first
line is cut, not after.

### 3c. Retiring a release line (D27)

A line that has fallen out of the supported window becomes **read-only**: no
pushes, no deletion, no force-push. [`release-retired.json`](rulesets/release-retired.json)
is a template, not a standing ruleset — it names one line explicitly, because a
pattern would need to encode which lines are retired, and that is a list that
goes stale in a way nobody notices until someone pushes to a dead line.

- [ ] On each retirement: copy the payload, replace
      `refs/heads/release/0.0-PLACEHOLDER` with the real ref, rename the
      ruleset to name the line, `apply` it, and commit the copy beside the
      others.

### 3d. `main`

- [ ] `apply docs/rulesets/main.json 20390421`

What changes from the ruleset that is live today:

- **`Train rules` is added to the required checks.** This is the point of the
  ticket. GitHub rulesets cannot restrict which branch a pull request comes
  *from*; the check is the mechanism (D1). Without it, "only a train may target
  `main`" is a sentence in an ADR.
- **"Require branches to be up to date" goes on** (`strict_required_status_checks_policy: true`,
  currently `false`). Free here, where the only pull request into `main` is the
  promotion, and it is a fast-forward by construction.
- **The App becomes a bypass actor.** It performs the fast-forward. Without
  this, `promote.yml` fails as a ruleset violation on every release.
- **Required approvals goes 0 → 1, with dismiss-stale on.** This settles #16's
  open question. The solo-maintainer trade-off that made 0 defensible no longer
  applies: a second person reviews the train's pull requests and approves the
  promotion.
- **Conversation resolution is required.**

The existing required checks are kept exactly as named, all sixteen contexts
listed in [`main.json`](rulesets/main.json) — nothing is dropped or renamed,
including the slow legs, and `Train rules` is the only addition.

> **On the two image checks.** Tickets and ADRs call these `Panel image` and
> `Core image`, and those are the job names — but `panel-image` and
> `core-image` are calls into the reusable `container-image.yml`, so the checks
> GitHub actually records are `Panel image / Resolve registries` and `Panel
> image / Build + smoke (amd64)` (and the same pair for Core). The payload
> carries the recorded names. `Panel image / Publish the multi-arch manifest`
> is deliberately not required: it is skipped on pull requests from forks and
> on runs that do not push.

> **`Dependency Audit` is currently failing** repository-wide, and has been for
> longer than this effort — it is red on #130 and #131. It is already required
> on `main` and stays required; this ticket neither introduces nor fixes it.
> Note it before the first promotion, because it is a required check that is
> currently red.

**"Require review from Code Owners" is off, on every ruleset above.** It is not
an oversight. [`.github/CODEOWNERS`](../.github/CODEOWNERS) routes every path
to `@actana/maintainers`, and **that team does not exist** — verified against
the org: `GET /orgs/actana/teams/maintainers` returns 404. Turning code-owner
review on while the team is missing makes every pull request in the repository
permanently unapprovable, because GitHub assigns the review to nobody and then
waits for nobody to approve. Create the team (§1), then flip
`require_code_owner_review` to `true` in each payload and re-apply. Not before.

**"Require approval of the most recent reviewable push" is also off**, matching
what is live today. Dismiss-stale already covers the concern this ticket names,
and require-last-push-approval interacts badly with a promotion whose last push
is made by the App. Turn it on once the maintainers team exists and there is
reliably more than one human who can approve.

### 3e. The tag ruleset

- [ ] `apply docs/rulesets/tag-release-cut.json 20390424`

Ruleset **20390424** restricts *creation* of `refs/tags/v*` to the admin role
and today has **zero bypass actors**. The App pushes the version tag during
promotion, so it must be added here too, or the promotion fails at the tag
after it has already fast-forwarded `main` — the worst place in the sequence to
stop. This is the only change to that ruleset; the `creation` rule and the ref
pattern are untouched.

Ruleset **20390423** ("Release tags are immutable") is not touched by this
effort.

### Verify it actually binds

Two checks, both of which must be done **after** applying and **before** the
first promotion. Neither can be done from a branch, and neither is satisfied by
reading the settings page back — the settings page is what you already know.

- [ ] **A pull request into `main` from a non-`beta/*` head is actually
      blocked.** Push a throwaway branch, open a pull request against `main`,
      and confirm `Train rules` fails with *"Only a train may target main"* and
      that the merge button is disabled — not merely that a warning appears.
      Close it without merging. This is the assertion that D1 is enforced
      rather than described.
- [ ] **A direct push to `main` is rejected for the repo owner**, not merely
      for a contributor. From an admin clone: `git push origin main` on any
      trivial commit must be refused by the remote. A protection that binds
      contributors and waves through the owner is the failure mode this check
      exists to catch, and it is invisible unless the owner is the one who
      tries it. `current_user_can_bypass` on the ruleset should read `never`.
- [ ] **A promotion pull request (head `beta/*`) passes `Conventions`.** The
      branch-name allowlist has to be live first, so this can only be confirmed
      against a real train — the first one is #115.

### What this means for an agent session

There is no longer a path from a working tree to `main` that does not go
through a pull request, and that includes the repo owner's. An admin cannot
just push: the ruleset binds admins, the App's bypass is scoped to the three
operations `promote.yml` performs, and every other change is a branch and a
pull request. An agent session that finds itself wanting to push to `main` has
mis-modelled the repository, not hit a permissions bug. The train-model half of
this — which branch to cut and where a change belongs — is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

Optional, still: a ruleset on branch **creation** restricting new branch names
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

- A single `git push --tags` would re-import the upstream history into a
  repository that was squashed on purpose. It no longer fires 102 release runs
  as well: [`release.yml`](../.github/workflows/release.yml) has no `push:
  tags` trigger, and a stray `v*` tag now does nothing at all ([ADR
  0023](adr/0023-release-trains-and-digest-promotion.md) D40). That is the
  reason the clause was written the way it was, and it is worth keeping in mind
  when reading the rest of this warning.
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
