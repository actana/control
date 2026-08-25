// The workflow inventory, asserted rather than eyeballed.
//
// ADR 0016 D34 collapses nine workflow files into three entry points plus one
// reusable workflow, and #51's done-condition is literally "verified by `ls
// .github/workflows`". A directory listing is not a check, so this is: a tenth
// file added next year — or `stale.yml` quietly restored — fails here instead
// of being noticed by whoever happens to look.
//
// **D34's count is now six entry points**, and every revision was deliberate:
//
//   ci.yml           gates every pull request, and publishes the train's image
//                    on every push to `beta/**` (ADR 0023 D41)
//   release.yml      the tarballs, the images and the GitHub Release — entered
//                    by a dispatch and nothing else: never by a tag, and no
//                    longer by a `workflow_call` (D40, amended by #326)
//   promote.yml      the fifth file, and the only thing that advances `main`:
//                    pause, verify the digest, fast-forward, tag, release
//                    (ADR 0023, amending D34)
//   housekeeping.yml everything on a clock and nothing that gates
//   landing.yml      the fourth file: `landing/` to the CDN behind
//                    control.actana.ai (docs/landing-page.md §7)
//   beta-release.yml the sixth file, and the newest revision: a requested beta
//                    cut — the moving `vx.y.z-beta` tag, a prerelease GitHub
//                    Release, three tarballs, `SHA256SUMS` and `install.sh`
//                    (ADR 0036 D9, D10, amending 0016 D34 in its turn)
//
// `beta-release.yml` is an entry point rather than a third mode of
// `release.yml`, and ADR 0036 D9 records the refactor that would merge them as
// **refused**: `release.yml`'s `resolve` rejects any tag reachable from neither
// `main` nor a `release/*` branch, a beta tag is on a train and is reachable
// from neither, so a third mode would mean loosening the one guard that keeps
// the other two modes readable off the ref graph. One extra file is the price
// of keeping it.
//
// plus the one reusable `container-image.yml`, which every path that builds an
// image calls and which is not an entry point because it has no trigger of its
// own.
//
// `landing.yml` is a separate file rather than a path-filtered job inside
// `ci.yml` for a reason that has since grown teeth: `ci.yml`'s checks are
// required by the "Protect main" ruleset, and **a required check whose workflow
// is filtered out of a run stays Pending forever**, blocking every pull request
// that does not touch the filtered path. ADR 0023 D33 is the same failure
// reached from the other side — it is why `Panel image` / `Core image` exit
// early and green on a draft or a documentation-only diff instead of carrying a
// job-level `if:`. One rule, two files, and the count revised twice rather than
// drifted; see docs/ci-cd.md § "At a glance".
//
// It also pins the parts of `housekeeping.yml` that are load-bearing but
// invisible in a green run: the cron a job is gated on, the fact that the
// non-hermetic chores open an issue rather than failing a build (D38), and —
// since ADR 0023 D42 — the fact that nothing on a clock publishes an image at
// all. That last one is the whole immutability claim: a weekly rebuild pushing
// over `:latest` falsifies it every Monday, silently, while the promotion
// assertion keeps passing.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { CORE_TARGETS } from "../lib/core-tarball.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflowDir = path.join(repoRoot, ".github/workflows");
const read = (file) => fs.readFileSync(path.join(workflowDir, file), "utf8");

/** One job block, from its key up to the next job at the same indent. */
const jobBlock = (source, name) => {
  const start = source.indexOf(`\n  ${name}:`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

/** A block with its comment lines removed — what the runner actually reads. */
const code = (block) =>
  block
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("the workflow inventory (ADR 0016 D34)", () => {
  it("is six entry points plus one reusable workflow — nothing else", () => {
    expect(fs.readdirSync(workflowDir).sort()).toEqual([
      "beta-release.yml",
      "ci.yml",
      "container-image.yml",
      "housekeeping.yml",
      "landing.yml",
      "promote.yml",
      "release.yml",
    ]);
  });

  it("keeps the landing deploy off pull requests and out of ci.yml", () => {
    const source = read("landing.yml");
    // The CDN serves `main`. A PR-side deploy would publish an unmerged front
    // door.
    expect(source).not.toMatch(/^ {2}pull_request:/m);
    expect(source).toMatch(/^ {4}branches:\n {6}- main$/m);
    expect(source).toMatch(/^ {6}- "landing\/\*\*"$/m);
    // ci.yml used to carry the same `landing/**` exclusion, so a copy fix on
    // the page did not rebuild two images for `:edge`. Its `push: main`
    // trigger is gone with `:edge` (ADR 0023 D13, D41) and the train path
    // takes no path filter at all (D20) — a documentation-only merge that
    // skipped the build would leave `beta-x.y.z`'s revision label naming an
    // older commit, and the promotion assertion would fail. The saving moved
    // to the pull request side, where `pr-image-mode` resolves the same
    // exclusion list into the `pass` mode (D33).
    const ci = read("ci.yml");
    expect(ci).not.toMatch(/^ {4}paths-ignore:$/m);
    expect(ci).toMatch(/\^landing\//);
  });

  // #137. A draft resolves the image checks to `pass` (ADR 0023 D33), and
  // undrafting fires `ready_for_review` — which the default activity types do
  // not listen for, so the draft-time greens would stand over a head that was
  // never built, under the same check names a real build reports under. All
  // four types are asserted literally: naming `types` at all *replaces* the
  // defaults rather than extending them, so losing one of the three would
  // stop CI re-running at all, which is the same bug reached by a new route.
  it("re-runs when a pull request leaves draft (#137)", () => {
    // Comments stripped: the trigger block explains itself between the key
    // and the types list, and the runner reads what `code` reads.
    const ci = code(read("ci.yml"));
    expect(ci).toMatch(
      /^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]$/m,
    );
  });

  it("keeps container-image.yml reusable rather than a fourth entry point", () => {
    const source = read("container-image.yml");
    expect(source).toMatch(/^on:\n {2}workflow_call:/m);
    // No trigger of its own — `on:` holds workflow_call and nothing beside it.
    expect(source).not.toMatch(/^ {2}(?:push|pull_request|schedule|workflow_dispatch):/m);
  });

  // `beta-release.yml` joined the list with #319. It calls the same reusable
  // workflow in the one mode that builds nothing (`promote`, ADR 0023 D17), so
  // "every path that touches an image" is the honest reading of this test now:
  // three callers, one implementation, and no second place for D16's refusal
  // to be weakened.
  it("calls the reusable build from every path that builds an image", () => {
    for (const file of ["ci.yml", "release.yml", "beta-release.yml"]) {
      expect(read(file)).toContain("uses: ./.github/workflows/container-image.yml");
    }
  });

  // ADR 0023 D42. `housekeeping.yml` used to be a third caller: it rebuilt the
  // newest release every Monday and pushed over `:<version>` and `:latest`,
  // which would overwrite a promoted digest with bytes no beta contained and
  // no human approved. Nothing on a clock builds an image now, and nothing on
  // a clock publishes one.
  it("builds and publishes nothing from a cron", () => {
    const source = read("housekeeping.yml");
    expect(source).not.toContain("uses: ./.github/workflows/container-image.yml");
    expect(source).not.toMatch(/^\s+push: true$/m);
    expect(source).not.toMatch(/docker (push|buildx)/);
  });
});

// The macOS cost posture (decision #14) is invisible in a green run: a macOS
// runner that crept into the PR path looks exactly like a slow PR until the
// bill arrives. It is one added line away, so it is pinned.
describe("the macOS release leg (ADR 0016 D28, as amended)", () => {
  const source = read("release.yml");

  // ADR 0023 D15. The approval environment that used to sit on this leg is
  // gone: the pause moved to the head of `promote.yml`, upstream of this whole
  // workflow, so the fast-forward onto `main` is downstream of the human too.
  // **Exactly one pause exists.** This assertion is the inverse of the one it
  // replaces, and it is here for the same reason that one was: a second pause
  // reappearing here would be invisible in a green run — it would look like a
  // release nobody had got round to approving yet.
  it("builds mac-arm64 with no approval environment of its own (D15)", () => {
    const job = jobBlock(source, "tarball-macos");
    expect(job).not.toContain("environment:");
    expect(job).toMatch(/runs-on: macos-/);
    expect(job).toContain("TARGET: mac-arm64");
  });

  it("leaves no approval environment anywhere in the release", () => {
    expect(code(source)).not.toContain("macos-release");
  });

  it("holds the release behind that leg, so SHA256SUMS covers every asset", () => {
    const job = jobBlock(source, "github-release");
    expect(job).toMatch(/needs: \[[^\]]*tarball-macos[^\]]*\]/);
    // Derived, not a literal. `--expect` is co-edit #2 in core-tarball.mjs's
    // header, and a bare `3` here would let a fourth target land with every
    // other co-edit done and this one missed — green CI, then a release that
    // publishes a SHA256SUMS covering less than the release does.
    expect(job).toContain(
      `compose-core-shasums.mjs --dir core-tarballs --expect ${CORE_TARGETS.length}`,
    );
  });

  // The ordering outlives the approval that motivated it (D15). Pushing an
  // image is not undoable and `:latest` is a pointer with no history, so an
  // image published beside a GitHub Release missing a third of its tarballs is
  // a state nothing can walk back — and `install.sh` reads exactly that
  // Release. A release is atomic or it is not a release.
  it("publishes no image until every tarball the release needs exists", () => {
    for (const image of ["panel", "core"]) {
      const job = jobBlock(source, image);
      expect(job, `${image} publishes ahead of the mac tarball`).toMatch(
        /needs: \[[^\]]*tarball-macos[^\]]*\]/,
      );
      expect(job).toContain("push: true");
    }
  });

  // ADR 0023 D43. The page sync is no longer a leaf of this workflow at all —
  // it moved to housekeeping.yml and covers four repositories on a weekly
  // tick. A `descriptions` job reappearing here would be the old gating
  // rationale (ADR 0016 D33) coming back with it.
  it("no longer syncs the Docker Hub pages", () => {
    expect(source).not.toMatch(/^ {2}descriptions:$/m);
  });

  // container-image.yml is in the list because ci.yml calls it on every PR: a
  // macOS runner added there would spend PR minutes without appearing in any
  // entry point.
  it("spends no macOS minutes on a pull request or a chore", () => {
    for (const file of ["ci.yml", "housekeeping.yml", "container-image.yml"]) {
      expect(read(file), `${file} runs a job on macOS`).not.toMatch(/runs-on:.*macos/);
    }
  });
});

