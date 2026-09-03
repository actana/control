// The train-name vocabulary, executed rather than eyeballed (ADR 0023 D46).
//
// A train's name is read in five places, in three workflows and one script,
// and every one of them is a bash guard embedded in YAML. Sub-beta trains
// (`beta/x.y.z-fN`, D46) widened four of those guards and deliberately did not
// widen the fifth — `promote.yml` refuses a sub-beta rather than accepting it —
// so what has to hold is a set of *behaviours*, not a set of regex literals:
//
//   1. A sub-beta is a train wherever a train is a legitimate thing to be:
//      the branch-name convention, a pull request's base, the push that
//      publishes a train image, a beta cut.
//   2. A sub-beta is **not** a thing that promotes, in either of the two
//      places a promotion can be started, and the refusal names the merge-back
//      rather than leaving the reader to infer it.
//   3. A fourth dot is still refused everywhere. `beta/0.4.5.1` is the shape
//      D46 exists to *not* be, because it is not semver: npm, the
//      version-agreement checker and the publish rehearsal all reject it, so a
//      guard that admitted it would move the failure downstream of a cut.
//   4. A plain train behaves exactly as it did before D46 — including the
//      strings that reach a registry, which D46 must not have touched.
//
// Grepping the YAML for a widened pattern would assert none of that: it would
// pass for a pattern widened to `-[0-9A-Za-z.-]+`, which admits `-rc.1` (D30)
// and `-beta` (ADR 0036 C1) and collides with both. So the guards are pulled
// out of the workflow files and **run**, the way
// `scripts/__tests__/promotion-gate.test.mjs` runs the real gate script.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflowDir = path.join(repoRoot, ".github/workflows");
const read = (file) => fs.readFileSync(path.join(workflowDir, file), "utf8");

/**
 * The `run:` script of one named step, dedented back to column zero.
 *
 * The seam this cuts on is the step's `name:` line and the `run: |` block
 * scalar under it, which is the shape every guard below is written in. A step
 * renamed out from under this fails loudly here rather than silently testing
 * nothing, because `expect` is what finds the block.
 */
function stepScript(source, stepName) {
  const marker = `- name: ${stepName}\n`;
  const at = source.indexOf(marker);
  expect(at, `no step named ${JSON.stringify(stepName)}`).toBeGreaterThan(-1);
  const rest = source.slice(at + marker.length);
  const run = rest.indexOf("run: |\n");
  expect(run, `${stepName} has no \`run: |\` block`).toBeGreaterThan(-1);
  const body = rest.slice(run + "run: |\n".length);
  const lines = [];
  const indent = body.match(/^ */)[0].length;
  for (const line of body.split("\n")) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
}

/**
 * The `run:` script of a job's first step, for the steps keyed by `id:` rather
 * than named — `train-tags` is one, and its whole body is the guard.
 */
function jobScript(source, jobName) {
  const start = source.indexOf(`\n  ${jobName}:`);
  expect(start, `no ${jobName} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const block = next === -1 ? rest : rest.slice(0, next);
  const run = block.indexOf("run: |\n");
  expect(run, `${jobName} has no \`run: |\` block`).toBeGreaterThan(-1);
  const body = block.slice(run + "run: |\n".length);
  const indent = body.match(/^ */)[0].length;
  const lines = [];
  for (const line of body.split("\n")) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
}

/** A script cut short at the first line matching `stop` — see each caller. */
const upTo = (script, stop) => script.slice(0, script.search(stop));

/** A workflow region, dedented from the ten columns a step's `run:` sits at. */
const region = (source, from, to) => {
  const at = source.indexOf(from);
  expect(at, `${JSON.stringify(from)} moved`).toBeGreaterThan(-1);
  const end = to === null ? source.length : source.indexOf(to, at);
  expect(end, `${JSON.stringify(to)} moved`).toBeGreaterThan(-1);
  return source
    .slice(at, end)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
};

/** Run a bash snippet with `set -euo pipefail`'s environment and no network. */
function run(script, env = {}) {
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "train-name-")), "out");
  fs.writeFileSync(summary, "");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: summary, ...env },
  });
  expect(result.error, "the guard did not run").toBeUndefined();
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    summary: fs.readFileSync(summary, "utf8"),
  };
}

// ── the four names every case below is asked about ───────────────────────────
//
// One plain train, two sub-betas of it (single- and multi-digit N, because
// `-f10` is where a `-f[0-9]` that forgot its `+` stops working), and the
// fourth-dot shape D46 refuses.
const PLAIN = "beta/0.4.5";
const SUB = "beta/0.4.5-f1";
const SUB_WIDE = "beta/0.4.5-f12";
const FOURTH_DOT = "beta/0.4.5.1";
// Prereleases that are legal semver and are *not* train names: a backport
// candidate (D30) and a published beta (ADR 0036 C1). D46 widened the guards by
// exactly `-f[0-9]+`, and these are what "exactly" means.
const NOT_TRAINS = ["beta/0.4.5-rc.1", "beta/0.4.5-beta", "beta/0.4.5-f", "beta/0.4.5-fx"];

