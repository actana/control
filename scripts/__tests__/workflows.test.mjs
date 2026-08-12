// The workflow inventory, asserted rather than eyeballed.
//
// ADR 0016 D34 collapses nine workflow files into three entry points plus one
// reusable workflow, and #51's done-condition is literally "verified by `ls
// .github/workflows`". A directory listing is not a check, so this is: a tenth
// file added next year — or `stale.yml` quietly restored — fails here instead
// of being noticed by whoever happens to look.
//
// **D34's count is now five entry points**, and both revisions were deliberate:
//
//   ci.yml           gates every pull request, and publishes the train's image
//                    on every push to `beta/**` (ADR 0023 D41)
//   release.yml      the tarballs, the images and the GitHub Release — entered
//                    by `workflow_call` or a dispatch, never by a tag (D40)
//   promote.yml      the fifth file, and the only thing that advances `main`:
//                    pause, verify the digest, fast-forward, tag, release
//                    (ADR 0023, amending D34)
//   housekeeping.yml everything on a clock and nothing that gates
//   landing.yml      the fourth file: `landing/` to the CDN behind
//                    control.actana.ai (docs/landing-page.md §7)
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
  it("is five entry points plus one reusable workflow — nothing else", () => {
    expect(fs.readdirSync(workflowDir).sort()).toEqual([
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

  it("calls the reusable build from every path that builds an image", () => {
    for (const file of ["ci.yml", "release.yml"]) {
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

  // D40. The tag trigger is gone and its absence is load-bearing: promote.yml
  // calls this workflow *and* pushes the tag, so a `push: tags` trigger would
  // fire a second run — one that would not even serialise against the first,
  // because the two resolve `github.ref_name` differently.
  it("has no tag trigger, takes a workflow_call, and keeps its dispatch", () => {
    expect(body).not.toMatch(/^ {2}push:$/m);
    expect(body).not.toMatch(/^ {6}- "v\*"$/m);
    expect(body).toMatch(/^ {2}workflow_call:$/m);
    expect(body).toMatch(/^ {2}workflow_dispatch:$/m);
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

  it("runs stale daily and everything else weekly", () => {
    expect(jobBlock(source, "stale")).toContain(DAILY);
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
  it.each(["dev-audit", "harness-canary", "release-detector"])(
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

// ADR 0023 D3, as amended by #152 — the five manifests, and the wiring that
// makes asserting them non-vacuous.
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
// count. `packages/sdk` is the fifth (#152, ADR 0025); the sixth fails here.
describe("the five-manifest version assertion (ADR 0023 D3, amended by #152)", () => {
  const MANIFESTS = [
    "package.json",
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

  it("compares all five manifests inside that job", () => {
    const job = code(jobBlock(read("ci.yml"), "train-rules"));
    for (const manifest of MANIFESTS) {
      expect(job, `${manifest} is not asserted`).toContain(manifest);
    }
    // The set is checked before the versions are, so a manifest that vanishes
    // or a package that is added cannot shrink the loop silently.
    expect(job).toContain("assert_manifest_set");
    expect(job).toMatch(/for file in packages\/\*\/package\.json/);
  });

  it("writes all five in the cut, which is where the versions come from", () => {
    const job = code(jobBlock(read("promote.yml"), "next-train"));
    const files = /files=\(([^)]*)\)/.exec(job);
    expect(files, "no files=() array in the cut").not.toBeNull();
    expect(files[1].trim().split(/\s+/).sort()).toEqual([...MANIFESTS].sort());
  });
});