// Everything here is invisible in a green run and expensive when wrong. A
// second release run racing the first looks like a slow release; a promotion
// that quietly rebuilt looks like a promotion; a backport that moved `latest`
// looks like a successful backport, right up until every existing user is told
// to downgrade.
describe("release.yml's trigger and its two modes (ADR 0023 D17, D26, D28, D40)", () => {
  const source = read("release.yml");
  const body = code(source);

  // D40, as amended by #326. Two triggers are absent and each absence is
  // load-bearing. The tag trigger is gone because promote.yml pushes the tag
  // *and* enters this workflow, so a `push: tags` trigger would fire a second
  // run that would not even serialise against the first — the two resolve
  // `github.ref_name` differently. `workflow_call` is gone because a local
  // `uses:` resolves this file from the caller's SHA; the whole of #326 is
  // asserted in the block at the bottom of this file.
  it("takes a dispatch and nothing else — no tag trigger, no workflow_call", () => {
    expect(body).not.toMatch(/^ {2}push:$/m);
    expect(body).not.toMatch(/^ {6}- "v\*"$/m);
    expect(body).not.toMatch(/^ {2}workflow_call:$/m);
    expect(body).toMatch(/^ {2}workflow_dispatch:$/m);
    // Still entered with a tag, whichever way it was dispatched.
    expect(body).toMatch(/^ {6}tag:$/m);
  });

  // The other half of D40's trap, and the reason the trigger alone is not
  // enough: `github.ref_name` is the tag under a push and the caller's ref
  // under a `workflow_call`. Anything keyed on it takes two different values
  // for one release, so nothing here reads it at all.
  it("keys concurrency on the version rather than on github.ref_name", () => {
    expect(body).toMatch(/^ {2}group: release-\$\{\{ inputs\.tag \}\}$/m);
    expect(body).toMatch(/^ {2}cancel-in-progress: false$/m);
    expect(body, "github.ref_name resolves differently under workflow_call").not.toContain(
      "github.ref_name",
    );
  });

  // D26. The mode is a fact about where the tag lives, read off the branch
  // graph — not an input, not a label, and so not a thing anyone can forget to
  // set during the incident that produced the backport.
  it("picks its mode from where the tag lives, and says which in the log", () => {
    const job = code(jobBlock(source, "resolve"));
    expect(job).toContain("git merge-base --is-ancestor");
    expect(job).toContain("origin/main");
    expect(job).toMatch(/--list 'origin\/release\/\*'/);
    expect(job).toContain("mode=promote");
    expect(job).toContain("mode=backport");
    expect(job).toContain("::notice title=Promote mode::");
    expect(job).toContain("::notice title=Backport mode::");
  });

  // D17. Both image jobs are one call in two modes: `promote` retags,
  // `build` builds. The names are pinned by the "Protect main" ruleset — the
  // same two names ci.yml's required checks use — so they are asserted
  // literally here. A rename blocks every pull request in the repository until
  // an admin updates the ruleset.
  it("keeps the two pinned check names and hands both modes to the same call", () => {
    for (const [job, name] of [
      ["panel", "Panel image"],
      ["core", "Core image"],
    ]) {
      const block = jobBlock(source, job);
      expect(block, `${job} lost its pinned check name`).toContain(`name: ${name}`);
      expect(block).toContain("uses: ./.github/workflows/container-image.yml");
      expect(block).toContain("mode: ${{ needs.resolve.outputs.image_mode }}");
      expect(block).toContain("source_tag: ${{ needs.resolve.outputs.source_tag }}");
      // The commit, not the tag: promote mode asserts the digest's revision
      // label against it (D16) and backport mode builds it.
      expect(block).toContain("ref: ${{ needs.resolve.outputs.sha }}");
    }
    // ci.yml's copies of the same two names, which is what makes them pinned.
    const ci = read("ci.yml");
    expect(ci).toContain("name: Panel image");
    expect(ci).toContain("name: Core image");
  });

  // D28, surface one. The old code emitted `tags="$version latest"` for
  // anything without a `-` in it — no highest-version test anywhere — and this
  // asserts that shell is gone rather than merely bypassed.
  it("takes the latest decision from the tested module, not from a shell default", () => {
    const job = code(jobBlock(source, "resolve"));
    expect(job).toContain("node scripts/release-tags.mjs");
    expect(job).not.toMatch(/tags=\$version latest/);
  });

  // D28, surface two — the one that reaches `install.sh` and the in-product
  // update checker. `gh release create` defaults `make_latest` to true, so an
  // absent flag is the bug; it is passed explicitly on both the create and the
  // re-run paths.
  it("passes --latest explicitly to gh release, on create and on edit", () => {
    const job = code(jobBlock(source, "github-release"));
    expect(job).toContain('--latest="$RELEASE_LATEST"');
    expect(job).toContain('--prerelease="$RELEASE_PRERELEASE"');
    expect(job).toMatch(/gh release create[^]*--latest=/);
    expect(job).toMatch(/gh release edit[^]*--latest=/);
  });

  // D28's assertion, on both surfaces, in the two jobs that own them. The
  // rule itself is structural in scripts/lib/release-latest.mjs and covered by
  // scripts/__tests__/release-latest.test.mjs; what is pinned here is that the
  // workflow re-checks it at the point of publishing rather than trusting an
  // upstream output to still be right.
  it("refuses a backport that carries latest, on the docker tags and on GitHub", () => {
    const resolve = code(jobBlock(source, "resolve"));
    expect(resolve).toContain("A backport must never move latest");
    const release = code(jobBlock(source, "github-release"));
    expect(release).toContain('"$RELEASE_MODE" == "backport"');
    expect(release).toContain("A backport must never be the GitHub latest release");
  });
});

// npm, the second release registry (#129 D12, D13; #159; ADR 0018 as amended).
//
// Everything in this block is invisible in a green run, and one of them is
// invisible *forever*: a publish that stopped passing `--provenance`, or that
// moved to a job without `id-token: write`, **succeeds**. It prints the same
// lines, exits 0, and puts a package on the registry that is silently
// unattested — and the version cannot be republished to fix it.
//
// The rest of the release recovers from a bad step by re-running it. This one
// does not: an npm version number is burned by its first publish, and
// unpublishing inside the 72-hour window frees the bytes and not the name. So
// the ordering, the permission and the flag are pinned here rather than
// reviewed by eye.
describe("npm publishing (#129 D13, ADR 0018 as amended)", () => {
  const source = read("release.yml");

  // D13's "fails loudly", and *where* it fails is the requirement. `npm` is the
  // last job in the graph, so a token checked at the publish would be a token
  // checked after both images and their `:latest` were already re-pointed —
  // a half-published release, in the direction that does not undo.
  it("decides a missing NPM_TOKEN in resolve, before anything is built", () => {
    const job = code(jobBlock(source, "resolve"));
    expect(job).toContain("secrets.NPM_TOKEN");
    expect(job).toContain("::error title=Missing npm token::");
    // The same shape as the Docker Hub check it was modelled on: both are in
    // this job, both are a bare emptiness test, both exit 1.
    expect(job).toContain("::error title=Missing Docker Hub credential::");
    expect(job).toMatch(/if \[\[ -n "\$NPM_TOKEN" \]\]; then\n\s+exit 0\n\s+fi/);
    // And it is genuinely upstream: every publishing job needs `resolve`.
    for (const publisher of ["panel", "core", "npm", "github-release"]) {
      expect(jobBlock(source, publisher), `${publisher} does not wait on resolve`).toMatch(
        /needs: \[?[^\]\n]*resolve/,
      );
    }
  });

  // The trap #159 names. `npm publish --provenance` from a job without this
  // permission fails; a publish that quietly dropped the flag does not. Both
  // halves are asserted, plus the read-back that catches the case neither
  // covers.
  it("publishes with id-token: write, and with the flag", () => {
    const job = jobBlock(source, "npm");
    expect(job).toMatch(/^ {4}permissions:\n(?: {6}.+\n)* {6}id-token: write$/m);
    expect(code(job)).toContain(
      'npm publish "$tarball" --provenance --access public --tag "$NPM_TAG"',
    );
  });

  // D28's third surface. `npm publish` with no `--tag` takes `latest`, which is
  // the same default this file already refuses for the docker tag list and for
  // `gh release create --latest`. The assertion is in two halves because the
  // interesting failure is not "the flag is gone" but "the flag is there and
  // hard-coded": a literal `--tag latest` would satisfy a check that only
  // looked for `--tag`.
  it("never lets npm default the dist-tag, and takes it from resolve", () => {
    const job = jobBlock(source, "npm");
    const publish = code(job);
    // Every `npm publish` *command* in the job carries an explicit `--tag` —
    // the job's own `name:` says "npm publish" too, and it is not one.
    const commands = publish.split("\n").filter((line) => /^\s*npm publish /.test(line));
    expect(commands.length, "no npm publish command in the npm job").toBeGreaterThan(0);
    for (const line of commands) {
      expect(line, `npm publish with no --tag: ${line.trim()}`).toMatch(/--tag /);
      expect(line, `npm publish with a hard-coded dist-tag: ${line.trim()}`).not.toMatch(
        /--tag +"?(latest|next)"?/,
      );
    }
    // And the value is the one `resolve` decided, not a second opinion.
    expect(job).toContain("NPM_TAG: ${{ needs.resolve.outputs.npm_tag }}");
    expect(jobBlock(source, "resolve")).toContain("npm_tag: ${{ steps.tags.outputs.npm_tag }}");
  });

  // The guard step covers all three surfaces in one place, so a backport cannot
  // move `latest` on any of them. The docker and GitHub arms predate #159; the
  // npm arm is the one that was missing.
  it("guards the npm dist-tag in resolve, beside the other two surfaces", () => {
    const job = code(jobBlock(source, "resolve"));
    expect(job).toContain("::error title=A backport must never take the npm latest dist-tag::");
    expect(job).toContain("::error title=A backport must never move latest::");
    expect(job).toContain("::error title=A backport must never be the GitHub latest release::");
    // An empty dist-tag is not "no tag" — `npm publish --tag ""` fails, and it
    // would fail after both images had shipped.
    expect(job).toContain("::error title=No npm dist-tag resolved::");
  });

  // The read-back after the publish is the one check that can catch a publish
  // that already succeeded unattested — and it runs at the only point in this
  // workflow where a false alarm costs a version number. "The registry said no
  // attestation" and "the registry never answered" must therefore be different
  // failures with different advice.
  it("tells an unattested publish apart from a registry it could not reach", () => {
    const job = jobBlock(source, "npm");
    const step = job.slice(job.indexOf("Every published package is attested"));
    // The read is authenticated, for the same reason the publish is: the
    // `.npmrc` setup-node wrote references NODE_AUTH_TOKEN, and an unset one is
    // sent as a literal bearer token.
    expect(step).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    // The exit status is captured apart from the output. `2>/dev/null || true`
    // is precisely what collapsed the two cases into one empty string.
    expect(step).not.toContain("2>/dev/null || true");
    expect(step).toMatch(/if output="\$\(npm view "\$spec" dist\.attestations/);
    // Two errors, two messages, and the advice differs on the point that
    // matters: one says cut the next version, the other says do not.
    expect(step).toContain("::error title=Published without provenance::");
    expect(step).toContain("::error title=Could not verify provenance::");
    expect(step).toMatch(/Could not verify provenance::[^\n]*Do NOT cut a new version/);
    // And it still fails the release either way.
    expect(step).toContain('exit "$fail"');
    expect(step).not.toContain("continue-on-error");
  });

  // The other half of separating the status from the output: what lands in the
  // output has to be the field. `npm view <spec> <field>` exits 0 and prints
  // nothing when the field is absent, so `2>&1` turns any `npm warn` line into
  // a non-empty answer — and non-empty is this step's whole definition of
  // attested. A warning would be reported as provenance, by the one check that
  // exists to catch a publish that has none.
  it("does not let a warning on stderr read as an attestation", () => {
    const job = jobBlock(source, "npm");
    const step = code(job.slice(job.indexOf("Every published package is attested")));
    // stderr has its own file, and is still kept for the failure message.
    expect(step).toContain('2>"$stderr"');
    expect(step).toMatch(/error="\$\(tail -n 3 "\$stderr"/);
    expect(step, "npm's stderr is folded back into the value being tested").not.toMatch(
      /npm view "\$spec" dist\.attestations[^\n]*2>&1/,
    );
    // And the value has to look like what a predicateType is.
    expect(step).toContain('"$predicate" != https://*');
  });

  // Least privilege, and a second reading of the same line: `id-token: write`
  // is a token-minting permission, and it belongs to the one job that mints a
  // token. Its appearance anywhere else in this file would most likely be
  // somebody moving the publish.
  it("grants id-token to that job and to nothing else", () => {
    for (const other of ["resolve", "tarball", "tarball-macos", "installer-e2e", "github-release"]) {
      expect(code(jobBlock(source, other)), `${other} can mint an OIDC token`).not.toContain(
        "id-token: write",
      );
    }
  });

  // Downstream of the human, and downstream of every gate. The approval itself
  // is no longer in this file (ADR 0023 D15 moved it to the head of
  // promote.yml, upstream of the whole workflow), so what is assertable here is
  // the ordering that survived the move — and it is the ordering that matters
  // for a publish that cannot be undone: nothing is burned until the images are
  // out, the tarballs exist, and the installer e2e is green.
  it("waits on every other publish, because it is the one that cannot be redone", () => {
    const job = jobBlock(source, "npm");
    for (const upstream of ["tarball", "tarball-macos", "installer-e2e", "panel", "core"]) {
      expect(job, `npm publishes ahead of ${upstream}`).toMatch(
        new RegExp(`needs: \\[[^\\]]*\\b${upstream}\\b[^\\]]*\\]`),
      );
    }
    // And the announcement waits on it, so a GitHub Release never points at an
    // `npm i` that 404s.
    expect(jobBlock(source, "github-release")).toMatch(/needs: \[[^\]]*\bnpm\b[^\]]*\]/);
  });

  // The credential reaches exactly one job. `github-release` is in this list
  // for a specific reason: it is the job with `contents: write`, and the two
  // powerful credentials in this workflow should not meet.
  it("keeps the npm token out of every job but the publish", () => {
    for (const other of ["tarball", "tarball-macos", "installer-e2e", "github-release"]) {
      expect(code(jobBlock(source, other)), `${other} can reach NPM_TOKEN`).not.toContain(
        "secrets.NPM_TOKEN",
      );
    }
    // `resolve` sees it, and only as an emptiness test — it never publishes.
    const resolve = code(jobBlock(source, "resolve"));
    expect(resolve).not.toContain("npm publish");
  });

  // `pnpm pack`, not `npm pack`, and the difference is not a preference:
  // `publishConfig.exports` is applied by pnpm and ignored by npm, and it is
  // what turns the SDK's source-pointing `exports` map into the compiled one a
  // consumer resolves. An `npm pack` here would publish a package whose every
  // subpath resolves to a file that is not in the tarball.
  it("packs through the rehearsal script, which is what pull requests run", () => {
    const job = code(jobBlock(source, "npm"));
    expect(job).toContain("node scripts/rehearse-npm-publish.mjs");
    expect(job).toContain('--version "$RELEASE_VERSION"');
    expect(job).not.toMatch(/\bnpm pack\b/);
  });

  // The last brace, and the only one that can catch an unattested publish after
  // the fact: read the attestation back off the registry and fail if it is not
  // there.
  it("reads the attestation back rather than trusting the flag", () => {
    const job = code(jobBlock(source, "npm"));
    expect(job).toContain("dist.attestations.provenance.predicateType");
    expect(job).toContain("::error title=Published without provenance::");
  });

  // A re-run is a supported path (`workflow_dispatch` on the same tag), and on
  // it the registry already holds this version. `npm publish` answers 403 to
  // that, which would fail a release whose only fault is having worked.
  it("treats an already-published version as published", () => {
    const job = code(jobBlock(source, "npm"));
    expect(job).toContain("::notice title=Already on npm::");
    expect(job).toMatch(/npm view "\$spec" version/);
  });
});

