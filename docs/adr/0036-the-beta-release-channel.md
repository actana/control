# The beta release channel: a beta installs like a release, and the ref is the channel

> **Status: PROPOSED.** Not accepted. This record **amends** [ADR 0016](0016-the-0-1-0-shape.md)
> at **D28**, **D29**, **D34** and **D35**, and
> [ADR 0023](0023-release-trains-and-digest-promotion.md) at **D8** and **D9**. Both of those
> records are `ACCEPTED` and stay so: they are amended by dated notes appended under the
> clauses named — never superseded, never renumbered, never rewritten. **The repository owner
> ratifies or rejects this record**, and until then nothing in it is settled.

> **On the number.** This record takes **0036**, the next free number: `docs/adr/` runs to
> [`0035-a-second-skill-for-the-sub-agent-role.md`](0035-a-second-skill-for-the-sub-agent-role.md).
> [`README.md`](README.md)'s rule is **append a clause, never shift one** — nothing here is
> renumbered, and the two files claiming 0018 and the two clauses claiming D38 inside 0023
> stay exactly where they are.

> **On citations.** A bare `D<n>` in this file means a clause **of this record**. A clause of
> another record is always written with its ADR — `0023 D5`, `0016 D29` — because this
> record's D5 and 0023's D5 are both load-bearing in the same paragraphs.

> **This record is the revisit ADR 0023 required, not paperwork after the fact.** Two of its
> clauses name the condition that has now occurred, and both name it as a *precondition*:
>
> > **0023 D8** — *"the mismatch is safe **only because betas never become GitHub Releases**
> > (D9): nothing that parses versions ever sees one. If betas ever gain a GitHub Release,
> > this clause must be revisited before that change lands, not after."* — `0023-…:61`
>
> > **0023 D9** — *"Should a beta ever publish a GitHub Release, it must be created with
> > `prerelease: true` **and CI must assert the flag**, because `install.sh` and the
> > in-product update checker both read `/releases/latest`, which excludes prereleases — a
> > single missing flag would make every running Core and Panel advertise an unreleased
> > build."* — `0023-…:65`, as this pull request's second commit leaves it
>
> D8's revisit is §C. D9's assertion is **D11** below, and D9's own sentence is the acceptance
> criterion for `beta-release.yml`.

