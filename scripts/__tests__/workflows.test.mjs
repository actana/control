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
  // downstream of the approval.
  it("publishes no image until that leg is approved", () => {
    for (const image of ["panel", "core"]) {
      const job = jobBlock(source, image);
      expect(job, `${image} publishes ahead of the approval`).toMatch(
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

  // D33/D38. The delete-capable credential is a second secret, and it never
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