describe("container-image.yml's promote mode (ADR 0023 D16, D17)", () => {
  const source = read("container-image.yml");
  const body = code(source);

  it("retags an existing digest and builds nothing", () => {
    expect(body).toMatch(/^ {2} {4}source_tag:$/m);
    const publish = code(jobBlock(source, "publish"));
    expect(publish).toContain('sources+=("$IMAGE:$SOURCE_TAG")');
    expect(publish).toContain("docker buildx imagetools create");
    // Every build step is gated on `build` mode, so a promotion runs none of
    // them. Asserted as a count rather than by name: a new build step added
    // without the gate is exactly the regression that would make a promotion
    // start producing bytes.
    const build = jobBlock(source, "build");
    const dockerBuilds = [...build.matchAll(/^ {8}run: \|?[^]*?docker build /gm)];
    for (const step of build.split(/\n {6}- /).slice(1)) {
      if (!/docker build /.test(step)) continue;
      expect(step, "a build step that a promotion would run").toContain(
        "if: inputs.mode == 'build'",
      );
    }
    expect(dockerBuilds.length).toBeGreaterThan(0);
  });

  it("asserts the revision label before anything is re-pointed", () => {
    const build = code(jobBlock(source, "build"));
    expect(build).toContain("if: inputs.mode == 'verify' || inputs.mode == 'promote'");
    expect(build).toContain("org.opencontainers.image.revision");
    expect(build).toContain("Refusing to promote a digest built from another commit");
    // The retag lives in `publish`, which needs `build` — so the assertion is
    // upstream of every tag it protects, on every architecture.
    expect(code(jobBlock(source, "publish"))).toContain("needs: [resolve, build]");
  });

  // A promotion has no per-arch bytes of its own: it must never push a
  // scaffolding tag, and it must never be able to reach the build path's push
  // with an empty stage.
  it("pushes no per-arch scaffolding when it built no per-arch bytes", () => {
    expect(body).toContain("if: inputs.push && inputs.mode == 'build'");
  });

  // The mode that publishes without building is the one whose inputs cannot be
  // assumed: no source is nothing to promote, and `push: false` would be a
  // green check for having done nothing at all.
  it("refuses a promotion with nothing to promote, and a build carrying a source", () => {
    const resolve = code(jobBlock(source, "resolve"));
    expect(resolve).toContain("Nothing to promote");
    expect(resolve).toContain("source_tag outside promote mode");
    expect(resolve).toMatch(/build\|promote\|verify\|pass/);
  });

  // The label D16 compares against has to name the commit that is *in* the
  // image. `github.sha` is the commit the event named, and on the backport
  // path those differ — a dispatch on the default branch building a
  // `release/x.y` commit.
  it("labels the revision from the checkout rather than from the event", () => {
    const build = code(jobBlock(source, "build"));
    expect(build).toContain('revision="$(git rev-parse HEAD)"');
    expect(build).toContain('--build-arg "IMAGE_REVISION=$revision"');
    expect(build).toContain('--label "org.opencontainers.image.revision=$revision"');
    expect(build).not.toContain("SHA: ${{ github.sha }}");
  });
});

