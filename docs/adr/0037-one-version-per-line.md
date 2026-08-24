# One version per line: where a version string is written, and what is authoritative

> **Status: PROPOSED.** Not accepted. This record **amends**
> [ADR 0023](0023-release-trains-and-digest-promotion.md) at **D3** and **D7**,
> the two clauses [ADR 0036](0036-the-beta-release-channel.md) §G left open for
> it. Both records are `ACCEPTED` and stay so: they are amended by dated notes
> appended under the clauses named — never superseded, never renumbered, never
> rewritten. **The repository owner ratifies or rejects this record**, and
> until then nothing in it is settled.

> **On the number.** This record takes **0037**, the next free number:
> `docs/adr/` runs to
> [`0036-the-beta-release-channel.md`](0036-the-beta-release-channel.md).
> [`README.md`](README.md)'s rule is **append a clause, never shift one** —
> nothing here is renumbered, and the two files claiming 0018 and the two
> clauses claiming D38 inside 0023 stay exactly where they are.

> **On citations.** A bare `D<n>` in this file means a clause **of this
> record**. A clause of another record is always written with its ADR —
> `0023 D3`, `0036 C1` — because this record's D1 and 0036's D1 are both
> load-bearing in the same paragraphs.

[#327](https://github.com/actana/control/issues/327) states the problem and
forbids solving it in the issue: *"a version in this repository is not one fact
with several representations. It is six independent strings that happen to be
equal, kept equal by a check that runs on some events and not others, and
asserted against each other in only one place."* This record is the scheme that
issue would not propose, and the checks it names are the ones that ticket
landed.

The record already disagreed with the code about the most basic count. 0023 D3
says *"all four manifests"* and there are six; 0023 D7 is headed *"Four
published tag classes"* over a five-row table. Neither is the bug. Both are
symptoms of a scheme nobody could hold in their head, and §D is where they are
corrected.

---

## A. What was actually wrong

**Five of the six writers derived their string from a name, and the one check
that read actual content ran last, after the irreversible publishes.**

That sentence is the whole diagnosis and it is worth unpacking once, because
every clause below is a consequence of it. A comparison between two strings
that were both computed from a third is a tautology: it cannot fail, and it
cannot detect the thing it looks like it is detecting.

- `beta-x.y.z` came off the branch name and read no manifest, so a train whose
  six manifests all said `9.9.9` published `actana/core:beta-0.4.1` green.
- `RELEASE_VERSION` came off the tag name, so `v9.9.9` pushed onto any commit
  reachable from `main` resolved, named its tarballs `9.9.9`, and published
  both images.
- the tarball's asset name, its archive root and its `core-manifest.json` all
  came off `RELEASE_VERSION`, so all three agreed with each other by
  construction and with the manifests by coincidence.
- the digest verification compared a **commit**, and was silent about what the
  manifests inside those bytes said.
- `Train rules` did read content — and carried
  `if: github.event_name == 'pull_request'`, so **the cut commit, the one
  commit whose entire purpose is writing six versions, was never asserted by
  it.** `beta/0.4.1`'s cut and `beta/0.4.0`'s were verified by hand and by
  nothing else.
- `scripts/lib/npm-packages.mjs`'s packed-manifest comparison was the single
  place in the repository that compared a version against a *different*
  representation of itself, and it was the last thing in the pipeline to run.

---

## B. The scheme

**D1 — A line is the unit, the manifests carry it, and every published string
is that line or a publication of it.** A line is `x.y.z`. It is what the six
manifests carry, what the train branch is named for, what `install.sh` is
stamped with, and what an image's `org.opencontainers.image.version` says. A
line resolves to its **release** (`x.y.z`), its **beta** (`x.y.z-beta`, 0036
C1) or its **backport candidate** (`x.y.z-rc.N`, 0023 D30).

**The manifests inside a beta's bytes say `0.4.1`, not `0.4.1-beta`**, and that
is not an oversight to be tidied later. The cut stamps the line (0036 D1), a
beta is a publish *from* the train rather than a second stamp, and the beta tag
moves per cut (0036 D7) while the manifests do not. It is also what makes one
comparison cover every surface: `lineOf` is the function each string goes
through, so a train, a release tag and a beta tag are checked against exactly
the same six numbers.

**D2 — The catalogue, and what is authoritative for each row.** #327's
acceptance criteria ask for this to live somewhere durable and to name the
authority for every row. It is here, and it is also **data**, in
`scripts/lib/version-agreement.mjs`'s `SURFACES` — because a table in a
document and a table in a module drift, and
`scripts/__tests__/version-agreement.test.mjs` fails when a row exists in one
and not the other.

| `id` | Where the string is written | Written by | Authoritative source |
| --- | --- | --- | --- |
| `manifests` | the six `package.json` manifests | the cut, [`docs/ci-cd.md` § "Cutting a train"](../ci-cd.md#cutting-a-train) | **the tree.** This is the root of the chain: everything below is checked against it |
| `train-branch` | the train branch name `beta/x.y.z` | a person, at the cut | the tree, asserted on `pull_request` by `Train rules` and on `push` by `Train versions` |
| `installer-stamp` | `install.sh`'s `LINE` stamp | the cut | the tree, asserted by `assert_installer_stamp` (0036 D4) |
| `git-tag` | `vx.y.z`, and `vx.y.z-beta` | `promote.yml`'s `advance`, and a beta cut | the tree at the commit the tag names, asserted in both resolvers before anything is published |
| `train-image-tag` | the image tag `beta-x.y.z` | `ci.yml`'s `train-tags` | the tree, because `train-tags` needs `Train versions` |
| `release-image-tag` | the image tags `x.y.z`, `x.y.z-beta`, `latest` | `release.yml`, `container-image.yml`, a beta retag | the digest's own version label, asserted before the retag |
| `image-version-label` | `org.opencontainers.image.version` | `container-image.yml`, from the checkout | the tree the bytes were built from |
| `npm-version` | the npm versions of `@actana/sdk` and `@actana/cli` | `release.yml`'s `npm` | the packed manifest, at `scripts/lib/npm-packages.mjs` |
| `tarball` | asset filenames, the archive root and `core-manifest.json` | `scripts/lib/core-tarball.mjs`, from `RELEASE_VERSION` | **derived**, and the one row that stays so — see D6 |

**Today four different things were authoritative depending on which job was
asking.** Under this record the answer is one sentence: **the tree is
authoritative, and every other row is either checked against it or explicitly
recorded as derived.**

**D3 — One checker, called by every writer before it writes.**
`scripts/assert-version-agreement.mjs`, over
`scripts/lib/version-agreement.mjs`. It compares a surface's own string against
the content of the tree that string claims to describe, and it is called from:

| Caller | When | What it holds against the tree |
| --- | --- | --- |
| `ci.yml`'s `Train versions` | every push to `beta/**`, the cut included | the branch name, and the installer stamp |
| `ci.yml`'s `Train rules` | every pull request into or out of a train | the same, in the job the rulesets pin |
| `promote.yml`'s `resolve` | before the pause's downstream work, before the fast-forward | the version, at the head of the promotion pull request |
| `release.yml`'s `resolve` | before a tarball is built or an image moves | the tag, at the commit it names |
| `container-image.yml`'s `build` | before either image is built | the caller's version, and the label it stamps |
| a beta cut ([#318](https://github.com/actana/control/issues/318)) | before the beta tag moves | `--expected vx.y.z-beta`, and nothing new is needed |

It imports nothing outside `node:` builtins, deliberately: the check that gates
every version-bearing job must not be capable of being held up by a registry.

**D4 — An image says what version it is, and no tag is re-pointed at a digest
that disagrees.** `org.opencontainers.image.version` carries the **line**, read
from the checkout's manifests at build time. One label covers all four
version-bearing tags, because `beta-x.y.z` from a train, `x.y.z` and `latest`
from a promotion and `x.y.z-beta` from a beta retag are the same bytes carrying
the same line.

**The two answers the images gave before this record are both live and both
wrong, differently.** The Core images inherited
`org.opencontainers.image.version=24.04` from `ubuntu:24.04` through `FROM` —
the Ubuntu base's own version, presented as the image's. The Panel images
carried no version label at all. An image built before the label existed is
therefore **refused** rather than tolerated, with the remedy named on screen:
re-run the train's image jobs. A check that waves through the exact state it
was written to catch is not a check, and the cost of the strict reading is one
re-run of a job that already runs on every merge.

**D5 — The npm assertion keeps its place, and this is why that is now
acceptable.** #327's fourth criterion asks that
`scripts/lib/npm-packages.mjs`'s comparison *"either stops being the last thing
to run, or the record says why it is acceptable that it is"*. It is still last,
and it is acceptable because **it is no longer the only content check, nor the
first**. `release.yml`'s `resolve` now makes the same comparison against the
tree at the tag before a single tarball is built, so the failure that used to
be discovered after both image publishes is discovered before any of them.

What is left at the end is the one thing only a publish can check: the version
inside a **packed** artifact, which is a representation none of the earlier
checks can see — `pnpm pack` applies `publishConfig` and resolves
`workspace:*`, and its output is not the file on disk. That is a genuinely
different question, it belongs where it is, and it is now defence in depth
rather than the only defence.

**D6 — The tarball row stays derived, and that is 0036 D19's refusal, not a gap
this record leaves open.** The version is in the asset name, in the archive
root and in `core-manifest.json`, all from `RELEASE_VERSION` off the tag. 0036
D18 records why that cannot be promoted like a digest — *"a tarball
self-identifies, a digest does not"* — and 0036 D19 refuses making the artifact
version-neutral once, with its price attached: it is a change to the installer
contract 0016 D29 prices, *"a major bump plus a documented migration"*.

So this row is **recorded as accepted with a reason**, which is what #327's
third criterion asks for where a gap is not closed. What makes it safe is D3's
first caller rather than anything in the artifact: `RELEASE_VERSION` is
`resolve`'s `version`, and `resolve` now asserts that string against the tree
before the tarball job starts. The three strings inside the tarball still agree
with each other by construction; what changed is that the string they all come
from has been read against the manifests before any of them exists.
`scripts/lib/core-tarball.mjs` and the shape of `core-manifest.json` belong to
[#321](https://github.com/actana/control/issues/321) and are untouched here.

**D7 — A counted beta is refused by name, wherever a version string is
validated.** 0036 C1 fixes `x.y.z-beta` with *"no counter, no dotted numeric
suffix, no run number and no short sha"*. `0.4.1-beta.1` is what every semver
habit produces, it parses cleanly in every library, and `release.yml`'s tag
regex accepts it — so refusing it has to be a check rather than a convention,
and the refusal has to name the shape rather than say "invalid version".

**The constraint binds the beta channel only.** `x.y.z-rc.N` is the backport
release candidate 0023 D30 publishes, its shape carries an identifier by
design, and it is accepted unchanged. A rule that banned both would make the
supported-line path unreleasable, which is why the counted-beta test is checked
*before* the general prerelease test rather than after it.

**D8 — Writers 8 and 9 add no unchecked surfaces, and this is what #314 §3
asked for.** The beta channel adds the moving `vx.y.z-beta` git tag and the
`x.y.z-beta` image tag. Neither needs new comparison logic: the manifests carry
the line, so `--expected vx.y.z-beta` is the same call `--expected v0.4.1`
makes, and the image tag's line is checked against the same label. **#318 and
#319 inherit the checks rather than having to write them**, which is the
property #327's sixth criterion asks for — *"must not add two more unchecked
ones"*.

---

## C. The gaps #327 lists, each answered

Each row is one of the issue's *"which of these can pass while the versions
disagree"* items, in its order.

| # | The gap | Closed by | Or accepted because |
| --- | --- | --- | --- |
| 1 | `Train rules` never runs on a push to a train | `Train versions`, on `push: beta/**` (D3) | — |
| 2 | the `beta-x.y.z` image tag asserts nothing about the tree | `train-tags` needs `Train versions`, and the image is labelled from the tree (D3, D4) | — |
| 3 | the digest verification asserts a commit, never a version | the version label, asserted in `promote.yml`'s `verify` and in `container-image.yml`'s promote and verify modes (D4) | — |
| 4 | `release.yml`'s `resolve` proves reachability, not agreement | the tag asserted against the tree at the commit it names, in `resolve` (D3) | — |
| 5 | the tarball's three strings agree by construction and with the manifests by coincidence | the string they derive from is asserted first (D3) | the artifact stays version-bearing: 0036 D18, D19, and D6 above |
| 6 | nothing asserts the git tag against the six manifests | both resolvers, before anything irreversible (D3) | — |

**The conditional link is no longer conditional.** The chain was manifests →
branch name (pull requests only) → tag → images and tarballs, with the first
link the one that did not always run. It now runs on both events, and three
further links have been added where there were none.

---

## D. The counts 0023 got wrong, corrected

**D9 — 0023 D3 is six manifests, not four, and the number is not the
invariant.** The clause says *"all four manifests — root, `packages/core`,
`packages/panel`, `packages/shared`"*. `packages/sdk` was added by #152 and
`packages/cli` by #157, and both amended the clause; the headline sentence was
not rewritten, because that record's rule is to append rather than edit. It
gains a dated note saying six.

**What the note also says is the part worth keeping**: #152's amendment already
made the count *derived rather than declared* — `assert_manifest_set` refuses a
shrinking set before any version is compared — so the number in the prose is
documentation and the assertion is the mechanism. This record does not change
that. It adds a third holder of the set, in
`scripts/lib/version-agreement.mjs`, and binds it to the other two by test:
`ci.yml`'s `MANIFESTS`, `docs/ci-cd.md`'s `files=()`, and the module's
`MANIFESTS` are one set held in three places, and a seventh package added to
two of them goes red on the third.

**D10 — 0023 D7's heading is five classes over a five-row table, and 0036 D7
adds two more.** *"Four published tag classes"* has listed five rows since it
was written. 0036 D7 adds `v0.4.1-beta` in git and `0.4.1-beta` on Docker Hub.
The clause gains a dated note reconciling the heading with its own table and
pointing at 0036 D7 for the two new rows; no row moves and no clause is
renumbered.

---

## E. What this record does not change

**D11 — The manifest set does not grow to hold the installer stamp.** 0036 D4
says so and this record repeats it because *"just add it to the list"* is the
obvious edit: `install.sh` is not a workspace package, and `assert_manifest_set`
exists to hold that every listed file exists and every workspace package is
listed. The stamp gets its own assertion beside the six.

**D12 — Nothing about the promotion sequence moves.** The human pause stays at
the head of `promote.yml` (0023 D15), promotion is still a fast-forward (0023
D5), the tag is still pushed before the release runs (0023 D40), and 0036 D3's
promotion window is untouched. Every check this record adds is a refusal placed
*before* an existing step, never a reordering of one.

**D13 — No published version number, tag or image tag changes.** #327 puts that
out of scope in as many words, and nothing here renames an artifact or moves a
tag.

---

## Consequences

**A version is one fact with several representations, and the tree is the
fact.** Every other row of D2's table is either checked against it or written
down as derived with the reason attached.

**A check can no longer pass while the versions disagree**, on any of the six
paths #327 enumerates. Where a gap is not closed it is D6, and D6 carries 0036
D19's price rather than an omission.

**Two live disagreements become red, and one of them will be met on the first
promotion after this lands.** Every image published before D4's label existed
either carries `24.04` or carries nothing, so the first promotion of a train
whose images predate this refuses at `verify` and asks for a re-run of the
train's image jobs. That is the check working, and it is written here so it is
recognised rather than diagnosed.

**A backport now has to bump the six manifests on its release line.** Nothing
wrote them there before, and `release.yml`'s new assertion holds a `release/x.y`
tag to its tree exactly as it holds a promotion's. This is a real new
obligation on a path that is dormant while the product is pre-1.0 (0023 D31
makes the supported set the current line only), and it is the correct one: a
backport that published `1.2.4` out of a tree saying `1.2.0` was shipping a
tarball whose `core-manifest.json` contradicted its own filename.

**#318 and #319 inherit their checks.** The beta tag and the beta image tag are
checked by the calls that already exist, because the manifests carry the line
(D1, D8). Neither ticket has to invent a comparison, and neither may add a
surface that has none.

**The npm assertion is no longer load-bearing on its own.** It stays last, it
stays exactly as it is, and what it now catches is the packed representation
rather than the whole chain (D5).

**Three lists hold the manifest set and every pair is bound.** That is one more
place to forget than before and zero more places to forget *silently*, which is
the trade this record takes deliberately: `ci.yml`'s array is what the rulesets
gate on, `docs/ci-cd.md`'s is what a person cuts from, and the module's is what
the push-time and release-time checks read.
