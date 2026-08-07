// The workflow inventory, asserted rather than eyeballed.
//
// ADR 0016 D34 collapses nine workflow files into three entry points plus one
// reusable workflow, and #51's done-condition is literally "verified by `ls
// .github/workflows`". A directory listing is not a check, so this is: a tenth
// file added next year — or `stale.yml` quietly restored — fails here instead
// of being noticed by whoever happens to look.
//
// D34's count is now **four** entry points. `landing.yml` deploys `landing/`
// to the CDN behind control.actana.ai (docs/landing-page.md §7), and it could
// not be folded into `ci.yml` behind a path filter: `ci.yml` is in the "Protect
// main" ruleset's required checks, and a required check whose workflow is
// filtered out of a run stays Pending forever, blocking every PR that does not
// touch the filtered path. So the deploy is its own file — a deliberate
// revision of the count, not the drift this test exists to catch.
//
// It also pins the parts of `housekeeping.yml` that are load-bearing but
// invisible in a green run: the cron a job is gated on, and the fact that the
// two non-hermetic chores open an issue rather than failing a build (D38).

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

describe("the workflow inventory (ADR 0016 D34)", () => {
  it("is four entry points plus one reusable workflow — nothing else", () => {
    expect(fs.readdirSync(workflowDir).sort()).toEqual([
      "ci.yml",
      "container-image.yml",
      "housekeeping.yml",
      "landing.yml",
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

  it("keeps container-image.yml reusable rather than a fourth entry point", () => {
    const source = read("container-image.yml");
    expect(source).toMatch(/^on:\n {2}workflow_call:/m);
    // No trigger of its own — `on:` holds workflow_call and nothing beside it.
    expect(source).not.toMatch(/^ {2}(?:push|pull_request|schedule|workflow_dispatch):/m);
  });

  it("calls the reusable build from every path that builds an image", () => {
    for (const file of ["ci.yml", "release.yml", "housekeeping.yml"]) {
      expect(read(file)).toContain("uses: ./.github/workflows/container-image.yml");
    }
  });
});

// The macOS cost posture (decision #14) and the approval gate (D28, as
// amended) are both invisible in a green run: a release that quietly built its
// mac tarball without waiting for a person looks exactly like one that waited,
// and a macOS runner that crept into the PR path looks exactly like a slow PR
// until the bill arrives. Both are one deleted line away, so both are pinned.
describe("the macOS release leg (ADR 0016 D28, as amended)", () => {
  const source = read("release.yml");

  it("builds mac-arm64 behind the macos-release environment", () => {
    const job = jobBlock(source, "tarball-macos");
    expect(job).toContain("environment: macos-release");
    expect(job).toMatch(/runs-on: macos-/);
    expect(job).toContain("TARGET: mac-arm64");
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

  // The reason this matters more than the ordering it looks like: pushing an
  // image is not undoable, and `:latest` is a pointer with no history. A
  // reviewer who rejects on a Gatekeeper blocker has to be able to believe
  // nothing shipped, and that is only true while every publishing job sits
  // downstream of the approval. `descriptions` is covered transitively — it
  // needs `[panel, core]`.
  it("publishes no image until that leg is approved", () => {
    for (const image of ["panel", "core"]) {
      const job = jobBlock(source, image);
      expect(job, `${image} publishes ahead of the approval`).toMatch(
        /needs: \[[^\]]*tarball-macos[^\]]*\]/,
      );
      expect(job).toContain("push: true");
    }
    expect(jobBlock(source, "descriptions")).toMatch(/needs: \[[^\]]*panel[^\]]*\]/);
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

describe("housekeeping.yml", () => {
  const source = read("housekeeping.yml");

  // The daily one is stale.yml's own cron, carried across unchanged; the
  // weekly one is Monday, which is D10's cadence for the rebuild.
  const DAILY = "17 3 * * *";
  const WEEKLY = "0 7 * * 1";

  it("carries exactly the two crons the chores are split across", () => {
    const crons = [...source.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
    expect(crons).toEqual([DAILY, WEEKLY]);
  });

  it("runs stale daily and everything else weekly", () => {
    expect(jobBlock(source, "stale")).toContain(DAILY);
    for (const job of ["base-pins", "release-ref", "dev-audit", "harness-canary"]) {
      expect(jobBlock(source, job), `${job} is not on the weekly cron`).toContain(WEEKLY);
    }
  });

  // D10: the rebuild is what makes the digest pin honest, so it has to rebuild
  // the *released* image and republish its tags — a build that pushes nothing
  // proves the base still builds and ships none of the fixes it collected.
  it("rebuilds and republishes the released Core image", () => {
    const job = jobBlock(source, "core-rebuild");
    expect(job).toContain("uses: ./.github/workflows/container-image.yml");
    expect(job).toContain("image: core");
    expect(job).toContain("push: true");
    expect(job).toMatch(/tags: \$\{\{ needs\.release-ref\.outputs\.tags \}\}/);
  });

  // D37 and D38. Both of these are red for reasons no PR author caused and no
  // PR author can fix, so the output is an issue, not a failed build.
  it.each(["dev-audit", "harness-canary"])("opens an issue rather than gating (%s)", (name) => {
    const job = jobBlock(source, name);
    expect(job).toContain("issues: write");
    expect(job).toContain("gh issue create");
  });

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