describe("housekeeping.yml", () => {
  const source = read("housekeeping.yml");

  // The daily one is stale.yml's own cron, carried across unchanged; the
  // weekly one is Monday, which is D10's cadence for the base check.
  const DAILY = "17 3 * * *";
  const WEEKLY = "0 7 * * 1";

  it("carries exactly the two crons the chores are split across", () => {
    const crons = [...source.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
    expect(crons).toEqual([DAILY, WEEKLY]);
  });

  it("runs stale and open-train daily, everything else weekly", () => {
    expect(jobBlock(source, "stale")).toContain(DAILY);
    expect(jobBlock(source, "open-train")).toContain(DAILY);
    for (const job of [
      "base-pins",
      "release-ref",
      "dev-tag-sweep",
      "descriptions",
      "dev-audit",
      "harness-canary",
    ]) {
      expect(jobBlock(source, job), `${job} is not on the weekly cron`).toContain(WEEKLY);
    }
  });

  // `release-detector` has no cron of its own — it is `needs: release-ref`,
  // which does. Asserted rather than assumed, because a detector that runs on
  // no schedule is indistinguishable from a green one.
  it("hangs the detector off the resolver that carries the weekly cron", () => {
    const job = jobBlock(source, "release-detector");
    expect(job).toContain("needs: release-ref");
    expect(job).toContain("if: needs.release-ref.outputs.ref != ''");
  });

  // ADR 0023 D42. The rebuild became a detector: base drift or a new *fixable*
  // CRITICAL/HIGH opens an issue, for both images, and nothing is published.
  // Every clause here is one deleted line away from being false.
  it("detects rather than republishes, for both images", () => {
    const job = jobBlock(source, "release-detector");
    expect(job).toMatch(/image: \[panel, core\]/);
    expect(job).toContain("check-base-pins.mjs");
    expect(job).toContain("scan-core-image.mjs");
    expect(job).toContain("gh issue create");
    expect(job).toContain("issues: write");
    expect(job).not.toContain("push: true");
  });

  // D45, and D38 (*the delete-capable credential*). The delete credential is a
  // second secret, and it never
  // appears in a job that could touch a release repository.
  it("sweeps the -dev tags with the cleanup token and nothing else", () => {
    const job = jobBlock(source, "dev-tag-sweep");
    expect(job).toContain("scripts/sweep-dev-tags.mjs");
    expect(job).toContain("secrets.DOCKERHUB_CLEANUP_TOKEN");
    // The push credential must not be in reach of the delete path.
    expect(job).not.toContain("secrets.DOCKERHUB_TOKEN");
    // And the cleanup token must not leak into any other job. Comments are
    // stripped first: `jobBlock` runs to the next job key, so a block ends
    // with the *following* job's explanatory header, and this file explains
    // that credential at length.
    for (const other of ["descriptions", "release-detector", "base-pins"]) {
      expect(code(jobBlock(source, other)), `${other} can reach the delete credential`).not.toContain(
        "DOCKERHUB_CLEANUP_TOKEN",
      );
    }
  });

  // D43. Four repositories, not the two the release workflow used to sync.
  it("syncs all four Docker Hub pages", () => {
    const job = jobBlock(source, "descriptions");
    for (const image of ["panel", "core", "panel-dev", "core-dev"]) {
      expect(job, `${image} is not synced`).toContain(`sync ${image} docs/images/${image}.md`);
    }
  });

  // D37, D38 and D42. All three are red for reasons no PR author caused and no
  // PR author can fix, so the output is an issue, not a failed build.
  it.each(["dev-audit", "harness-canary", "release-detector", "open-train"])(
    "opens an issue rather than gating (%s)",
    (name) => {
      const job = jobBlock(source, name);
      expect(job).toContain("issues: write");
      expect(job).toContain("gh issue create");
    },
  );

  it("audits the whole dev tree, which is the half ci.yml's --prod audit skips", () => {
    const job = jobBlock(source, "dev-audit");
    expect(job).toMatch(/pnpm audit --audit-level high/);
    // `--prod` is ci.yml's, and the comment here says so — what must not
    // appear is the invocation.
    expect(job).not.toMatch(/pnpm audit --prod/);
  });

  it("runs the Harness canary against the vendors' real installers (D38)", () => {
    expect(jobBlock(source, "harness-canary")).toContain(
      "scripts/e2e-actana-harnesses-linux.mjs",
    );
  });
});

// ADR 0023 D25, as amended by #325 — nothing cuts a train, and the invariant is
// a mechanism rather than a sentence in a runbook.
//
// The cut used to be a job here that guessed `beta/<next-minor>.0` from the
// version it had just promoted and pushed it. Cuts are administrative — a
// person names the train — so the job, the guess and the output that carried it
// are gone. What the job was holding up is not: *a train is always open, so work
// can always be proposed*. These tests assert both halves, because "we deleted
// it" and "we deleted it and something still holds the invariant" look
// identical in a diff.
//
// The assertions are written positively wherever they can be. #325's last
// acceptance criterion is that the deleted output's name appears nowhere in the
// repository outside the ADR amendments that record it, and a test that greps
// for the string in order to refuse it would be the one place it survived.
describe("no automatic train cut (ADR 0023 D25, as amended by #325)", () => {
  const source = read("promote.yml");

  it("resolves facts and invents no version", () => {
    const outputs = [...jobBlock(source, "resolve").matchAll(/^ {6}([a-z_]+): \$\{\{ steps\.facts/gm)].map(
      (m) => m[1],
    );
    // `release_line` is derived — from the train's own name, which is a fact
    // about the branch that was handed in rather than a version invented from
    // it (D27). Every other entry is read. Asserted as an exact list: an added
    // output is how a computed version would come back.
    expect(outputs).toEqual(["train", "version", "head_sha", "pr", "release_line", "hotfix", "survivor"]);
  });

  it("does the minor-bump arithmetic nowhere", () => {
    expect(code(source)).not.toMatch(/minor \+ 1/);
  });

  it("pushes no beta branch", () => {
    // `retire-train` pushes a deletion of the train it was handed, and
    // `rebase-train` force-pushes a train that already exists; neither names
    // the class in a literal. A `git push` line that does is a cut.
    expect(code(source)).not.toMatch(/git push[^\n]*beta/);
  });

  it("reports the invariant instead, and files an issue rather than going red", () => {
    const job = jobBlock(source, "train-invariant");
    expect(job).toContain("issues: write");
    expect(job).toContain("gh issue create");
    expect(code(job)).toContain("git ls-remote --heads origin 'refs/heads/beta/*'");
    // The whole job hangs on that listing being trusted only when it worked:
    // `|| true` over it turns "origin did not answer" into "no train exists".
    expect(code(job)).not.toMatch(/ls-remote[^\n]*\|\| true/);
    // A red run on the correct outcome of a good promotion is how a team
    // learns that red means nothing. The failure path is an issue.
    expect(code(job)).not.toMatch(/^\s*exit 1$/m);
  });

  it("shares one issue title with the daily chore, so the two cannot file a pair", () => {
    const title = /TITLE="([^"]+)"/.exec(code(jobBlock(source, "train-invariant")));
    expect(title, "the promotion files no titled issue").not.toBeNull();
    const chore = code(jobBlock(read("housekeeping.yml"), "open-train"));
    expect(chore, "housekeeping files a different title").toContain(`TITLE="${title[1]}"`);
  });

  it("points a person at the procedure rather than at a button", () => {
    for (const [file, job] of [
      ["promote.yml", "train-invariant"],
      ["housekeeping.yml", "open-train"],
    ]) {
      expect(code(jobBlock(read(file), job)), `${job} does not name the runbook`).toContain(
        "docs/ci-cd.md",
      );
    }
  });
});

// ADR 0023 D3, as amended by #152 and #157 — the manifest set, and the wiring
// that makes asserting it non-vacuous.
//
// The trap this guards is specific and does not look like a bug: a check that
// asserts the right thing under the wrong name. `Train rules` is the context
// pinned by all three rulesets in `docs/rulesets/`, so the version assertion
// gates only for as long as it lives inside the job named exactly that. Move it
// to a new job, rename the job, or split it out for tidiness, and the assertion
// still runs, still goes red on drift, and still blocks nothing — because the
// ruleset is waiting on a context nothing produces, and a required check nobody
// reports is not a failure, it is a Pending that gets bypassed.
//
// So the name is asserted against the rulesets rather than against a literal,
// and the manifest list is asserted against the workspace rather than against a
// count. `packages/sdk` is the fifth (#152, ADR 0025) and `packages/cli` the
// sixth (#157); the seventh fails here, which is the design working.
//
// The second half of that wiring moved in #325. The set the *cut* writes used
// to be an array inside `promote.yml`, and is now the array in the runbook a
// person cuts from — cuts are manual, and nothing guesses a version. The
// binding is unchanged in what it protects: the list that gates the train and
// the list a train is cut from are the same set, or something goes red.
// The beta cut (ADR 0036), and the five shapes in it that a green run cannot
// show you.
//
// Every assertion below is about something invisible while it is working. A
// version string that grew a counter publishes perfectly and 404s only for the
// operator who pins it; a `push:` trigger added here looks like a helpful
// automation until a merge publishes a prerelease nobody asked for; a lost
// `--prerelease` flag succeeds, logs nothing, and tells every running Core and
// Panel to move to an unreleased build; a macOS e2e leg looks like thoroughness
// until the bill arrives at 10×; and a tag move that happened before a gate went
// red leaves a published beta pointing at bytes that failed.
describe("the beta cut (ADR 0036 C1, C3, D7, D9-D11, D13, D14)", () => {
  const source = read("beta-release.yml");
  const body = code(source);
  const comments = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("#"))
    .join("\n");

  /**
   * One shell invocation, from the line naming `command` through the last of
   * its `\`-continued lines.
   *
   * The point is to assert against the command a runner will execute rather
   * than against the job's text, which also contains error messages *quoting*
   * commands. A flag counted over the whole job can be satisfied by a sentence
   * telling an operator how to repair the thing the flag prevents.
   */
  const invocation = (text, command) => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.includes(command));
    expect(start, `no \`${command}\` invocation`).toBeGreaterThan(-1);
    const call = [lines[start]];
    for (let i = start; lines[i].trimEnd().endsWith("\\"); i += 1) call.push(lines[i + 1]);
    return call.join("\n");
  };

  /**
   * The `with:` mapping a reusable-workflow job hands `container-image.yml`,
   * as `key -> value`, read off the comment-stripped job the way the runner
   * reads it.
   *
   * Same reason as `invocation` above: the inputs decide what is published,
   * and a `toContain` over the job's text is satisfied by a comment or an
   * error message naming the same string. This returns the mapping, so an
   * assertion can say `tags` **is** one thing rather than that the word
   * appears somewhere in the job.
   */
  const withInputs = (text, job) => {
    const block = code(jobBlock(text, job));
    const lines = block.split("\n");
    const start = lines.findIndex((line) => line === "    with:");
    expect(start, `no with: block in ${job}`).toBeGreaterThan(-1);
    const inputs = {};
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") continue;
      if (!/^ {6}\S/.test(line)) break;
      const pair = /^ {6}([a-z_]+): (.+)$/.exec(line);
      expect(pair, `unparsed input line in ${job}: ${line}`).not.toBeNull();
      inputs[pair[1]] = pair[2].trim();
    }
    return inputs;
  };

  /** A job's own scalar key (`name`, `uses`, `secrets`) at the job's indent. */
  const jobKey = (text, job, key) => {
    const match = new RegExp(`^ {4}${key}: (.+)$`, "m").exec(code(jobBlock(text, job)));
    return match === null ? undefined : match[1].trim();
  };

  /**
   * Every job in the file whose `uses:` is `container-image.yml`, in file
   * order — the jobs that can put a tag on Docker Hub.
   *
   * Derived rather than listed, because the invariants below are stated about
   * the file and not about two names: a third promoting job added later must
   * fall under them automatically, or the assertion is narrower than the claim
   * it is written to defend.
   */
  const imageCallers = (text) =>
    [...code(text).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
      .map((match) => match[1])
      .filter((job) => jobKey(text, job, "uses") === "./.github/workflows/container-image.yml");

  // C3. A beta cut is *requested*, the way a promotion is (ADR 0023 D14),
  // because "published by accident" is the failure worth designing out. A
  // `push:` on `beta/**` here would be one line and would turn every merge into
  // the train into a publish.
  it("is entered by a person naming a train, and by nothing else (C3)", () => {
    expect(body).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(body).toMatch(/^ {6}train:$/m);
    expect(body, "a merge into the train would publish a beta").not.toMatch(/^ {2}push:$/m);
    expect(body).not.toMatch(/^ {2}schedule:$/m);
    expect(body).not.toMatch(/^ {2}pull_request:$/m);
    expect(body, "nothing may reach this file without a person naming a train").not.toMatch(
      /^ {2}workflow_call:$/m,
    );
  });

  // C1, which is a recorded operator constraint and not a default to improve
  // on. The version is one concatenation from the train name, and the shape it
  // is allowed to have is asserted in the file itself — before anything is
  // built, and again on the asset filenames before anything is published.
  it("builds the version by concatenation and refuses any counter (C1)", () => {
    const job = code(jobBlock(source, "resolve"));
    expect(job).toContain('version="${train#beta/}"');
    expect(job).toContain('beta_version="$version-beta"');
    expect(job).toContain("=~ ^[0-9]+\\.[0-9]+\\.[0-9]+-beta$");
    expect(job).toContain('tag="v$beta_version"');
    // The three dialects a counter actually arrives in. None of them belongs
    // anywhere in this file, so this is asserted over the whole of it rather
    // than over the job that composes the string.
    for (const counter of ["github.run_number", "github.run_attempt", "github.run_id"]) {
      expect(body, `${counter} is a counter, and C1 bans every counter`).not.toContain(counter);
    }
  });

  // The same constraint at the surface that reaches an operator. The asset name
  // is half the installer contract ADR 0016 D29 prices — `install.sh` fetches
  // `actana-core-<version>-<target>.tar.gz` and refuses a tree whose root
  // directory is not `actana-core-<version>-<target>/` — so a suffix that got
  // this far would publish a beta that `--version x.y.z-beta` cannot install,
  // with every other check green.
  it("asserts the bare version on the asset filenames too (C1, ADR 0016 D29)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain('name="actana-core-$BETA_VERSION-$target.tar.gz"');
    for (const { target } of CORE_TARGETS) expect(job).toContain(target);
  });

  // #326, reached in this file by a different road. A `workflow_dispatch` run
  // resolves every workflow file it executes from the ref it was dispatched on,
  // so `--ref main -f train=beta/0.4.1` would cut the train with main's copy of
  // this workflow. A promotion closes that by dispatching `release.yml` at the
  // tag it just pushed; there is no second workflow here to dispatch, so it is
  // closed by refusing the mismatch outright.
  it("refuses to cut a train with another ref's copy of itself (#326)", () => {
    const job = jobBlock(source, "resolve");
    expect(job).toContain("RUN_REF: ${{ github.ref_name }}");
    expect(code(job)).toContain('if [[ "$RUN_REF" != "$train" ]]; then');
    // Dispatching nothing is what makes that refusal sufficient, and #319's two
    // retag jobs do not weaken it. This assertion used to read "no local
    // `uses:` at all", which was true of a file that called nothing and is the
    // wrong rule now: a reusable workflow named by **path** resolves from the
    // *same commit* as its caller, so once the refusal above has held
    // `github.ref_name` to the train, `core-image` and `panel-image` run the
    // train's own copy of `container-image.yml`. That is the inverse of #326's
    // trap rather than an instance of it.
    //
    // What resolves from somewhere else is a `owner/repo/....yml@ref` call —
    // pinned to a ref this run did not choose — and a *dispatch*. The first is
    // banned here; the second is covered by the loop below, which holds every
    // `gh workflow run` in the file to its `--ref`.
    for (const [, target] of body.matchAll(/uses: (\S*\.github\/workflows\/\S+)/g)) {
      expect(target, "a reusable call that is not a local path (#326)").toMatch(
        /^\.\/\.github\/workflows\/[a-z-]+\.yml$/,
      );
    }
    // The re-dispatch this file prints when it refuses is the one an operator
    // will paste, so it carries the `--ref` for the same reason #326 requires it
    // on every `gh workflow run release.yml` in the repository: a dispatch
    // without one resolves the workflow from the default branch.
    let seen = 0;
    for (const line of source.split("\n")) {
      if (!line.includes("gh workflow run")) continue;
      seen += 1;
      expect(line, `dispatches with no --ref: ${line.trim()}`).toMatch(
        /gh workflow run[^\n]*--ref/,
      );
    }
    expect(seen, "the refusal no longer tells an operator how to re-dispatch").toBeGreaterThan(0);
  });

  // ADR 0023 D21. A beta cut publishes a prerelease to the world; it is not the
  // first thing to look at a commit. Pinned to the tip's own run rather than to
  // the newest run on the branch, or "the train is green" is a statement about
  // somebody else's commit.
  //
  // **And to the push run.** `gh run list --branch` returns `pull_request` runs
  // beside `push` runs, and once a train's promotion pull request is open its
  // head sha *is* the train tip while its run is newer than the push run — so
  // selecting by sha alone selects the wrong gate. On a `pull_request` event
  // the train image jobs are skipped and, under ADR 0023 D33, a draft resolves
  // both image checks to `pass` without building, so the selected run may never
  // have published the `beta-x.y.z` digest #319 will retag from in this file.
  // Both filters are pinned: the flag is what makes the query right, and the
  // `select` is what survives a later edit dropping the flag.
  it("cuts nothing from a tip whose own CI push run is not green (D21, D41)", () => {
    const job = jobBlock(source, "resolve");
    const ran = code(job);
    expect(ran).toContain("gh run list");
    expect(ran).toContain("--workflow ci.yml");
    expect(ran, "a pull_request run is a different gate (D33)").toContain("--event push");
    expect(ran).toContain("select(.headSha == $sha and .event == \"push\")");
    // `gh run list` is a 403 without it, and the top-level grant is
    // `contents: read`.
    expect(job).toMatch(/permissions:\n(?: +.*\n)*? +actions: read/);
  });

  // D13 and D14, and the one place in this repository where a cost argument is
  // load-bearing enough to be pinned. ADR 0016 D35 took macOS off every trigger
  // but the release because three macOS legs were 72% of the bill at 10×
  // billing; a beta cut is a *more frequent* trigger than a release, so the one
  // leg it does spend is owned out loud and the e2e leg it does not spend is
  // refused out loud. `workflows.test.mjs` cannot price a runner, so it pins
  // the count and the sentence.
  it("spends exactly one macOS leg, and no macOS end-to-end (D13, D14)", () => {
    expect(source.match(/runs-on: macos-/g)).toHaveLength(1);
    const mac = jobBlock(source, "tarball-macos");
    expect(mac).toContain("TARGET: mac-arm64");
    expect(mac).toMatch(/runs-on: macos-/);
    expect(mac).not.toContain("e2e-actana-setup");
    expect(comments, "the file must say why there is no macOS e2e").toMatch(/10×/);
    expect(comments).toMatch(/macOS install(er)? e2e/);
  });

  // D14. One leg, ubuntu, x64 — deliberately not a matrix and deliberately not
  // the release's. What the distro axis catches (PAM, polkit, logind) is
  // already green on this exact commit from the train's own run, on both
  // distros; what is not yet proved is that the artifact about to be attached
  // installs at all. It is also, at 10× billing, the shape that keeps a second
  // macOS job out of a job that never had one.
  it("runs the installer end-to-end once, on ubuntu at x64 (D14)", () => {
    const job = jobBlock(source, "installer-e2e");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(job).toContain("scripts/e2e-actana-setup-linux.mjs");
    expect(job).toContain("--distro ubuntu");
    expect(job).toContain("core-tarball-linux-x64");
    expect(job, "a beta cut runs one leg, not a matrix").not.toMatch(/^ {4}strategy:$/m);
    expect(job).not.toMatch(/macos/);
    expect(job, "debian is the train's leg, not the cut's").not.toMatch(/debian/);
  });

  // D14's other half: everything above `publish` is a gate, so a red leg leaves
  // `vx.y.z-beta` naming the commit it named before the run started. The tag
  // move is the one that has to be inside the gated job — a tag moved by an
  // early job would survive a failure further down and leave a published beta
  // pointing at bytes that never passed.
  it("holds every write behind every gate, the tag move included", () => {
    expect(jobBlock(source, "publish")).toMatch(
      /needs: \[resolve, tarball, tarball-macos, installer-e2e\]/,
    );
    for (const job of ["resolve", "tarball", "tarball-macos", "installer-e2e"]) {
      const block = code(jobBlock(source, job));
      expect(block, `${job} writes to origin ahead of the gates`).not.toContain("git push");
      expect(block, `${job} writes a Release ahead of the gates`).not.toContain("gh release");
    }
  });

  // D7. The tag is a moving handle, force-updated per cut, and the previous sha
  // is named because that is the one fact a reader of the run needs and the one
  // git will not tell them afterwards. ADR 0023 D44's immutability is untouched:
  // it is about release tags, and `refs/tags/vx.y.z-beta` is a different name.
  it("moves the beta tag on purpose and says where it moved from (D7)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain('tag -f -a "$TAG" "$SHA"');
    expect(job).toContain('git push --force origin "refs/tags/$TAG"');
    expect(job).toContain('previous="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}"');
    expect(job).toContain("moves from $previous to $SHA");
  });

  // D10. Derived from `CORE_TARGETS`, never a literal: `--expect` is a co-edit
  // in core-tarball.mjs's own header, and a bare `3` here would let a fourth
  // target land with every other co-edit done and this one missed — a green run
  // publishing a `SHA256SUMS` that covers less than the cut does.
  it("checksums exactly the Core targets, and verifies the file it wrote", () => {
    const job = jobBlock(source, "publish");
    expect(job).toContain(
      `compose-core-shasums.mjs --dir core-tarballs --expect ${CORE_TARGETS.length}`,
    );
    expect(job).toContain("sha256sum -c SHA256SUMS");
  });

  // D10 and D5. `install.sh` ships as an asset so the script and the bytes it
  // fetches travel together; it stays a **copy**, and the canonical door stays
  // on `main` under ADR 0016 D29. The expected set is also what the prune step
  // reads, which is why #320 has to extend it when it attaches the CLI tarball.
  it("attaches every Core tarball, SHA256SUMS and install.sh (D5, D10)", () => {
    const job = code(jobBlock(source, "publish"));
    for (const { target } of CORE_TARGETS) {
      expect(job).toContain(`"actana-core-$BETA_VERSION-${target}.tar.gz"`);
    }
    expect(job).toContain('"SHA256SUMS"');
    expect(job).toContain('"install.sh"');
    expect(job).toContain("cp install.sh core-tarballs/install.sh");
  });

  // D7 again, from the operator's side: a second cut of the same beta is a
  // supported operation and not a repair. Every asset is clobbered, and
  // anything the previous cut left that this one does not produce is deleted —
  // otherwise a moving tag can accumulate a Release that is a mix of two cuts,
  // which is the one failure an immutable release tag cannot have.
  it("replaces every asset and leaves none of the previous cut behind (D7)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain("--clobber");
    expect(job).toContain("gh release delete-asset");
  });

  // ADR 0023 D9, kept in force by ADR 0036 D11, and the acceptance criterion
  // for this workflow in that clause's own words.
  //
  // Asserted against the **invocations**, not by counting matches over the job.
  // The count was the shape this test had first and it did not hold: both of
  // the step's `::error` remediation hints embed the literal
  // `gh release edit $TAG --prerelease=true --latest=false`, so a
  // `>= 2` over the whole job was satisfied by the error prose alone — deleting
  // both flags from both `gh release` calls left the suite green. This is the
  // *pre-merge* guard for the one flag D9 says must never be lost, and the
  // runtime read-back below it fires only after the tag has moved and the beta
  // is already published, which is why its own error text says "Fix it now".
  // A guard that a sentence can satisfy is not one.
  it("passes both flags on both `gh release` invocations, never defaulted (D11)", () => {
    const job = code(jobBlock(source, "publish"));
    for (const verb of ["gh release create", "gh release edit"]) {
      const call = invocation(job, verb);
      // `gh release create` with no `--latest` defaults `make_latest` to true,
      // which is the whole failure D9 describes; `edit` is the second cut's
      // path to the same two fields.
      expect(call, `${verb} does not pass --prerelease=true`).toContain("--prerelease=true");
      expect(call, `${verb} does not pass --latest=false`).toContain("--latest=false");
      // The body has to name *this* cut's commit on both paths, or a re-cut
      // moves the tag and every asset while the Release page goes on naming the
      // first cut's sha — the one thing ADR 0036 D7 calls a beta's immutable
      // record.
      expect(call, `${verb} does not write the notes`).toContain("--notes-file");
    }
    // Written before the branch, so both paths have it. A `printf … > notes.md`
    // inside the create arm is exactly the bug above.
    const publish = code(jobBlock(source, "publish"));
    expect(publish.indexOf('> "$RUNNER_TEMP/notes.md"')).toBeGreaterThan(-1);
    expect(
      publish.indexOf('> "$RUNNER_TEMP/notes.md"'),
      "the notes are written inside a branch, so a re-cut keeps the first cut's body",
    ).toBeLessThan(publish.indexOf('if gh release view "$TAG"'));
    // `draft` is the third field a person can pick by hand. The read-back
    // detects it, but only after the tag has moved — so the repair is asserted
    // beside the detection.
    expect(invocation(job, "gh release edit")).toContain("--draft=false");
  });

  // The read-back itself, which is the assertion D9 asks for rather than the
  // flag D9 warns can be lost. It runs after the Release is written, on the
  // pattern release.yml already uses for an npm attestation that vanishes
  // silently: the flag succeeded, the log looks identical, and only the API
  // knows.
  it("reads the flags back off the API, /releases/latest included (D11)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain('gh api "repos/$GH_REPO/releases/tags/$TAG"');
    expect(job).toContain("jq -r '.prerelease'");
    expect(job).toContain("jq -r '.draft'");
    expect(job).toContain('gh api "repos/$GH_REPO/releases/latest"');
    expect(job).toContain("The beta became the latest release");
  });

  // D15. An npm version is burned by its first publish, and C1 fixes the beta
  // string for the life of the line — so a registry publish would work once per
  // train and then 403 the second cut, after the tag had already moved. The
  // route is dropped rather than counted around, and the CLI reaches a beta as
  // an asset instead (D16, #320).
  it("publishes nothing to the npm registry (D15)", () => {
    expect(body).not.toContain("npm publish");
    expect(body).not.toContain("--provenance");
    expect(body).not.toContain("NPM_TOKEN");
  });

  // D9, from the other side. This workflow exists *because* release.yml refuses
  // a tag on a train, and that refusal is what it routes around rather than
  // removes: it is the guard that keeps release.yml's two modes readable off
  // the ref graph instead of off a flag. Deleting it and adding a third mode is
  // the obvious refactor a later reader proposes, and 0036 D9 refuses it — so
  // the sentence is pinned here, in the file whose existence depends on it.
  it("leaves release.yml's refusal of a tag on a train in place (D9)", () => {
    expect(code(read("release.yml"))).toContain("Tag is on neither main nor a release line");
  });

  // ── #319: the beta image tags ───────────────────────────────────────────────
  //
  // Every assertion below reads the `with:` mapping or a job's own keys rather
  // than searching the file for a string. That is the shape the review of #318
  // asked for after a flag count over a whole job was satisfied by two error
  // messages quoting the flag: this file's header names `promote`, `latest`,
  // `beta-x.y.z` and `x.y.z-beta` dozens of times in prose, so a `toContain`
  // here would pass against a file that publishes nothing at all.

  // #319's first and second criteria. The mode that retags is
  // `container-image.yml`'s and this file calls it — the machinery is not
  // re-implemented, so there is no second place for D16's refusal to be
  // weakened. `mode: promote` refuses `push: false` and a missing `source_tag`
  // in its own `resolve`, so a malformed call here fails before a pull.
  it("retags both images from the train's digest, and builds nothing (#319, D12)", () => {
    for (const [job, image] of [
      ["core-image", "core"],
      ["panel-image", "panel"],
    ]) {
      expect(jobKey(source, job, "uses")).toBe("./.github/workflows/container-image.yml");
      // Without this the reusable workflow sees no `DOCKERHUB_*` and the retag
      // fails at its credential check — after `publish` has already moved the
      // tag and published the Release. It fails closed, but it fails late,
      // which is the whole of finding 1 below; assert it here so the two
      // halves of "the credential is present and reaches the call" are both
      // pinned rather than only the first.
      expect(jobKey(source, job, "secrets"), `${job} does not pass its secrets on`).toBe(
        "inherit",
      );
      // `version` is #327's input and is governed exclusively by the binding
      // test below, which is the one that knows whether it exists yet. It is
      // held out here so that wiring it correctly the day #327 lands does not
      // make this test red for the right change.
      const { version: _version, ...inputs } = withInputs(source, job);
      expect(inputs).toEqual({
        image,
        ref: "${{ needs.resolve.outputs.sha }}",
        stage: "${{ needs.resolve.outputs.beta_version }}",
        mode: "promote",
        // `beta-0.4.1` — the train's moving handle, from the line, not from
        // the beta string. `beta-${{ … beta_version }}` would be
        // `beta-0.4.1-beta`, a tag nothing publishes.
        source_tag: "beta-${{ needs.resolve.outputs.version }}",
        tags: "${{ needs.resolve.outputs.beta_version }}",
        push: "true",
      });
      // The exhaustive `toEqual` above is what pins the absences, and each one
      // is a real failure rather than tidiness: `dev_tags` is refused outright
      // by promote mode (ADR 0023 D36), and a narrowed `matrix` would narrow
      // D16's per-architecture assertion rather than any work — a promotion
      // builds nothing, so there is nothing to save.
      expect(inputs.dev_tags).toBeUndefined();
      expect(inputs.matrix).toBeUndefined();
      // `push_required` left at its default `true`: a registry outage must
      // fail a cut rather than leave a Release advertising a tag that is not
      // there.
      expect(inputs.push_required).toBeUndefined();
    }
    // Nothing in this file builds an image or scans one. The retag is a
    // second name for bytes the train already gated (#319's second criterion).
    expect(body).not.toContain("docker build");
    expect(body).not.toContain("Dockerfile");
    expect(body).not.toMatch(/trivy/i);
  });

  // #319's fourth criterion, on the surface it is about. Asserted as the whole
  // value of `tags` rather than as the absence of the word: this file says
  // `--latest=false` and `/releases/latest` in the Release steps, so "latest
  // does not appear" is both false and beside the point. One tag, no space, no
  // second entry.
  it("puts exactly one tag on each repository, and latest is never it (D10)", () => {
    // Every job that calls `container-image.yml`, not the two named ones. The
    // claim this pins is file-wide — *`latest` is never in the tag list, on
    // either repository* — and a loop over a hard-coded pair is not that
    // claim: a third `uses: ./.github/workflows/container-image.yml` job with
    // `tags: latest` would satisfy it while breaking the invariant. So the
    // list is derived from the file.
    const promoters = imageCallers(source);
    expect(promoters, "no job calls container-image.yml").toEqual([
      "core-image",
      "panel-image",
    ]);
    for (const job of promoters) {
      const tags = withInputs(source, job).tags;
      expect(tags).toBe("${{ needs.resolve.outputs.beta_version }}");
      // `tags` is space-separated, so one whole expression and nothing beside
      // it is what "exactly one tag" means at this level. A second entry —
      // `latest`, or a literal — would sit outside the braces.
      expect(tags, "a second tag would ride along on the same retag").toMatch(
        /^\$\{\{[^{}]*\}\}$/,
      );
    }
    // And the string that expands there cannot be `latest` or anything else:
    // `resolve` builds it by one concatenation and refuses any other shape.
    expect(code(jobBlock(source, "resolve"))).toContain('beta_version="$version-beta"');
    expect(code(jobBlock(source, "resolve"))).toContain(
      '^[0-9]+\\.[0-9]+\\.[0-9]+-beta$',
    );
  });

  // #319's fifth criterion. `Panel image` / `Core image` are required checks in
  // the "Protect main" ruleset; reusing either name here would make a beta cut
  // report under a check the ruleset gates pull requests on. `ci.yml`'s train
  // jobs solved this with `(train)` and this file follows with `(beta)`.
  it("does not reuse the pinned Panel image / Core image check names", () => {
    expect(jobKey(source, "core-image", "name")).toBe("Core image (beta)");
    expect(jobKey(source, "panel-image", "name")).toBe("Panel image (beta)");
    // The pinned names, unqualified, must not appear as a job name anywhere in
    // this file — the check the ruleset knows is the bare one.
    expect(source).not.toMatch(/^ {4}name: (?:Panel|Core) image$/m);
    // And they are still where the ruleset expects them, so this test fails if
    // the convention it is following is the thing that moved.
    expect(read("release.yml")).toMatch(/^ {4}name: Core image$/m);
    expect(read("ci.yml")).toMatch(/^ {4}name: Core image \(train\)$/m);
  });

  // #319's sixth criterion, and the irreversibility argument behind it. An
  // image tag cannot be taken back: Docker Hub has no tag garbage collection
  // and no undelete (ADR 0023 D45), the delete-capable credential is kept out
  // of the repositories holding `latest` (D36, D38), and ADR 0036 D23 refuses
  // to widen it — so `x.y.z-beta` persists, and a retag that ran beside a
  // failed publish would persist beside a Release that does not exist.
  //
  // `publish` subsumes the three gate jobs, and they are named anyway: the
  // criterion is about those legs, and an edit that drops `publish` must not
  // silently drop them with it.
  it("retags only after every gate and after the Release exists (#319)", () => {
    const gates = ["resolve", "tarball", "tarball-macos", "installer-e2e", "publish"];
    // Derived, not listed — the ordering is a property of every promoting job
    // in this file, so a third one added later inherits it (see `imageCallers`).
    const promoters = imageCallers(source);
    expect(promoters).toEqual(["core-image", "panel-image"]);
    for (const job of promoters) {
      const needs = jobKey(source, job, "needs");
      for (const gate of gates) {
        expect(needs, `${job} does not wait for ${gate}`).toContain(gate);
      }
    }
    // The other direction: nothing upstream of `publish` may reach the
    // registry, or the ordering above is decoration. Asserted as *is not a
    // caller* rather than *does not contain the string*, because `resolve`
    // legitimately **names** `container-image.yml` — its credential preflight
    // exists to refuse early on behalf of exactly that call, and quotes the
    // file to say so. A string ban would forbid the reference rather than the
    // reach; what makes a job reach the registry is its `uses:`.
    for (const gate of gates) {
      expect(promoters, `${gate} calls container-image.yml ahead of the gates`).not.toContain(
        gate,
      );
    }
  });

  // #318's review named this as the hole that opens the moment #319 lands: a
  // promotion pull request run has the same head sha as the train tip and
  // skips `Resolve train tags` / `Core image (train)` / `Panel image (train)`,
  // and under ADR 0023 D33 a draft resolves both image checks to `pass`
  // without building. The digest this retag re-points is exactly the one such
  // a run never publishes.
  //
  // So the filter and the dependency are asserted together. Either alone is
  // satisfiable while the hole is open: a filter nothing depends on gates
  // nothing, and a dependency on an unfiltered gate is a dependency on a
  // pull_request run.
  it("retags only behind the greenness gate that filters the push event (D21, D41)", () => {
    const gate = code(jobBlock(source, "resolve"));
    expect(gate, "the gate no longer filters the event at the API").toContain("--event push");
    expect(gate, "the gate no longer asserts the event it selected").toContain(
      'select(.headSha == $sha and .event == "push")',
    );
    // The refusal itself, by its **condition** and not by its error title.
    // "Not a push run" is the `::error title=` of the very block this means to
    // pin, so a `toContain` on the message is satisfied by the message —
    // rewriting the test to `if [[ "$event" == "neverever" ]]` leaves the
    // string in place, the block unreachable and the suite green. That is #339
    // review r1's finding 3 in this same file, and the reason every #319
    // assertion beside it reads structure through `withInputs` / `jobKey`.
    expect(gate, "the non-push refusal can no longer fire").toContain(
      'if [[ "$event" != "push" ]]; then',
    );
    // And the message stays too, because it is what an operator reads when it
    // does fire — asserted after the condition, not instead of it.
    expect(gate).toContain("::error title=Not a push run::");
    for (const job of ["core-image", "panel-image"]) {
      expect(jobKey(source, job, "needs"), `${job} does not depend on the gate`).toContain(
        "resolve",
      );
    }
  });

  // The credential preflight, which exists because of the two jobs above.
  //
  // `container-image.yml`'s own `resolve` refuses a missing `DOCKERHUB_*` —
  // and it refuses **after** `publish` has force-moved `vx.y.z-beta`, created
  // the prerelease and uploaded every asset, because that is where these jobs
  // sit in the graph. A cut with an unset, rotated or expired token would
  // therefore end green through the macOS leg and the installer e2e, publish a
  // beta Release, and only then fail — leaving the Release advertising image
  // tags that do not exist. That is the half-state the retag's placement after
  // `publish` exists to prevent, arriving from the other side, and the repair
  // the header names (re-dispatch; every write is idempotent) converges only
  // while the train tip has not moved.
  //
  // `promote.yml`'s *The credentials release.yml refuses without* is the
  // in-repo precedent for moving exactly this refusal earlier, for exactly
  // this reason, and it is asserted in this file already.
  //
  // Asserted on the **secret names and the refusal**, in `resolve`, and paired
  // with the App check beside it: what matters is that both irreversible
  // halves of a cut are decided before either one starts.
  it("refuses a cut whose Docker Hub credentials are missing, before anything is published", () => {
    const job = code(jobBlock(source, "resolve"));
    for (const secret of ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN"]) {
      expect(job, `resolve does not preflight ${secret}`).toContain(`secrets.${secret}`);
      // The check itself, not just the wiring: an `env:` line with nothing
      // reading it is a secret that is passed and never asked about.
      expect(job, `resolve does not refuse on a missing ${secret}`).toContain(
        `missing+=(${secret})`,
      );
    }
    expect(job).toContain("::error title=A Docker Hub credential is missing::");
    // The App identity, checked in the same job for the same reason — the beta
    // tag is created under a ruleset only the App can bypass. Pinned here
    // beside the registry credential because the argument is one argument.
    for (const secret of ["APP_ID", "APP_PRIVATE_KEY"]) {
      expect(job, `resolve does not preflight ${secret}`).toContain(`secrets.${secret}`);
    }
    expect(job).toContain("::error title=No App identity::");
    // Both refusals are in `resolve`, which is upstream of every job that
    // builds, publishes or retags — so a missing secret costs one dispatch
    // rather than three tarball builds, a macOS runner and a published
    // Release.
    for (const later of ["tarball", "tarball-macos", "installer-e2e", "publish"]) {
      expect(
        jobKey(source, later, "needs"),
        `${later} does not hang off the preflight`,
      ).toContain("resolve");
    }
  });

  // ADR 0037 D7 and D8: a counted beta is refused wherever a version string is
  // validated, and #319 *inherits* that check rather than writing one. #327
  // moved the ban into `imageVersionProblem` precisely because image mode
  // short-circuits before `checkAgreement` and `lineOf("0.4.1-beta.1")` is
  // `0.4.1`, which agrees with a correctly labelled digest.
  //
  // That module and `container-image.yml`'s `version:` input are #327's and
  // are not in this branch's base. Passing an input a reusable workflow does
  // not declare is a hard failure, so this test binds the two rather than
  // asserting one of them: while the input does not exist the retag must not
  // pass it, and the moment it does exist the retag must pass the beta string
  // — `beta_version`, not the line, because the line is what a correctly
  // labelled digest already says and the counter is what has to be caught.
  it("passes the version the counted-beta ban is applied to, once #327 declares it", () => {
    const declared = /^ {6}version:$/m.test(read("container-image.yml"));
    for (const job of ["core-image", "panel-image"]) {
      const { version } = withInputs(source, job);
      if (declared) {
        expect(
          version,
          `${job} does not hand container-image.yml the string ADR 0037 D7 bans a counter in`,
        ).toBe("${{ needs.resolve.outputs.beta_version }}");
      } else {
        expect(
          version,
          `${job} passes a version input container-image.yml does not declare — the call would fail to start`,
        ).toBeUndefined();
      }
    }
  });

  // ── #320: the CLI asset, landed from #337's pull request comment ────────────

  // D15 and D16. The line, never the beta string — the script appends `-beta`,
  // which is what leaves no parameter a counter could arrive through — and the
  // real `npm i -g`, run against the bytes that are attached rather than
  // against a copy of them.
  it("packs the CLI as an asset from the line, and installs it for real (D16)", () => {
    const job = code(jobBlock(source, "publish"));
    const call = invocation(job, "rehearse-npm-publish.mjs");
    expect(call).toContain('--beta "$BETA_LINE"');
    expect(call, "the pack must not reach the release path's publish flags").not.toContain(
      "--version",
    );
    expect(call, "the asset must not be staged where the Core guards sweep").toContain(
      "--out-dir artifacts/beta",
    );
    expect(call, "#320's acceptance criterion is the install, not the pack").toContain(
      "--install-check",
    );
    // `BETA_LINE` is the line (`0.4.1`), not `beta_version` (`0.4.1-beta`).
    // `betaVersion("0.4.1-beta")` throws, so the wrong one is caught at
    // runtime — but only after a macOS leg and three tarballs have been paid
    // for, and the point of C1 is that no surface derives a second time.
    expect(job).toContain("BETA_LINE: ${{ needs.resolve.outputs.version }}");
    expect(job).not.toContain("BETA_LINE: ${{ needs.resolve.outputs.beta_version }}");
  });

  // The guard on the flag rather than on the artifact. `install=ok` is emitted
  // by the script only when `--install-check` actually ran, so dropping the
  // flag leaves a green run with an attached asset and the one assertion #320
  // calls the whole ticket never made.
  it("refuses an asset that was packed but never installed (D16)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain("INSTALL: ${{ steps.beta-cli.outputs.install }}");
    expect(job).toContain('if [[ "$INSTALL" != "ok" ]]; then');
    // And the filename, which is what an operator pastes into a terminal (C1).
    expect(job).toContain('if [[ "$ASSET" != "actana-cli-$BETA_VERSION.tgz" ]]; then');
  });

  // ADR 0036 D10 puts `SHA256SUMS` over exactly the three Core tarballs and
  // this file's `--expect` is derived from `CORE_TARGETS`, so #320's checksum
  // is its own file rather than a fourth row — the option that ticket names
  // beside the row and leaves both the record and the derivation intact.
  //
  // Ordering is asserted, not assumed: `compose-core-shasums.mjs` and the
  // foreign-asset guard both sweep `core-tarballs/`, so the CLI asset is
  // staged in after them.
  it("gives the CLI asset its own checksum file, staged after the Core guards (D10)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain(
      `compose-core-shasums.mjs --dir core-tarballs --expect ${CORE_TARGETS.length}`,
    );
    expect(job).toContain(`printf '%s  %s\\n' "$SHA256" "$ASSET" > "core-tarballs/$ASSET.sha256"`);
    expect(job, "the sidecar is verified the way an operator verifies it").toContain(
      'sha256sum -c "$ASSET.sha256"',
    );
    const compose = job.indexOf("compose-core-shasums.mjs");
    const guard = job.indexOf("A foreign asset is in the tarball directory");
    const stage = job.indexOf('cp "$TARBALL" "core-tarballs/$ASSET"');
    expect(compose).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(stage, "the CLI asset is staged before the Core guards sweep the directory")
      .toBeGreaterThan(Math.max(compose, guard));
    // And before the tag moves, which is this job's own ordering principle: a
    // failed pack must leave `vx.y.z-beta` where it was.
    expect(stage, "the asset is assembled after the tag has already moved").toBeLessThan(
      job.indexOf('git push --force origin "refs/tags/$TAG"'),
    );
  });

  // `EXPECTED` is the one list the create, the clobbering upload and the prune
  // all read. An asset uploaded outside it is an asset the next cut deletes,
  // which is the trap this file's own comment warned #320 about.
  it("names the CLI asset and its checksum in the asset contract (D7, D16)", () => {
    const job = code(jobBlock(source, "publish"));
    const expected = /EXPECTED=\(([\s\S]*?)\)\n/.exec(job);
    expect(expected, "no EXPECTED list").not.toBeNull();
    const names = [...expected[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([
      ...CORE_TARGETS.map(({ target }) => `actana-core-$BETA_VERSION-${target}.tar.gz`),
      "SHA256SUMS",
      "actana-cli-$BETA_VERSION.tgz",
      "actana-cli-$BETA_VERSION.tgz.sha256",
      "install.sh",
    ]);
  });

  // #320's last criterion: the printed command is the one an operator runs,
  // built from the pack's own outputs and this job's tag rather than
  // re-derived — and it says there is no attestation, because ADR 0036 D17
  // says #323's instructions must not imply one.
  it("prints the exact install command, and claims no attestation (D17)", () => {
    const job = code(jobBlock(source, "publish"));
    expect(job).toContain('url="https://github.com/$REPO/releases/download/$TAG/$ASSET"');
    expect(job).toContain('echo "npm i -g $url"');
    expect(job).toContain("ASSET: ${{ steps.beta-cli.outputs.asset }}");
    expect(job).toContain("SHA256: ${{ steps.beta-cli.outputs.sha256 }}");
    expect(job).toMatch(/no provenance attestation/);
  });
});

