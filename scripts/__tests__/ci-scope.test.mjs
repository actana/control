// What each pull request level runs (#842).
//
// A Task pull request into a Feature branch `feat/x.y.z-<area>` runs lint only:
// Conventions, Lint, and the two cheap gates (Train rules, Promotion gate). A
// Feature pull request into `feat/x.y.z`, a release pull request into `beta/*`,
// a promotion into `main` and every push run everything, as before. A draft into
// `feat/x.y.z` or `beta/*` is parked: its heavy jobs wait for `ready_for_review`.
//
// Like `integration-branch-push.test.mjs`, nothing here re-states the workflow:
// it runs `ci.yml`'s own `scope` script under bash and evaluates each job's own
// `if:` against the outputs, so an edit that changes an answer fails here.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

const stripComments = (block) =>
  block
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/** Every job key in `ci.yml`, in file order. */
const jobNames = () => {
  const jobs = ci.slice(ci.indexOf("\njobs:\n"));
  return [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
};

/** One job block, from its key up to the next job at the same indent. */
const jobBlock = (name) => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
};

const jobIf = (name) => jobBlock(name).match(/^ {4}if: (.+)$/m)?.[1].trim() ?? null;
const jobNeeds = (name) => jobBlock(name).match(/^ {4}needs: (.+)$/m)?.[1].trim() ?? null;