[#314](https://github.com/actana/control/issues/314) states the shape: a beta train must be
installable the same way a release is. Today it is not, and the reason is a decision rather
than a gap — 0023 D9 decided that betas are Docker-only, and `release.yml`'s `resolve` job
enforces it by refusing any tag reachable from neither `main` nor a `release/*` branch
(`.github/workflows/release.yml:219-231`). A train that is finished and release-ready is
therefore testable only as a container or by building the tarball on the machine that will run
it. Neither is a product.

Reversing that decision is cheap in workflow YAML and expensive in invariants, because a beta
release touches the tag ladder, the asset contract, the workflow inventory, the macOS cost
argument and the npm namespace at once. This record settles those, and it settles the three
questions the task issues are explicitly forbidden from settling in a pull request:
[#317](https://github.com/actana/control/issues/317)'s channel mechanism,
[#320](https://github.com/actana/control/issues/320)'s CLI install path, and
[#321](https://github.com/actana/control/issues/321)'s tarball promotion.

---

## A. The constraints this record writes down and does not weigh

These four come from the repository owner. They are recorded as **constraints**, not as
decisions this record reached: there are no alternatives listed under them, no trade-off is
weighed, and a later reader who wants one changed is asking the owner, not re-reading an
argument. Everything in §B–§F is derived under them.

**C1 — A beta version string is `x.y.z-beta`, exactly, on every surface.** The git tag, the
GitHub Release, every image tag, every asset filename, and anything npm would ever see. There
is **no counter, no dotted numeric suffix, no run number and no short sha** — nothing at all
after the word `beta`. A version string is clean on all three channels: `x.y.z` for a release,
`x.y.z-beta` for a beta, and `main` is the moving latest. **A counted beta string is banned
outright**, and this clause exists so that no ticket in this milestone re-derives it: the
consequence it has, in the one place it lands, is D14 and D15 below.

This constraint binds the *beta* channel only. It does not touch the backport release
candidate 0023 D30 publishes, whose shape carries an identifier by design and is compared
numerically ([#322](https://github.com/actana/control/issues/322)'s second criterion).

**C2 — Install is not activation.** `install.sh` places the Core bundle and the `actana`
launcher and stops. `actana setup` is a separate command the operator runs afterwards, and
the script prints it rather than running it. There is no flag for this; it is what the script
does ([#316](https://github.com/actana/control/issues/316) removes the tail at
`install.sh:347-356`). A beta install path that activated a machine would be a second
behaviour on the same door, which is exactly what a beta must not have.

**C3 — A beta cut is requested by a person and never happens on a merge.** The trigger is a
`workflow_dispatch` on `beta-release.yml` with the train branch as its one input. Merges into
the train keep doing exactly what they do today — the checks, and the moving `beta-x.y.z`
images from `ci.yml`'s train jobs — and publish nothing else. This mirrors 0023 D14's posture
for promotion: the consequential action is a dispatch, because "published by accident" is a
failure mode worth designing out.

**C4 — The URL scheme is the ref.**

The **Installs** column is written in D2's vocabulary rather than in prose, because this
table is a specification #317 builds and the two must not be able to disagree.

| Want | URL | Installs |
| --- | --- | --- |
| the latest release | `raw.githubusercontent.com/actana/control/main/install.sh` | the release of the line `main` is stamped with, which in steady state is the newest release — the one case where it is not is D24 |
| a specific release | `…/actana/control/v0.4.0/install.sh` | that line's release, which at a release tag is that release. A release tag is immutable (D7), so this row is a pin |
| the current beta of a line | `…/actana/control/beta/0.4.1/install.sh` | that line's beta. The train branch is deleted at promotion (0023 D4), so this URL stops existing rather than quietly changing meaning |
| the same beta, by tag | `…/actana/control/v0.4.1-beta/install.sh` | **an alias of the row above, not a pin.** It follows the same line, and once that line has a release it installs the release |

`--version` still overrides, and `--repo` / `--base-url` are untouched.

**There is no ref that pins a beta, and the fourth row does not claim to be one.** Two clauses
of this record make that impossible: the beta tag *moves* per cut (D7), so the ref itself will
not hold still, and the file at that ref carries the **line** rather than the beta (D1), so D2
resolves it exactly as the train branch does. **The pinned form is `--version x.y.z-beta`**,
which the sentence above already permits, which #317 keeps working, and which is the only
thing in this design that pins a beta at all — the beta's own immutable record stays the
commit sha, the image digest and `SHA256SUMS` (D7).

**This table is the constraint**, and it is what forces D1 below: it is the reason routes (b)
and (c) of #314 §4 are not available, rather than being routes this record weighed and
rejected on cost.

---

## B. The channel mechanism

**D1 — The channel is a stamped line version, written by the cut, and it is the only route C4
leaves open.** A script fetched by `curl … | bash` cannot know the URL it came from: there is
no `$0`, no `BASH_SOURCE`, no argv naming a URL — bash is reading a pipe. So "the ref is the
channel" can only mean *the copy of the file on that ref differs*, and that runs straight into
0023 D5: promotion is a fast-forward, so **the train tip's bytes become `main`'s bytes**. A
`CHANNEL=beta` constant committed on a train lands on `main` at promotion and turns the public
one-liner into a beta installer. **Any design that stores the channel in the file is therefore
wrong**, and that is a structural fact rather than a review catch.

What survives a fast-forward is a value that is *true on both sides of it*. The train's own
version is such a value: `beta/0.4.1` is the 0.4.1 line, and after promotion `main` is the
0.4.1 line too. So `install.sh` carries the **line**, written by the cut exactly as the six
manifests are (`.github/workflows/promote.yml:724-756`), and resolves from it.

The two rejected routes are recorded with their reasons, because both will be proposed again:

- **The release asset as the beta door** — `…/releases/download/v0.4.1-beta/install.sh`,
  stamped at publish time. It is unavailable under **C4**: it cannot serve
  `…/control/beta/0.4.1/install.sh` at all, so the constraint's third row has no
  implementation. It is *also* the shape 0016 D29 priced — an installer fixable only by
  cutting a release — narrowed to a beta, where a cut is a dispatch and the price is much
  lower. Had C4 been open, this would have been the cheap route; it is not open.
- **Neither** — `curl …/main/install.sh | bash -s -- --version 0.4.1-beta` already works once
  the beta assets exist (`install.sh:242-263`, `:284-308`). This is true, and it bounds what
  D1 is worth: **the mechanism buys a shorter URL, not a capability.** It is not chosen
  because C4 asks for the shorter URL by name.

> **Amended 2026-08-24 by [#325](https://github.com/actana/control/issues/325): the cut named here is a person, and the line reference is a job that no longer exists.** This clause cites `.github/workflows/promote.yml:724-756` for *"written by the cut exactly as the six manifests are"*, and those lines were inside the automatic `next-train` job, which #325 deleted: cuts are manual, a human names the train branch and cuts it, and no job guesses a version or cuts a train ([ADR 0023](0023-release-trains-and-digest-promotion.md) D3, D22 and D25, each amended the same day). **This clause is unchanged in substance, and §G already said why**: it says *the cut* writes the stamp rather than naming a job, and *"whether the cut is a job that runs after a promotion or a person following a documented procedure, the stamp is written by whatever performs the cut."* The procedure is now [`docs/ci-cd.md` § "Cutting a train"](../ci-cd.md#cutting-a-train), and its manifest list is bound to `ci.yml`'s by a test, exactly as the job's was. So the answer to *where does the line get stamped* is **a manual cut stamps it, and [#317](https://github.com/actana/control/issues/317) implements it** — this record already assigns the installer's diff to #317 (D6), and #317 is what puts the stamp in `install.sh` and adds the separate `Train rules` assertion D4 requires. #325 touches neither `install.sh` nor `ci.yml`'s manifest set; what it leaves behind is a cut procedure that names the stamp among the things a cut has to get right, and a citation that reads correctly once D4's assertion lands beside the six. Until #317 lands there is no stamp in the file and a cut writes six manifests, which is the same number it wrote before this record.

**D2 — The resolution rule is "the release of this line if it exists, else this line's beta",
and it makes no listing call.** In order:

1. an explicit `--version` / `ACTANA_VERSION` wins, unchanged (`install.sh:242-247`, `:31`);
2. the release `v<line>`, if that Release exists;
3. otherwise `v<line>-beta`, if that Release exists;
4. otherwise `/releases/latest` — exactly what the script reads today, kept as the terminal
   fallback.

On a train only the beta tag exists, so step 3 resolves. On `main` after promotion the release
exists, so the same bytes resolve to the release at step 2. At a release tag the stamp is that
tag's own version and step 2 pins it, which is C4's second row working with no extra
machinery. **C4's fourth row is not a fourth behaviour**: the file at a beta tag carries the
line like every other copy, so it takes step 2 or step 3 exactly as the train branch does, and
that is why the table calls it an alias.

**Step 4 is not decoration.** A copy whose line has neither a release nor a beta is a real
state, not a hypothetical: a train from which nobody has yet dispatched a beta cut (C3 makes
that the normal state of a young train), and the failed-release case D3 names. Without step 4
those installs fail outright; with it they get today's answer, which is the correct one when
the line being asked about has published nothing.

The rule is **per line, by construction**. `GET /repos/<repo>/releases` returns every release
newest-first across *all* lines, so "the newest prerelease" would hand a machine installing
one line's beta the beta of another. Under D2 the tag name is fully determined by the stamp,
**no step enumerates releases**, and the steady-state path is one endpoint read — the same
number of calls the stable path makes today.

**What D2 stops depending on, and what that costs.** Today the default install always reads
`/releases/latest` (`install.sh:249`); under D2 it reads that endpoint only at step 4. The two
answers are held equal in steady state by two different mechanisms — the endpoint by 0023
D28's assertion that *a backport never moves `latest`, on either Docker Hub or GitHub*, and
the stamp by the cut plus `ci.yml`'s `Train rules` (D4). **A backport therefore produces no
divergence**: D28 already keeps the endpoint on the current line, and D2 reaches the same
answer without depending on that assertion continuing to hold, which is a small strengthening
rather than a change. There is exactly one state where the two genuinely disagree and D2's
answer is the worse one — a rollback, which flips that flag and does not touch the stamp. It
is not buried here; it is **D24**.

**D3 — The promotion window is a real cost of D1, it is bounded, and it is accepted.**
`promote.yml`'s `advance` job fast-forwards `main` and pushes the version tag *before* the
`release` job runs (`promote.yml:385-387`, `:518-520`), and the GitHub Release is created at
the end of `release.yml`. So between the fast-forward and `github-release` completing, `main`
carries the new line's stamp while that line's Release does not yet exist, so D2 falls past
step 2. **If a beta of that line was ever cut**, step 3 answers and the public one-liner
serves a prerelease for the duration of one release run; if none was, step 4 answers with
today's newest release and there is no window at all. The rest of this clause is about the first
case, which is the one a milestone that exists to publish betas should expect.

This is unavoidable under D1 rather than a bug in it: after the fast-forward, `main`'s bytes
and the train's bytes are *identical* (0023 D5), so no rule expressed in those bytes can
answer differently on the two branches. The tie-break was between serving a prerelease from
the public door for one run, and serving the previous release from the beta door for the same
run. The window is accepted because of what it actually delivers and how it heals:

- the bytes are prerelease bytes **of the line being promoted**, published by a beta cut off
  that same train, and the machine reports `x.y.z-beta` honestly rather than claiming a
  release;
- it self-heals on the next update, once #322 lands: a release is newer than its own beta, so
  the update notice fires and `actana update` moves the machine forward;
- it is reachable only by an install *started* inside the window.

**The bound is one release run only when that run finishes, and the failure case is stated
here rather than left to be met.** `release` is an ordinary job and can go red or be
cancelled. When it does, `main` keeps the new line's stamp and that line still has no Release,
so D2 does not stop at step 2 — and the public door serves that line's beta **for as long as
the failure lasts, not for one run**, if a beta of the line was ever cut, or today's newest
release at step 4 if none was. Nothing self-corrects: the stamp cannot be walked back, because
0023 D5 lets `main` advance only by fast-forward, and `main` is already at the train tip.

**The recovery is the one 0023 D40 already documents: re-dispatch the release.** The tag is
pushed before the release runs, and `release.yml`'s trigger is a `workflow_dispatch` precisely
so a release can be re-run without a new commit and without touching `main` — dispatched **at
the tag**, `gh workflow run release.yml --ref vx.y.z -f tag=vx.y.z`.

> **Corrected 2026-08-25 by the gate review of
> [#342](https://github.com/actana/control/pull/342): there is no `workflow_call` any more.**
> This paragraph described the `workflow_dispatch` as sitting *"beside the `workflow_call`
> `promote.yml` uses"*. That was true when it was written and stopped being true six commits
> later in the same branch: [#326](https://github.com/actana/control/issues/326) deleted the
> `workflow_call` trigger outright, because a local `uses:` resolves the called file from the
> *caller's* SHA — the default branch, never the train — and `promote.yml` now **dispatches**
> `release.yml` at the version tag instead ([0023](0023-release-trains-and-digest-promotion.md)
> D40 as amended). So the dispatch is not one entry point beside another; it is the only one,
> and the line references that pointed at it are gone with the trigger. **The recovery this
> clause names is unchanged and is now the only shape it could have taken.** So a
promotion whose release leg is red is **not a cosmetic failure and must be finished rather
than abandoned** — it is a public door serving a prerelease until someone re-runs it. That is
also the neighbourhood of [#326](https://github.com/actana/control/issues/326), and it is
written down here rather than left inside a link to another ticket.

The only lever that would close the window itself is reordering `release` ahead of `advance`
inside `promote.yml`, which is a change to the promotion sequence 0023 D40 and D16 depend on.
**This record does not order that change**, and a later ticket that wants the window closed is
amending 0023, not implementing this clause.

**D4 — The stamp is asserted separately, and never by extending the manifest set.** `ci.yml`'s
`Train rules` job asserts the six manifests carry the train's version, and its
`assert_manifest_set` deliberately refuses a *shrinking* set: every listed file must exist and
every workspace package under `packages/` must be listed (`ci.yml:249-277`). `install.sh` is
not a workspace package, so adding it to `MANIFESTS` would break the property that check
exists to hold. The stamp therefore gets **its own assertion** in the same job, and the cut
verifies it the way it verifies the manifests (`promote.yml:749-756`). This is stated here
because "just add it to the list" is the obvious edit and it is the wrong one.

**D5 — `install.sh` on `main` stays the canonical door; the Release asset is a copy.** 0016
D29 keeps the installer on `raw.githubusercontent.com/actana/control/main/install.sh` so that
*"a broken installer is fixable without cutting a release"* — quoted verbatim in
`release.yml:79-83`. A beta Release attaches `install.sh` as an asset (D10) so the script and
the bytes it fetches ship together. **That asset is a copy, not a door**: nothing in the
documentation points an operator at it as an install URL, the canonical door stays on `main`
under D29's rule, and the copy is byte-identical to the repository copy at the ref it was cut
from apart from the stamp D1 writes. Recorded explicitly, because without this sentence the
next reader reads D29 as violated.

**D6 — The new noun is a *line*, not a *channel*, and `packages/shared/src/actana-release-channel.ts`
is owned by #322.** That module's `ReleaseChannel` already means *which repository and which
hosts releases are read from* — not stable-versus-beta — and overloading it would make the
two meanings indistinguishable in exactly the code that resolves both. The word for the new
concept is **line**: a line is `x.y.z`, and D2 resolves a line to either its release or its
beta.

Ownership has to be decided here because #317 and #322 are in different waves and on different
feature branches, and a shared module created twice is a merge conflict in the one file both
halves of the resolution live in. **#322 creates; #317 consumes.** The reasons are ordering and
subject: #322 is wave 1 with no dependencies and should land before or with #318, while #317
is wave 2 behind both this record and #316; and the additions are #322's subject anyway —
prerelease-aware comparison and a resolution that does not read `/releases/latest`. #317's diff
is `install.sh`, its tests and the fixture server; it adds nothing to the shared module and
takes what it needs from what #322 put there. The module's own header rule is unchanged and
now has a second reader: *the installer and the CLI must agree, or there are two subtly
different front doors.*

---

## C. The tag ladder and the Release — 0023 D8's revisit

**D7 — There is a fifth published tag class, it is the first git tag in the table, and it
moves.**

| Tag | Where | Published when | Moves |
| --- | --- | --- | --- |
| `v0.4.1-beta` | git, `actana/control` | on a requested beta cut (C3) | **per cut** |
| `0.4.1-beta` | `panel` / `core` | the same cut, retagged from `beta-0.4.1`'s digest | per cut |

0023 D7's table has four published classes plus `latest`, all of them image tags. This is the
fifth, and the clause it collides with is not D7 but **0023 D44** — *"`main`, the `vx.y.z`
tag, and the release branch are the record of what happened and are never rewritten"* —
enforced at `promote.yml:482`:

> ```
> echo "::error title=Tag exists on another commit::$tag already names $existing, not
> $HEAD_SHA. Release tags are immutable and are the record of what shipped (ADR 0023 D44)"
> ```

Nothing breaks mechanically: that check reads `refs/tags/v<version>` for a **release**, and a
beta tag is not that name. But *"version tags in this repository are immutable"* stops being
true as a sentence, and this record says which half survives: **a release tag is immutable; a
beta tag is a handle and moves, exactly as `beta-x.y.z` already does per merge under 0023 D7.**
The immutable record of a beta stays what it has always been — the commit sha, the image
digest, and `SHA256SUMS`. A fixed name (C1) and repeated cuts (C3) cannot both hold any other
way.

> **Conditional as of 2026-08-25, per the gate review of
> [#342](https://github.com/actana/control/pull/342): the handle does not move yet, and this
> clause holds only once one ruleset is changed.** The clause is not withdrawn and its
> argument is untouched — it is what the repository is being configured *towards*. What is
> false today is the "moves" column of the table above, and it is false against configuration
> rather than against code.
>
> Live ruleset **20390423** ("Release tags are immutable") is `active` on `refs/tags/v*` with
> rules `update`, `deletion` and `non_fast_forward` and **no bypass actors**. `v0.4.1-beta`
> matches that pattern. So the *first* cut of a line, which **creates** the ref, passes
> through 20390424's App bypass and works; every *later* cut force-**updates** an existing ref,
> and 20390423 refuses that for every identity, the App included. The `creation` rule the
> record reasons about is 20390424's; `update` is 20390423's, and only 20390423 sees a second
> cut. **`beta-release.yml` is correct and fails cleanly** — the tag move is the first write
> in `publish`, so a refused second cut publishes nothing — but until the ruleset changes, a
> beta line can be cut exactly **once**, and the sentence *"a beta tag is a handle and moves"*
> describes an intent rather than the repository.
>
> The change required is one array entry — excluding `refs/tags/v*-beta` from 20390423's
> conditions — and it is **the repository owner's to make**; #342 makes no ruleset change.
> [`docs/REPO_SETUP.md` §3e-i](../REPO_SETUP.md#3e-i-the-change-ruleset-20390423-needs-and-the-alternative-that-is-wrong)
> records it exactly, together with why the obvious alternative is wrong: adding the App as an
> `update` bypass actor would unblock the beta cut *and* let the App move every release tag,
> because a bypass actor carries no ref condition of its own — which is precisely what
> [0023](0023-release-trains-and-digest-promotion.md) D44 forbids, and what the `promote.yml`
> check quoted above assumes the configuration also forbids. **This note lifts when that
> exclusion is live and a line has been cut twice against the real repository.**

**D8 — The version parsers, each answered by name.** 0023 D8's safety argument was *"nothing
that parses versions ever sees one."* After this milestone several things do:

- `scripts/lib/release-latest.mjs` — **already correct, and no change is needed.**
  `parseReleaseVersion` accepts the beta form, `isPrerelease` returns true for it, and
  `npmDistTag` answers `next` for a prerelease on the main line. Recorded so it is not
  rediscovered by three tickets in turn.
- `release.yml`'s tag regex — **already accepts it**
  (`^v[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$`, `.github/workflows/release.yml:202`).
- `packages/shared/src/semver.ts` — **not correct.** `isNewerSemver` compares only the numeric
  core, so a release is not newer than its own beta: both parse to the same numbers and the
  comparison answers `false`. The machine is therefore **stranded** on the beta, never moved
  backwards by this function, and its update notice never fires for the release of its own
  line — the population most in need of that notice. The downgrade is a **second and separate
  path**: a bare `actana update` resolves `/releases/latest`, which excludes prereleases, and
  the already-current guard compares two unequal strings, so the machine is moved back to the
  newest release and told it was updated. Both are #322, and they are the reason #322 has no
  dependency on this record beyond the version shape in C1.

**D9 — `beta-release.yml` is a separate workflow, not a third mode of `release.yml`.**
`release.yml` already has two modes decided by the branch graph — promote and backport — and
its `resolve` job rejects any tag reachable from neither `main` nor a `release/*` branch
(`release.yml:219-231`). A beta tag is on a train and is reachable from neither, so making the
beta a third mode means loosening the one guard that makes the other two modes readable off
facts rather than off a flag. A separate entry point costs one file and keeps that guard
intact. **This is written down because "add a third mode to `release.yml`" is the obvious
refactor a later reader will propose**, and it is a refactor this record refuses.

**D10 — What a beta cut publishes.** A prerelease GitHub Release on the moving `v<line>-beta`
tag, never `latest`, with its assets clobbered in place on each cut:

| Artifact | Value |
| --- | --- |
| Core tarballs | `linux-x64`, `linux-arm64`, `mac-arm64` — the same three targets a release builds |
| `SHA256SUMS` | over exactly those three |
| `install.sh` | attached as a copy (D5) |
| CLI | packed and attached as a tarball asset (D15) |
| Images | `x.y.z-beta`, retagged from the train's `beta-x.y.z` digest — nothing rebuilt |

**There is no Intel Mac build, and nothing is being omitted:** there has been no `mac-x64`
target since 0016 D28 as amended, `CORE_TARGETS` carries one darwin row, and `install.sh`
refuses an Intel Mac at detection (`install.sh:199-204`). The row does not exist for a release
either. The target name is `mac-arm64` and not `darwin-arm64`: `darwin` is the `platform`
field inside the manifest, never the target name, and 0016 D29 makes the asset name part of a
contract a rename breaks.

**D11 — `prerelease: true`, and CI asserts the flag. This is 0023 D9's own sentence, kept.**
The beta Release is created with the flag, and `beta-release.yml` reads the created Release
back and fails the run if the flag is not set. The reason is D9's and is not restated more
briefly here: `install.sh` and the in-product update checker both read `/releases/latest`,
which excludes prereleases, so **a single missing flag would make every running Core and Panel
advertise an unreleased build.** D9 required an assertion rather than an argument, and this
clause is where the requirement is carried into the new workflow — the acceptance criterion
for [#318](https://github.com/actana/control/issues/318) is D9's sentence, quoted.

**D12 — Images are retagged from the train's verified digest, never rebuilt.** `docker buildx
imagetools create` from the digest `beta-x.y.z` names, exactly as 0023 D17 does for a
promotion. A beta that rebuilt would break the one property the train model exists to buy: the
bytes a human tested are the bytes that are published.

**D13 — The beta cut spends macOS minutes on a more frequent trigger than a release, and this
record owns that rather than letting a test's silence stand in for it.** 0016 D35 took macOS
off every trigger except the release, and the cost argument was about *per-PR* CI, where three
macOS legs were 72% of the bill. `scripts/__tests__/workflows.test.mjs:206-209` bans macOS
runners in `ci.yml`, `housekeeping.yml` and `container-image.yml` only, so a macOS leg in
`beta-release.yml` is legal without touching that test. Legal is not the same as decided: a
beta cut is dispatched by a person (C3) and is expected to run several times per train, so the
`macos-15` leg for `mac-arm64` is a real, recurring spend that D35 did not price. It is
accepted because a beta without a macOS tarball is not *"installable the same way a release
is"* on the one platform where the Core is an on-device product, and because C3 keeps the
frequency under a human's control rather than a merge's.

**D14 — The beta gates are lighter than a release's, and red publishes nothing.** The train
already typechecks, unit-tests, lints, audits, builds and boot-smokes both Linux tarballs,
composes `SHA256SUMS` and runs the installer e2e on Ubuntu and Debian at x64. The beta cut
reuses that and adds only the `mac-arm64` tarball leg and one installer e2e on Ubuntu x64.
There is no macOS install e2e, which is unchanged: there never was one (0016 D35).

---

## D. npm — the one place C1 costs something

**D15 — The npm registry is not a beta surface, and the asymmetry is a property of npm rather
than an oversight here.** Every other surface takes a fixed moving string without complaint: a
git tag can be force-updated, a Docker tag is a pointer and `beta-x.y.z` already moves per
merge (0023 D7), and a Release asset is clobbered in place. The registry is the exception, and
this repository already has the property written down in the file that exists because of it:

> An npm version number is burned by its first publish and cannot be reused — unpublishing
> inside the 72-hour window frees the bytes and not the name.

`scripts/rehearse-npm-publish.mjs:11-14`.

Under C1 a beta version string is fixed for the life of the line, so `@actana/cli` at that
version could be published **exactly once per train**. The second cut of the same beta — and a
beta is *designed* to be cut repeatedly as the train moves (C3, D7) — fails at the registry
with a 403, after the git tag has already moved and every asset has already been replaced. A
publish path that works once and then breaks the workflow that calls it is not a path.
**The registry publish is therefore dropped**, as a consequence of C1 rather than as the
outcome of a comparison.

Nothing is published to registry.npmjs.org by a beta cut, under any dist-tag. `latest` and
`next` on `@actana/cli` and `@actana/sdk` are untouched by a beta, and `release.yml`'s `npm`
job is not modified: a promotion still publishes both packages to the registry with
`--provenance` and the attestation read-back, exactly as today.

**D16 — The CLI ships as a packed tarball attached to the beta prerelease, installed from an
asset URL. This is the operator's decision and it is not reopened.** `pnpm pack` produces the
CLI tarball; it is attached to the Release like the Core tarballs and installed with
`npm i -g <asset-url>`. npm installs a tarball URL exactly as it installs a registry spec.
The registry's version namespace is never touched, so the fixed moving string costs nothing on
this surface either — the asset is clobbered on each cut like every other asset.

The alternative — no npm on the beta path at all — would leave the CLI-only surface with no
beta. That surface is a machine that **drives Cores it does not host**: no daemon, no service
unit, no Core on the box. It is exactly as real for a beta as for a release, which is why the
route above is the one this milestone is written toward.
[#320](https://github.com/actana/control/issues/320) implements it and does not re-decide it.

What the route has to solve, named here so it is not discovered late: `@actana/cli` declares
`"@actana/sdk": "workspace:*"`, pnpm resolves that to a real version at pack time, and
`scripts/lib/npm-packages.mjs`'s `assertPackedManifest` requires the range to equal the packed
version exactly — a version that under D15 is not on the registry and never will be. The fact
that makes it tractable is that **the SDK is inlined into the CLI bundle already**:
`packages/cli/build.mjs` marks only `ws`, `undici` and `selfsigned` as `external`, so the
dependency is paperwork at runtime. #320 picks how the packed manifest is made honest; this
record bounds the choice rather than making it, because the shape of the fix is a packaging
detail and the constraints are not:

- nothing produces a version string other than the beta form C1 fixes;
- the **release** path's assertion is unchanged byte-for-byte — it exists to stop *"a CLI
  pinned to another train's SDK"*, which is a real failure and must keep failing for a
  release;
- whatever is loosened is loosened for the beta case only.

**D17 — The beta path has no provenance attestation, and `SHA256SUMS` is what stands in its
place.** `--provenance` is a registry artifact. An asset has none, so the read-back check
`release.yml` performs on a publish — the one that catches an attestation silently lost — has
nothing to read on this path. This is a real loss and it is recorded rather than left
unremarked: the operator-facing instructions [#323](https://github.com/actana/control/issues/323)
writes **must not imply an attestation that is not there**, and the integrity story for a beta
is the published checksums, exactly as it is for a release (0016 D28, `docs/ci-cd.md`
§*Integrity is published checksums, not signatures*).

---

## E. Tarball promotion — what #314 §6 becomes

**D18 — The digest guarantee is about images, it does not extend to tarballs, and the tarball
half of promotion is dropped.** The intent was to extend 0023 D16 and D17 to tarballs once
they exist before the release does: promote the beta's tarballs and their checksums rather
than rebuilding them. **It cannot work, and the reason is in the artifact rather than in the
workflow.** A container digest is version-neutral; a Core tarball is not. The version is in
the asset name, in the root directory inside the archive, and in the `core-manifest.json` the
CLI reads back:

> ```js
> export function tarballName(version, target)        { return `actana-core-${version}-${target}.tar.gz`; }
> export function tarballRootDirName(version, target) { return `actana-core-${version}-${target}`; }
> ```
> `scripts/lib/core-tarball.mjs:228-234`

and `buildManifest` writes the same string into the manifest. Both consumers read it back:
`install.sh:331` looks for `actana-core-$VERSION-$TARGET/` after extracting and refuses the
download if `bin/actana` is not under that exact path, and `runActanaSetup` refuses a tree
whose manifest disagrees with the machine and installs into `versions/<manifest.version>`.
Bytes built as a beta say beta all the way down. Attaching them to a release under a release
name produces a release whose own one-liner cannot extract it; leaving them under the beta
name produces a release with no asset at the name `install.sh` asks for. **There is no rename
that makes those bytes a release tarball** — which is precisely the property that makes the
image promotion honest and this one impossible.

A second, independent obstacle stands even if the first were solved: a beta is cut at whatever
train tip the operator asked for, and the promotion happens at the tip that eventually merges.
The image path handles that by *asserting* the digest's revision label equals the promoted
commit and refusing otherwise (0023 D16, `container-image.yml:365-381`); the equivalent
assertion for tarballs would fail on every beta cut that is not the train's last commit, which
is most of them.

**So `release.yml` is unchanged**: it keeps building `linux-x64`, `linux-arm64` and
`mac-arm64` at the promoted version, and `SHA256SUMS` keeps covering exactly those three (0016
D28 as amended). 0023's byte-honesty claim stays scoped to images, and `docs/ci-cd.md`
§*The digest guarantee: where it starts, and where it stops* gains a sentence saying why it
cannot extend — a tarball self-identifies, a digest does not (#323, #321).

**D19 — Making the artifact version-neutral is refused once, with its price attached.** The
route exists: take the version out of the asset name, the root directory and the manifest, and
carry it beside the artifact instead. It is a change to the **installer contract**, which 0016
D29 names and prices verbatim — the `SHA256SUMS` asset name, the
`actana-core-<version>-<target>.tar.gz` asset name, and `bin/actana` inside the extracted
directory — *"changing any of them is a breaking change to the installer contract requiring a
major bump plus a documented migration."* That is a major-version change with a migration, in
exchange for a wall-clock saving on the release run. **It is the wrong trade at 0.4.1** and it
is written here so that *"we could just rename the assets"* is refused once rather than
proposed again.

**D20 — Beta assets and release assets are never confusable.** Under D18 they carry different
names, different archive roots and different manifests, so an operator who downloads a beta
tarball cannot end up with a machine reporting a release version. This is a property of the
decision rather than a check that has to be written, and it is the reason D18 costs nothing in
safety.

---

## F. What this record does not change

**D21 — The branching invariants are untouched.** Work still reaches `main` only through a
train (0023 D1). Promotion is still a fast-forward (0023 D5) — D1 of this record is *derived*
from that clause rather than straining it. Exactly one train is open at a time (0023 D2). The
human pause stays at the head of `promote.yml` (0023 D15), and no change here adds a second
pause or moves that one. **A beta release is a publish from the train, not a second route to
`main`**, and no beta tag is ever an input to a promotion.

**D22 — 0016 and 0023 keep their status and their numbering.** Both are `ACCEPTED` and stay
so. They are amended by dated notes appended under the clauses named in §G — never
superseded, never renumbered, and no existing D-number in either file moves. The notes are
appended, so a later amendment appends beside them rather than editing them.

**D23 — Nothing sweeps the two new tag classes. They persist once the line promotes, and 0023
D45's credential does not grow to reach them.** The `vx.y.z-beta` git tag and its prerelease
Release stay after promotion, and so do the `x.y.z-beta` image tags D10 puts in `panel` and
`core`. Neither is removed by anything, and that is a decision rather than an omission.

For the git tag and the Release the reason is 0023 D44's principle — the record of what
happened is not rewritten — plus a live use: the beta Release is the only place a beta's
tarballs, its `SHA256SUMS`, its `install.sh` copy and its CLI asset exist, and a machine
installed from a beta may still need to fetch them. Deleting it would break C4's fourth row
and every `--version x.y.z-beta` pin at once.

For the image tags the reason is a refusal that already exists and that this record does not
reopen. 0023 D45 records that **Docker Hub has no tag garbage collection and no undelete**,
and its weekly sweep covers `pr-*` and `sha-*` in the `-dev` repositories only. 0023 D36 and
D38 (*the delete-capable credential*) keep that credential permanently out of the repositories
holding `latest` — which is exactly where D10 puts `x.y.z-beta`. Sweeping a beta image tag
would mean widening its reach, and D38's own words are *"do not revisit by widening the
list."* **So they persist.**

**The accumulation is bounded at one per line rather than one per cut**, and that is the
moving tag (D7) paying for itself: however many times a line is cut, it has exactly one git
tag, one prerelease Release and one `x.y.z-beta` image tag. The cost is that `actana/panel`
and `actana/core` carry one extra tag per line beside the `x.y.z` they already carry — at
worst a doubling of a list 0023 D36's `descriptions` argument wants presentable. That is worth
one clause and is not worth a credential. **#318 and #319 do not have to invent this**, which
is why it is here.

**D24 — 0023 D44's rollback does not reach a `main` one-liner, and the hotfix train is what
does.** Rollback re-points `latest` and flips the GitHub Release's latest flag, *"nothing
else"* — by that clause's own design it does not rewrite `main`. D2 resolves from the stamp on
`main` and not from that flag, so a fresh `curl …/main/install.sh | bash` **keeps installing
the rolled-back release** while every Docker pull and the in-product update checker have
already moved off it. This is the one state where D2 and `/releases/latest` genuinely
disagree, and D2 has the worse answer. It is a real regression against today's script, which
follows the flip immediately, and it is recorded here rather than found during an incident.

It is accepted because the recovery is the one 0023 D44 already names in its own next
sentence: *"the fix goes forward through a hotfix train"* (0023 D22). A hotfix train is cut
from `main`, promoted, and **re-stamps `main` in the same fast-forward** — after which the
one-liner follows with no further action and no new mechanism. The cost is the interval
between the flag flip and that promotion, during which a *new metal install* gets the
rolled-back version while every existing one is already being told to move. **The metal
install path's rollback is therefore the hotfix train, not the flag flip**, and the rollback
runbook 0023 D44 points at must say so ([#323](https://github.com/actana/control/issues/323)).

Two smaller things follow and are stated so they are not read as gaps. A rollback does **not**
need the beta Release deleted: D23 keeps it, and it is a prerelease, so `/releases/latest`
never answers it. And an operator who needs the good version on metal *now*, before the
hotfix, has `--version x.y.z`, which C4's note and D2's step 1 both keep working.

---

## G. The amendments this record carries, and the space left for the ones it does not

Six clauses gain a dated note. Each note is appended under its clause, states what has
occurred, says which half of the clause survives, and points here.

| Record | Clause | Why it is amended |
| --- | --- | --- |
| 0023 | **D8** | Its safety argument was *"nothing that parses versions ever sees one"*, and things now do. The revisit it demanded is §C; the answers are D8 of this record. |
| 0023 | **D9** | Betas stop being Docker-only. Its `prerelease: true` requirement and its CI assertion are **kept in force** as D11. |
| 0016 | **D28** | A beta Release publishes a larger asset set than the release's four (D10). The clause's guard — a count that makes a missing architecture a red build — is untouched for a release. |
| 0016 | **D29** | `install.sh` becomes a beta Release asset. The canonical door stays on `main` and the asset is a copy (D5); the installer contract the clause prices is unchanged. |
| 0016 | **D34** | `beta-release.yml` is a sixth entry point, and `scripts/__tests__/workflows.test.mjs:71-79` fails on its first commit until the inventory is extended. |
| 0016 | **D35** | The macOS cost argument is spent on a more frequent trigger (D13). Zero macOS in per-PR CI still stands. |

**The structure is deliberately left open for two amendments this record does not make.**
[#325](https://github.com/actana/control/issues/325) deletes the automatic train cut, which
amends 0023 **D25** and moves where a train's version comes from.
[#327](https://github.com/actana/control/issues/327) rewrites version handling across trains,
tags, manifests and images, which reaches 0023 **D3** and **D7**'s count among others. Neither
clause is touched here, neither is renumbered, and nothing in this record rewrites prose they
will need to amend.

**D1 in particular is written to survive #325.** It says *the cut* writes the stamp — not
*`promote.yml`'s `next-train` job*. Whether the cut is a job that runs after a promotion or a
person following a documented procedure, the stamp is written by whatever performs the cut and
is asserted on the train by `Train rules` (D4) either way. #325 changes who cuts; it does not
change what a cut writes.

> **Noted 2026-08-24: #325 has landed, and the paragraph above held.** The cut is a person
> following [`docs/ci-cd.md` § "Cutting a train"](../ci-cd.md#cutting-a-train); D1 carries a
> dated note saying so and saying that a manual cut stamps the line, with #317 implementing it;
> 0023 D3, D22, D25 and D39 carry theirs. No clause of this record was rewritten or renumbered,
> and the amendment #327 will need is still open.

---

## Consequences

**A beta is installable on metal, and that is the whole point.** `install.sh` from a train's
ref installs that train's current beta; the same script from `main` installs the release of
the line `main` carries, which in steady state is the newest release; a release tag installs
itself. The CLI-only surface has a beta too (D16). None of it activates anything (C2).

**Two of the three doors are pins and one is not.** A release tag pins (D7, D2 step 2); a beta
ref does not and cannot, because the tag moves and the file carries the line — the pinned form
for a beta is `--version x.y.z-beta` (C4, D2 step 1).

**Rollback stops reaching the metal door, and the hotfix train is what reaches it.** D24
carries the argument and the recovery. This is the second edge a reviewer should push on,
beside D3.

**Nothing sweeps a beta tag, in git or on Docker Hub.** One git tag, one prerelease Release
and one `x.y.z-beta` image tag accumulate **per line**, not per cut, and the alternative is
widening a credential 0023 D38 refuses to widen (D23).

**The public one-liner serves a prerelease for the length of one release run, once per
release — and for longer than that if the release run goes red.** D3 carries the argument, the failed-run case and the re-dispatch that clears it. It is the
sharpest edge in this record and it is the first of the two a reviewer should push on before
ratifying.

**The workflow inventory grows to six entry points, and one test fails until it is extended.**
`scripts/__tests__/workflows.test.mjs:71-79` asserts the directory is exactly six files —
*"five entry points plus one reusable workflow — nothing else"*. #318's first commit makes that
false and must extend it in the same commit.

**"Version tags in this repository are immutable" is no longer true as a sentence.** D7 says
which half survives. Anyone summarising 0023 D44 after this record must say *release* tags.

**The npm registry keeps exactly the shape it has today.** No new version is burned, no
dist-tag moves, and the beta is invisible to `registry.npmjs.org`. What that costs is the
provenance attestation on the beta path (D17), and the operator-facing docs must not paper
over it.

**Three tickets are unblocked by a decision rather than by a record**: #317 has its mechanism
(D1–D6), #320 has its route (D16), and #321 has its answer (D18–D20). Two of those decisions
close doors — the registry publish and the version-neutral tarball — and both are closed with
their prices written down so they are not reopened by a later reader who only sees the cost of
the shape that was kept.

**What this record gates.** Every other issue in milestone 0.4.1 reads a clause here.

| Issue | Reads |
| --- | --- |
| [#316](https://github.com/actana/control/issues/316) — install stops activating | C2 |
| [#317](https://github.com/actana/control/issues/317) — the installer's channel | C4, D1–D6 |
| [#318](https://github.com/actana/control/issues/318) — `beta-release.yml` | C1, C3, D7, D9, D10, D11, D13, D14, D23 |
| [#319](https://github.com/actana/control/issues/319) — beta image retag | D12, D23 |
| [#320](https://github.com/actana/control/issues/320) — the CLI-only beta path | D15, D16, D17 |
| [#321](https://github.com/actana/control/issues/321) — tarball promotion | D18, D19, D20 |
| [#322](https://github.com/actana/control/issues/322) — `actana update` and the beta | C1, D6, D8 |
| [#323](https://github.com/actana/control/issues/323) — the operator-facing docs | all of it; rewrites `docs/ci-cd.md:325-333`, and D24 for the rollback runbook |
| [#325](https://github.com/actana/control/issues/325) — delete the automatic cut | D1's wording, and §G's open structure |
| [#326](https://github.com/actana/control/issues/326) — stale release workflow | D3, including its failed-release case and the re-dispatch recovery |
| [#327](https://github.com/actana/control/issues/327) — version handling | C1, D7, and §G's open structure |