describe("the manifest version assertion (ADR 0023 D3, amended by #152 and #157)", () => {
  const MANIFESTS = [
    "package.json",
    "packages/cli/package.json",
    "packages/core/package.json",
    "packages/panel/package.json",
    "packages/sdk/package.json",
    "packages/shared/package.json",
  ];

  /** The check contexts every ruleset in `docs/rulesets/` requires. */
  const requiredContexts = () => {
    const dir = path.join(repoRoot, "docs/rulesets");
    const contexts = new Map();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const found = [
        ...JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")))
          .matchAll(/"context":"([^"]+)"/g),
      ].map((m) => m[1]);
      contexts.set(file, found);
    }
    return contexts;
  };

  it("is the set of every workspace manifest, not a number that goes stale", () => {
    const packages = fs
      .readdirSync(path.join(repoRoot, "packages"))
      .filter((name) => fs.existsSync(path.join(repoRoot, "packages", name, "package.json")))
      .map((name) => `packages/${name}/package.json`);
    expect([...packages, "package.json"].sort()).toEqual([...MANIFESTS].sort());
  });

  it("lives in the job the rulesets pin, so it actually gates", () => {
    const job = jobBlock(read("ci.yml"), "train-rules");
    // The context in the rulesets is the job's `name:`, not its key. Take that
    // name out of `ci.yml` and assert the rulesets require *it*, rather than
    // asserting the literal on both sides: what has to hold is that the job
    // carrying the version check is the context the rulesets gate on, and a
    // coordinated rename of the job and all three rulesets keeps that true.
    // Asserting the string in both places would fail a rename that is correct.
    const name = /^ {4}name: (.+)$/m.exec(job);
    expect(name, "the train-rules job has no name:").not.toBeNull();
    const context = name[1].trim();
    // Every ruleset that gates on checks at all gates on this one. The rulesets
    // with no contexts are the tag rulesets and the retired-line template,
    // which restrict pushes rather than require checks — asserting over them
    // would be asserting the wrong thing, so they are excluded by that
    // property rather than by name.
    const gating = [...requiredContexts()].filter(([, contexts]) => contexts.length > 0);
    expect(gating.length, "no ruleset requires any check").toBeGreaterThan(0);
    for (const [file, contexts] of gating) {
      expect(contexts, `${file} does not require the ${context} job`).toContain(context);
    }
  });

  it("compares every manifest inside that job", () => {
    const job = code(jobBlock(read("ci.yml"), "train-rules"));
    for (const manifest of MANIFESTS) {
      expect(job, `${manifest} is not asserted`).toContain(manifest);
    }
    // The set is checked before the versions are, so a manifest that vanishes
    // or a package that is added cannot shrink the loop silently.
    expect(job).toContain("assert_manifest_set");
    expect(job).toMatch(/for file in packages\/\*\/package\.json/);
  });

  // The binding that used to live in a workflow, following the cut to where the
  // cut now is (#325).
  //
  // This test read `files=()` out of `promote.yml`'s automatic cut until that
  // job was deleted, and asserted it equalled the list `Train rules` gates on.
  // **That assertion is the only thing that has ever bound the two sets**, and
  // deleting the job without moving it would have deleted the binding — a
  // seventh package added to `ci.yml` alone would then be cut unstamped and
  // found by `Train rules` afterwards, on the pull request of whoever opened
  // the first one into the new train. Six errors, on somebody who did not cut
  // the branch: exactly the failure this has always existed to catch.
  //
  // Cuts are manual now, so the list a cut is performed from is the array in
  // the runbook the person follows, and this reads that array. One `files=()`
  // in the whole document, asserted, because a second one appearing later
  // would make which of them is bound a coin toss.
  it("writes every one of them in the documented cut, which is where the versions come from", () => {
    const runbook = fs.readFileSync(path.join(repoRoot, "docs/ci-cd.md"), "utf8");
    const arrays = [...runbook.matchAll(/^files=\(([^)]*)\)/gm)];
    expect(arrays.length, "docs/ci-cd.md § Cutting a train has no single files=() array").toBe(1);
    expect(arrays[0][1].trim().split(/\s+/).sort()).toEqual([...MANIFESTS].sort());
  });
});