/** A job `if:` for one event and one `scope` answer; `cancelled()` is false. */
const evaluate = (expr, github, scope) => {
  if (expr === null) return true;
  const js = expr
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/ == /g, " === ")
    .replace(/ != /g, " !== ");
  expect(js, `unsupported construct in: ${expr}`).toMatch(/^[\w.()',/\s!&|=-]+$/);
  const needs = { scope: { outputs: scope } };
  return Boolean(
    new Function("github", "needs", "startsWith", "cancelled", `return (${js});`)(
      github,
      needs,
      (s, p) => String(s).startsWith(p),
      () => false,
    ),
  );
};

/** The `run:` script of one named step, dedented back to column zero. */
const stepScript = (stepName) => {
  const marker = `- name: ${stepName}\n`;
  const at = ci.indexOf(marker);
  expect(at, `no step named ${JSON.stringify(stepName)}`).toBeGreaterThan(-1);
  const rest = ci.slice(at + marker.length);
  const body = rest.slice(rest.indexOf("run: |\n") + "run: |\n".length);
  const indent = body.match(/^ */)[0].length;
  const lines = [];
  for (const line of body.split("\n")) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
};

/** Run the `scope` job's script for one event, and read its outputs back. */
const scopeOf = ({ event = "pull_request", base = "", draft = "" }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-ci-scope-"));
  try {
    const output = path.join(dir, "output");
    fs.writeFileSync(output, "");
    const run = spawnSync("bash", ["-c", stepScript("Work out the scope")], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, EVENT_NAME: event, BASE: base, DRAFT: draft },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    return Object.fromEntries(
      fs
        .readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("=")),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Every job is one of these, so a new job has to be placed on purpose. */
const LIGHT = ["conventions", "train-rules", "promotion-gate", "lint"];
const HEAVY = [
  "typecheck",
  "unit-tests",
  "dependency-audit",
  "secret-scan",
  "panel-e2e",
  "panel-postgres",
  "core-shared-seaweedfs",
  "core-tarball-smoke",
];
// Reached through `needs:` on a heavy job, so skipped with it.
const DOWNSTREAM = { "installer-e2e": "core-tarball-smoke" };
// Never skipped for a level: they resolve to `pass` instead (ADR 0023 D33).
const IMAGE = ["pr-image-mode", "panel-image", "core-image"];
const TRAIN = ["train-versions", "train-tags", "panel-image-train", "core-image-train"];

const GATE = "${{ !cancelled() && needs.scope.outputs.lint_only != 'true' && needs.scope.outputs.parked != 'true' }}";

const pr = { event_name: "pull_request", ref: "refs/pull/842/merge" };

describe("the scope job's answer, per base (#842)", () => {
  it.each([
    ["feat/0.5.2-ci-images", "false"],
    ["feat/0.5.2-ci-images", "true"],
    ["feat/0.5.2-housekeeping", "false"],
    ["feat/10.20.30-x", "false"],
  ])("a pull request into the Feature branch %s (draft %s) is lint-only", (base, draft) => {
    expect(scopeOf({ base, draft })).toEqual({ lint_only: "true", parked: "false" });
  });

  it.each([
    ["feat/0.5.2", "a Feature pull request"],
    ["beta/0.5.2", "a release pull request"],
    ["beta/0.5.2-f1", "a pull request into a sub-beta"],
    ["main", "a promotion pull request"],
    ["release/0.5", "a pull request into a release line"],
    ["feat/553-adopt-actana-client", "an old ticket branch, which is not a Feature branch"],
    ["feat/multi-connection-core", "an old named feature branch"],
    ["feat/0.5", "a two-part version"],
  ])("a ready pull request into %s runs everything: %s", (base) => {
    expect(scopeOf({ base, draft: "false" })).toEqual({ lint_only: "false", parked: "false" });
  });

  it.each(["feat/0.5.2", "beta/0.5.2", "beta/0.5.2-f1"])("a draft into %s is parked", (base) => {
    expect(scopeOf({ base, draft: "true" })).toEqual({ lint_only: "false", parked: "true" });
  });

  it("does not park a draft promotion pull request, or a draft into an old feature branch", () => {
    for (const base of ["main", "feat/multi-connection-core", "release/0.5"]) {
      expect(scopeOf({ base, draft: "true" }), base).toEqual({ lint_only: "false", parked: "false" });
    }
  });

  it("runs everything on a push or a dispatch, whatever the ref", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      expect(scopeOf({ event }), event).toEqual({ lint_only: "false", parked: "false" });
    }
  });

  it("reads the payload alone: no checkout, no gh, no permissions", () => {
    const job = jobBlock("scope");
    expect(job).toMatch(/^ {4}permissions: \{\}$/m);
    expect(job).not.toMatch(/actions\/checkout|\bgh\b|curl/);
    expect(job).toContain("continue-on-error: true");
    expect(jobIf("scope")).toBeNull();
    expect(jobNeeds("scope")).toBeNull();
  });
});

describe("which jobs each level reaches (#842)", () => {
  it("places every job in ci.yml in exactly one group", () => {
    const placed = ["scope", ...LIGHT, ...HEAVY, ...Object.keys(DOWNSTREAM), ...IMAGE, ...TRAIN];
    expect(new Set(placed).size).toBe(placed.length);
    expect([...jobNames()].sort()).toEqual([...placed].sort());
  });

  it("gates every heavy job on scope, with the one shared condition", () => {
    for (const job of HEAVY) {
      expect(jobNeeds(job), job).toBe("scope");
      expect(jobIf(job), job).toBe(GATE);
    }
    for (const [job, parent] of Object.entries(DOWNSTREAM)) {
      expect(jobNeeds(job), job).toBe(parent);
      expect(HEAVY).toContain(parent);
    }
  });

  it("runs only Conventions, Lint, Train rules and Promotion gate on a Task pull request", () => {
    const lint = { lint_only: "true", parked: "false" };
    for (const job of LIGHT) {
      expect(jobNeeds(job), `${job} must not wait on scope`).toBeNull();
      expect(evaluate(jobIf(job), pr, lint), job).toBe(true);
    }
    for (const job of HEAVY) expect(evaluate(jobIf(job), pr, lint), job).toBe(false);
  });

  it("runs every heavy job on a ready Feature, release or promotion pull request", () => {
    const full = { lint_only: "false", parked: "false" };
    for (const job of [...LIGHT, ...HEAVY, ...IMAGE]) expect(evaluate(jobIf(job), pr, full), job).toBe(true);
  });

  it("holds the heavy jobs of a parked draft, and keeps the light ones", () => {
    const parked = { lint_only: "false", parked: "true" };
    for (const job of HEAVY) expect(evaluate(jobIf(job), pr, parked), job).toBe(false);
    for (const job of LIGHT) expect(evaluate(jobIf(job), pr, parked), job).toBe(true);
  });

  it("fails open: when scope wrote nothing, every heavy job runs", () => {
    for (const job of HEAVY) expect(evaluate(jobIf(job), pr, {}), job).toBe(true);
  });

  it("never skips the image checks for a level: they report through pr-image-mode's pass", () => {
    const lint = { lint_only: "true", parked: "false" };
    for (const job of IMAGE) {
      expect(jobIf(job), job).toMatch(/^\$\{\{ !cancelled\(\) && \(/);
      expect(evaluate(jobIf(job), pr, lint), job).toBe(true);
    }
    expect(jobNeeds("pr-image-mode")).toBe("scope");
    expect(jobBlock("pr-image-mode")).toContain("LINT_ONLY: ${{ needs.scope.outputs.lint_only }}");
  });
});

describe("task/<issue>-<slug> branches (#842)", () => {
  const branch = (name) =>
    spawnSync("sh", [path.join(repoRoot, "scripts/check-conventions.sh"), "branch", name], {
      cwd: repoRoot,
      encoding: "utf8",
    });

  it("passes Conventions for a Task branch", () => {
    for (const name of ["task/842-lean-ci", "task/825-fix-ci-images"]) {
      const run = branch(name);
      expect(run.status, `${name}: ${run.stderr}`).toBe(0);
    }
  });

  it("still holds a Task branch to the kebab-case shape", () => {
    for (const name of ["task/842_Lean", "task/", "task/842--lean", "tasks/842-lean-ci"]) {
      expect(branch(name).status, name).toBe(1);
    }
  });

  it("is a head Train rules accepts", () => {
    const pattern = stripComments(ci).match(/PATTERN='([^']+)'/)[1];
    expect(new RegExp(pattern.replaceAll("\\/", "/")).test("task/842-lean-ci")).toBe(true);
  });
});

describe("the Feature-branch ruleset (#842)", () => {
  const ruleset = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/rulesets/feature.json"), "utf8"));

  it("covers release and Feature branches alike", () => {
    expect(ruleset.conditions.ref_name.include).toEqual(["refs/heads/feat/*.*.*"]);
  });

  it("requires no check a Task pull request skips", () => {
    const required = [...JSON.stringify(ruleset).matchAll(/"context":"([^"]+)"/g)].map((m) => m[1]);
    const light = LIGHT.map((job) => jobBlock(job).match(/^ {4}name: (.+)$/m)[1].trim());
    for (const context of required) expect(light, context).toContain(context);
  });
});