describe("the branch-name convention (ci.yml Conventions, ADR 0023 D1, D46)", () => {
  const guard = stepScript(read("ci.yml"), "Check branch name");

  const check = (branch) => run(guard, { BRANCH: branch });

  it("accepts a plain train, unchanged by D46", () => {
    const { status, out } = check(PLAIN);
    expect(status).toBe(0);
    expect(out).toContain("release train");
  });

  it("accepts a sub-beta train, at one digit and at two", () => {
    for (const branch of [SUB, SUB_WIDE]) {
      const { status, out } = check(branch);
      expect(status, `${branch} was refused`).toBe(0);
      expect(out).toContain("release train");
    }
  });

  it("still refuses a fourth dot", () => {
    // The one shape D46's rationale turns on. `0.4.5.1` is not semver, so a
    // train named that would break the six manifests, the version-agreement
    // check and the publish rehearsal — and it would break them after the cut.
    expect(check(FOURTH_DOT).status, `${FOURTH_DOT} was accepted`).toBe(1);
  });

  it("refuses every other prerelease shape — the widening is -fN and nothing more", () => {
    for (const branch of NOT_TRAINS) {
      expect(check(branch).status, `${branch} was accepted as a train`).toBe(1);
    }
  });

  it("still refuses a branch that is neither a train nor the convention", () => {
    expect(check("Feature/Thing").status).toBe(1);
    expect(check("beta/not-a-version").status).toBe(1);
  });

  it("still accepts the ordinary convention and bot branches", () => {
    expect(check("ci/sub-beta-fix-trains").status).toBe(0);
    expect(check("dependabot/npm_and_yarn/vitest-4.1.6").status).toBe(0);
  });
});

describe("the promotion dispatch (promote.yml pause, ADR 0023 D46)", () => {
  // The pause's announce step is self-contained bash — a regex, a parameter
  // expansion and two writes — so the whole of it runs here.
  const guard = stepScript(read("promote.yml"), "Announce what a reviewer just approved");

  const dispatch = (train) => run(guard, { TRAIN: train, ACTOR: "someone" });

  it("accepts a plain train, unchanged by D46", () => {
    const { status, out } = dispatch(PLAIN);
    expect(status).toBe(0);
    expect(out).toContain("Promotion approved");
  });

  it("refuses a sub-beta rather than stripping its suffix", () => {
    for (const train of [SUB, SUB_WIDE]) {
      const { status, out } = dispatch(train);
      expect(status, `${train} was allowed to promote`).toBe(1);
      expect(out).toContain("A sub-beta train does not promote");
      // The refusal is only useful if it names the way out, and the way out is
      // the merge-back — not a retry, and not a flag.
      expect(out).toContain(PLAIN);
      expect(out).toContain("ADR 0023 D46");
    }
  });

  it("says why the suffix is not simply stripped", () => {
    // Stripping is the edit that looks right and is worse than wrong: it would
    // verify the plain train's `beta-0.4.5` image against the sub-beta's head
    // SHA (D16). Whoever next reads this refusal should not have to rediscover
    // that, so the reason travels with it.
    const { out } = dispatch(SUB);
    expect(out).toContain("beta-0.4.5-f1");
    expect(out).toContain("D16");
  });

  it("still refuses a fourth dot and every non-train shape", () => {
    for (const train of [FOURTH_DOT, ...NOT_TRAINS, "main", "beta/"]) {
      expect(dispatch(train).status, `${train} was allowed to promote`).toBe(1);
    }
  });

  it("publishes the version off the branch name, with no suffix to carry", () => {
    // The property the refusal protects: `version` is the branch name minus
    // `beta/` and nothing else, and it becomes `vx.y.z`. There is nowhere in
    // this file a `-fN` could be dropped, which is why the drop is a refusal.
    // Read off the run summary, which is where the announcement writes the
    // version it resolved rather than the input it was handed.
    const { summary } = dispatch(PLAIN);
    expect(summary).toContain("Promoting `beta/0.4.5` → `0.4.5`");
    expect(summary, "a suffix reaching the published version").not.toMatch(/-f\d/);
  });
});

describe("the train image tag (ci.yml train-tags, ADR 0023 D12, D46)", () => {
  // `train-tags` has one step, keyed by `id:` and unnamed, and that step is
  // the whole guard: the regex, and the four outputs derived from the branch.
  const guard = jobScript(read("ci.yml"), "train-tags");

  /** The guard's `$GITHUB_OUTPUT`, which is what the image jobs consume. */
  const outputs = (branch) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "train-tags-")), "out");
    fs.writeFileSync(file, "");
    const result = spawnSync("bash", ["-c", guard], {
      encoding: "utf8",
      cwd: repoRoot,
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: file, BRANCH: branch, SHA: "0123456789abcdef" },
    });
    return { status: result.status, out: fs.readFileSync(file, "utf8") };
  };

  it("gives a plain train exactly the tags it had before D46", () => {
    const { status, out } = outputs(PLAIN);
    expect(status).toBe(0);
    expect(out).toContain("version=0.4.5\n");
    expect(out).toContain("tags=beta-0.4.5\n");
    expect(out).toContain("stage=beta-0.4.5\n");
  });

  it("gives a sub-beta its own moving tag, not the plain train's", () => {
    // The reason D46 keeps the suffix here and drops it everywhere else: two
    // branches of one line are two commits, and one `beta-0.4.5` between them
    // would mean the digest D16 verifies is whichever pushed last.
    const { status, out } = outputs(SUB);
    expect(status).toBe(0);
    expect(out).toContain("tags=beta-0.4.5-f1\n");
    expect(out).toContain("stage=beta-0.4.5-f1\n");
    expect(out, "a sub-beta must not publish the plain train's tag").not.toContain(
      "tags=beta-0.4.5\n",
    );
  });

  it("still refuses a fourth dot and every non-train shape", () => {
    for (const branch of [FOURTH_DOT, ...NOT_TRAINS]) {
      expect(outputs(branch).status, `${branch} resolved a tag`).toBe(1);
    }
  });
});