// #326 — a promotion must not be able to run a release workflow older than the
// train it is promoting.
//
// This is the failure that looks perfect right up to the point where it is
// unrecoverable. A `workflow_dispatch` run resolves **every** workflow file it
// executes from the ref it was dispatched on, and for `promote.yml` that is the
// default branch as it stood when the run was created — never the train. So
// `uses: ./.github/workflows/release.yml` ran `main`'s release pipeline against
// the train's commit. Run 32716466300 went green through the human pause, the
// digest verification, the fast-forward and the tag, and red on every job that
// publishes: `main` had moved and `v0.4.0` was tagged with nothing behind them.
//
// The fix is structural rather than a check, because a check cannot be the fix:
// refusing a train that changed `release.yml` would be the convention "do not
// change `release.yml` on a train", which is unenforceable, and the 0.4.0 train
// changed it for a good reason. So `release.yml` loses the trigger that made a
// caller's SHA reachable at all, and `promote.yml` dispatches it **at the tag**.
//
// Every assertion here is about a shape that is invisible in a green run. A
// dispatch that lost its `--ref` publishes correctly for as long as the default
// branch happens to agree with the train — which is exactly how this shipped.
describe("the promotion runs the promoted commit's own release workflow (#326)", () => {
  const promote = read("promote.yml");
  const release = read("release.yml");
  const runbook = fs.readFileSync(path.join(repoRoot, "docs/ci-cd.md"), "utf8");

  // Half one: there is no `uses:` left that could resolve `release.yml` from a
  // caller's SHA, because nothing can call it. Asserted over every workflow
  // rather than over `promote.yml` alone — the trap is the local `uses:`, and
  // it would be the same trap from any file.
  it("leaves no way to call release.yml from another workflow's SHA", () => {
    expect(code(release), "release.yml is callable again").not.toMatch(/^ {2}workflow_call:$/m);
    for (const file of fs.readdirSync(workflowDir)) {
      expect(
        code(read(file)),
        `${file} calls release.yml, which resolves it from ${file}'s own SHA`,
      ).not.toContain("uses: ./.github/workflows/release.yml");
    }
  });

  // Half two, and the line that decides which copy runs. `--ref` is the tag;
  // without it a dispatch resolves `release.yml` — and the
  // `container-image.yml` it calls — from the default branch, which is the
  // whole of #326. Asserted over every invocation anywhere in the repository,
  // including the ones inside error messages and the runbook, because a
  // recovery that tells an operator to dispatch without a ref is the failure it
  // is recovering from.
  it("dispatches release.yml at the version tag, and says so everywhere", () => {
    const job = code(jobBlock(promote, "release"));
    expect(job).toContain('tag="v$VERSION"');
    expect(job).toContain('gh workflow run release.yml --repo "$REPO" --ref "$tag" -f tag="$tag"');

    const sources = [
      ...fs.readdirSync(workflowDir).map((f) => [`.github/workflows/${f}`, read(f)]),
      ["docs/ci-cd.md", runbook],
      ["docs/REPO_SETUP.md", fs.readFileSync(path.join(repoRoot, "docs/REPO_SETUP.md"), "utf8")],
      [
        ".agents/skills/release/SKILL.md",
        fs.readFileSync(path.join(repoRoot, ".agents/skills/release/SKILL.md"), "utf8"),
      ],
    ];
    let seen = 0;
    for (const [name, text] of sources) {
      for (const line of text.split("\n")) {
        if (!line.includes("gh workflow run release.yml")) continue;
        seen += 1;
        expect(line, `${name} dispatches release.yml with no --ref: ${line.trim()}`).toMatch(
          /gh workflow run release\.yml[^\n]*--ref/,
        );
      }
    }
    // The guard on the guard: a renamed workflow would make the sweep above
    // find nothing and pass.
    expect(seen, "nothing dispatches release.yml anywhere").toBeGreaterThan(0);
  });

  // The observable fact the acceptance criterion asks for, on the one field
  // that carries it. `gh run view 32716466300 --json headSha` answered
  // `51164f1` — the old `main` — where it should have answered the commit being
  // promoted, and nothing was reading it.
  it("asserts the release run's head SHA is the commit being promoted", () => {
    const job = code(jobBlock(promote, "release"));
    expect(job).toContain(".head_sha");
    expect(job).toMatch(/if \[\[ "\$run_sha" != "\$HEAD_SHA" \]\]/);
    expect(job).toContain("::error title=The release run is not the promoted commit::");
  });

  // The run is found by head SHA **and** id, and neither alone is enough — each
  // of the two is the other's blind spot, and each blind spot lands the
  // repository in a half-run promotion, which is the state this whole change
  // exists to make unreachable.
  //
  // Without `head_sha`: `concurrency` is keyed on the train, so two promotions
  // of different trains legitimately overlap — the hotfix path is exactly that
  // — and the later one can adopt the earlier one's release run, fail its own
  // head-SHA assertion, and abort *after* `advance`, while the release it did
  // dispatch runs unwatched and `retire-train` never fires for a release that
  // published.
  //
  // Without the id window: a re-dispatch of the same tag shares its head SHA
  // with the run it replaces, so the query would match the run being replaced.
  //
  // And `before` has to be a maximum over a page rather than element zero. The
  // listing is ordered by `created_at`, and "created last" is not "highest id"
  // when two runs are queued at once — an id above a stale watermark is how a
  // foreign run qualifies in the first place.
  it("finds its own release run by head SHA and id together, not by either alone", () => {
    const job = code(jobBlock(promote, "release"));
    expect(job, "the run query is not pinned to the promoted commit").toContain(
      "head_sha=$HEAD_SHA",
    );
    expect(job).toMatch(/select\(\.id > \$before\)/);
    expect(job, "min_by takes the oldest qualifying run, not this job's own").toContain(
      "max_by(.id)",
    );
    expect(job, "min_by is the pre-#326-review shape").not.toContain("min_by(.id)");
    // The watermark: a maximum over a page, never `[0]`.
    expect(job).toContain("[.workflow_runs[].id] | max // 0");
    expect(job, "before is element zero, which is newest-created and not highest id").not.toMatch(
      /workflow_runs\[0\]\.id/,
    );
  });

  // A dispatch is fire-and-forget by nature, and a `release` job that returned
  // as soon as it had dispatched would be green on the exact run this issue is
  // about. It waits, and it carries the release's conclusion — which is what
  // keeps `release-line` and `retire-train` behind a successful publish.
  it("waits for the release and fails the promotion when it does not succeed", () => {
    const job = code(jobBlock(promote, "release"));
    expect(job).toContain('[[ "$status" == "completed" ]] && break');
    expect(job).toContain("::error title=The release failed::");
    expect(job).toContain("::error title=The release outlived this job's wait::");
    expect(job).toContain("::error title=The dispatch created no release run::");
    expect(job).not.toContain("continue-on-error");
    for (const downstream of ["release-line", "retire-train"]) {
      expect(jobBlock(promote, downstream), `${downstream} no longer waits on the release`).toMatch(
        /needs: \[[^\]]*\brelease\b[^\]]*\]/,
      );
    }
  });

  // The ordering criterion. Everything irreversible is in `advance`, and the
  // release's own refusals all arrive after it — because `release.yml` does not
  // start until the tag exists. `preflight` is those refusals, asked while
  // nothing has moved.
  it("proves the release runnable before anything irreversible happens", () => {
    expect(jobBlock(promote, "advance"), "advance does not wait on preflight").toMatch(
      /needs: \[[^\]]*\bpreflight\b[^\]]*\]/,
    );
    const job = code(jobBlock(promote, "preflight"));
    // Dispatchable, or the promotion strands after the fast-forward with no
    // way to publish at all.
    expect(job).toContain("::error title=The train's release.yml cannot be dispatched::");
    expect(job).toContain("::error title=The train's release.yml takes no tag input::");
    // Scoped to the `workflow_dispatch:` → `inputs:` block, never matched by
    // indent alone. Six spaces is also the depth of `with:` keys on a
    // reusable-workflow call, and `release.yml` carries `image:` and
    // `source_tag:` there — so a bare indent match passes a train that renamed
    // the input while still passing a `tag:` to `container-image.yml`, which is
    // the one thing this step exists to refuse.
    expect(job, "the tag-input check matches on indent alone").not.toMatch(
      /grep -qE '\^ \{6\}tag:'/,
    );
    expect(job).toContain("dispatch_inputs=");
    expect(job).toMatch(/\/\^ {2}workflow_dispatch:\[ \\t\]\*\$\//);
    expect(job).toMatch(/\/\^ {4}inputs:\[ \\t\]\*\$\//);
    expect(job).toContain("grep -qx 'tag'");
    // The credentials `release.yml` refuses on, refused earlier.
    for (const secret of ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN", "NPM_TOKEN"]) {
      expect(job, `preflight does not check ${secret}`).toContain(`secrets.${secret}`);
    }
    expect(job).toContain("::error title=A release credential is missing::");
    // And the tag, which `advance` only checks after `main` has already moved.
    expect(job).toContain("::error title=Tag exists on another commit::");
    // It is a preflight, not a second build: a build here would re-prove the
    // train's own CI and would put the promotion's cost back up.
    expect(job, "preflight builds something").not.toContain("pnpm install");
  });

  // The parity fact, reported on every promotion. It is no longer fatal — the
  // dispatch makes it harmless — and it is still said out loud, because a
  // silent mechanism is one edit away from being a silent trap again.
  //
  // The file list is asserted exactly. Widening it to the whole directory would
  // make a train that touched `ci.yml` look like a promotion problem, which is
  // the "do not change these files" convention #326 rejects; narrowing it would
  // stop describing what the run actually executes.
  it("reports which workflow files this run resolved from the old main", () => {
    const job = code(jobBlock(promote, "preflight"));
    expect(job).toContain("RUN_SHA: ${{ github.sha }}");
    expect(job).toContain("::notice title=The train changed the workflow files this run resolved::");
    expect(job).toContain("::notice title=The workflow files match the train::");
    const executed = /executed=\(([^)]*)\)/.exec(job);
    expect(executed, "preflight names no executed workflow set").not.toBeNull();
    expect(executed[1].trim().split(/\s+/).sort()).toEqual([
      ".github/workflows/container-image.yml",
      ".github/workflows/promote.yml",
      ".github/workflows/release.yml",
    ]);
  });

  // The cap on the wait, and the job that carries it. A wait that outlives its
  // own job, or a job whose timeout fires first, both turn a *successful* slow
  // release into a stranded promotion: the step exits non-zero and
  // `release-line` and `retire-train` are skipped for a release that published
  // everything. The old `uses:` shape had no aggregate wall-clock cap at all,
  // so this is a failure mode the change introduced and has to carry.
  //
  // Asserted as a relationship rather than as two literals: what has to hold is
  // that the deadline fires first — so this step's message, which names the run
  // and the runbook, is what an operator reads instead of GitHub's bare
  // execution-time error — and that the ceiling is generous enough that a
  // queued macOS runner cannot reach it.
  it("waits inside the job that carries the wait, and not up to its edge", () => {
    const block = jobBlock(promote, "release");
    const timeout = /^ {4}timeout-minutes: (\d+)$/m.exec(block);
    expect(timeout, "the release job declares no timeout").not.toBeNull();
    const deadline = /SECONDS \+ (\d+)/.exec(code(block));
    expect(deadline, "the wait has no deadline").not.toBeNull();
    const timeoutSeconds = Number(timeout[1]) * 60;
    const deadlineSeconds = Number(deadline[1]);
    expect(deadlineSeconds, "the wait outlives its own job").toBeLessThan(timeoutSeconds);
    expect(
      timeoutSeconds - deadlineSeconds,
      "the wait leaves no room for its own error message",
    ).toBeGreaterThanOrEqual(300);
    // Four hours is already past any plausible release; six is GitHub's own
    // ceiling for a job. A number below this is one a queued macOS runner can
    // reach, and reaching it strands a promotion that succeeded.
    expect(timeoutSeconds, "the release wait is capped below a plausible release").toBeGreaterThanOrEqual(
      4 * 60 * 60,
    );
    // And the timeout is not reported as a failed release, because it is not
    // one — the run may still publish everything.
    expect(code(block)).toContain("::error title=The release outlived this job's wait::");
    expect(code(block)).toContain("**The release has not failed**");
  });

  // The recovery, and where it lives. A promotion that stops after `advance`
  // cannot be re-run from the top by design, so the way back is a document —
  // and a document nobody can find is not a recovery. It is asserted to sit
  // inside § "Cutting a release", which is the chapter an operator is already
  // reading when it happens.
  it("writes the half-run recovery down beside Cutting a release", () => {
    const heading = "### When a promotion half-runs";
    expect(runbook, "docs/ci-cd.md has no half-run recovery").toContain(heading);
    const chapter = runbook.slice(
      runbook.indexOf("\n## Cutting a release"),
      runbook.indexOf("\n## ", runbook.indexOf("\n## Cutting a release") + 1),
    );
    expect(chapter, "the recovery is not inside § Cutting a release").toContain(heading);

    const section = runbook.slice(runbook.indexOf(heading));
    const recovery = section.slice(0, section.indexOf("\n### ", 1));
    // The four things the recovery has to answer.
    expect(recovery, "does not say what is safe to re-run").toMatch(
      /gh workflow run release\.yml[^\n]*--ref/,
    );
    expect(recovery, "does not say an npm version number is burned").toMatch(/npm version number/i);
    expect(recovery, "does not say how to finish a promotion whose tag already moved").toContain(
      "git push origin --delete",
    );
    expect(recovery, "does not name the release line").toContain("refs/heads/$line");
    // Re-running the retire step is the normal thing to do, and `ls-remote`
    // answers empty once the branch is gone. Without this arm the ancestry
    // check errors into the failure branch and tells an operator that work is
    // at risk when there is nothing left to do.
    expect(recovery, "the retire step misreports an already-retired train").toContain(
      'if [[ -z "$tip" ]]; then',
    );
    expect(recovery).toContain("already retired");
    // And the caveat that the guarantee arrives one promotion late. A promotion
    // runs the default branch's workflow files as they stood when the run was
    // created, so the promotion that ships this change still runs the shape it
    // removes. Harmless, and invisible unless it is written down.
    expect(recovery, "does not say the first promotion after this still runs the old shape").toContain(
      "first promotion after this change",
    );
    // And the workflows point at it rather than leaving it to be found.
    expect(code(promote), "promote.yml does not name the recovery").toContain(
      "When a promotion half-runs",
    );
  });
});