describe("the beta cut's train input (beta-release.yml resolve, ADR 0036 C1, ADR 0023 D46)", () => {
  // Everything from the resolve step's first line up to its first `git` call
  // is pure bash: the two regexes, the line derivation and the concatenation
  // C1 governs. That is the whole of what D46 touched in this file, and it is
  // the whole of what runs here.
  const guard = upTo(
    region(read("beta-release.yml"), 'train="$INPUT_TRAIN"', null),
    /^\s*tip="\$\(git /m,
  );
  // Echo what the rest of the file consumes, so the assertions below are about
  // values rather than about the absence of an error.
  const cut = (train) =>
    run(`${guard}\necho "VERSION=$version LINE=$line BETA=$beta_version TAG=$tag"`, {
      INPUT_TRAIN: train,
      RUN_REF: train,
      RUN_SHA: "0123456789abcdef",
    });

  it("cuts a plain train exactly as it did before D46", () => {
    const { status, out } = cut(PLAIN);
    expect(status).toBe(0);
    expect(out).toContain("VERSION=0.4.5 LINE=0.4.5 BETA=0.4.5-beta TAG=v0.4.5-beta");
  });

  it("cuts a sub-beta as a beta of the line, with no suffix on anything published", () => {
    // C1 is not widened by D46 and this is where that is decided: the beta
    // string is built from `line`, so it is `0.4.5-beta` from either branch,
    // and the C1 assertion under it is untouched.
    const { status, out } = cut(SUB);
    expect(status).toBe(0);
    expect(out).toContain("LINE=0.4.5 BETA=0.4.5-beta TAG=v0.4.5-beta");
    // `version` keeps the suffix, and only reaches `beta-$version` — the
    // train's own image tag, which is per branch by D12.
    expect(out).toContain("VERSION=0.4.5-f1");
  });

  it("still refuses a fourth dot and every non-train shape", () => {
    for (const train of [FOURTH_DOT, ...NOT_TRAINS]) {
      expect(cut(train).status, `${train} was cut`).toBe(1);
    }
  });
});

describe("the survivor filter (promote.yml resolve, ADR 0023 D23, D24, D46)", () => {
  // The hotfix condition, in isolation. D24 rebases and force-pushes whatever
  // this list holds, so a sub-beta counted here would make every ordinary
  // promotion force-push over a branch whose work is already on `main`.
  const filter = region(read("promote.yml"), 'survivors="$(grep -Fvx', "survivor_count=");

  const survivorsOf = (train, branches) => {
    const { status, out } = run(
      `set -euo pipefail\nTRAIN="${train}"\nall_trains="${branches.join("\\n")}"\n` +
        `all_trains="$(printf '%b' "$all_trains")"\n${filter}\nprintf '%s' "$survivors"`,
    );
    expect(status).toBe(0);
    return out.split("\n").filter(Boolean);
  };

  it("drops the promoting train's own sub-betas", () => {
    expect(survivorsOf(PLAIN, [PLAIN, SUB, SUB_WIDE])).toEqual([]);
  });

  it("keeps a genuinely surviving train, sub-betas and all (D2, D22)", () => {
    // A hotfix train is another line and is still a survivor — including its
    // own sub-betas, which are branches D2 has just stranded along with it.
    expect(survivorsOf(PLAIN, [PLAIN, SUB, "beta/0.4.6", "beta/0.4.6-f1"])).toEqual([
      "beta/0.4.6",
      "beta/0.4.6-f1",
    ]);
  });

  it("treats the dots as dots, so a lookalike branch is not silently dropped", () => {
    // The same trap the `-Fvx` above was written for, one filter later: an
    // unescaped `.` would make `beta/0x4x5-f1` match and vanish, and a
    // stranded train would go unrebased with nothing to say so (D24).
    expect(survivorsOf(PLAIN, [PLAIN, "beta/0x4x5-f1"])).toEqual(["beta/0x4x5-f1"]);
  });

  it("is unchanged for a promotion with no sub-beta anywhere", () => {
    expect(survivorsOf(PLAIN, [PLAIN])).toEqual([]);
    expect(survivorsOf(PLAIN, [PLAIN, "beta/0.4.6"])).toEqual(["beta/0.4.6"]);
  });
});
