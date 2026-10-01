// A push to a release integration branch `feat/x.y.z` runs the pull-request
// verification and publishes nothing (#584, part of #552).
//
// A push trigger cannot be exercised from a pull request, so this file is the
// closest thing to running it: it evaluates the real trigger filter and every
// job's real `if:` against the events that can reach them, and runs the real
// image-mode resolver under bash. Nothing here re-states the workflow; each
// case reads its input out of `ci.yml`, so an edit that changes the answer
// fails here.
//
// What it does not do is run GitHub. The filter matcher below implements the
// documented glob semantics ("Filter pattern cheat sheet"), and the `if:`
// evaluator handles the two operators and one function these conditions use.
// A condition that grows past that fails loudly rather than evaluating wrong.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

/** One job block, from its key up to the next job at the same indent. */
const jobBlock = (name) => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

const stripComments = (block) =>
  block
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/** The job-level `if:`, or null when the job has none (it runs on every event). */
const jobIf = (name) => {
  const m = stripComments(jobBlock(name)).match(/^ {4}if: (.+)$/m);
  return m ? m[1].trim() : null;
};

/** `on.push.branches`, read as the list of quoted patterns under it. */
const pushPatterns = () => {
  const on = ci.slice(ci.indexOf("\non:\n"), ci.indexOf("\nconcurrency:"));
  const push = on.slice(on.indexOf("\n  push:\n"), on.indexOf("\n  workflow_dispatch:"));
  return [...stripComments(push).matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
};

/**
 * GitHub's branch filter, which is a glob and not a regex: `*` is any run but
 * `/`, `**` is anything, `?` is zero or one of the character before it, `+` is
 * one or more of it, `[...]` is a set, and everything else — `.` included — is
 * literal. The whole ref name must match.
 */
const filterMatches = (pattern, name) => {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?" || c === "+") re += c;
    else if (c === "[") {
      const end = pattern.indexOf("]", i);
      re += pattern.slice(i, end + 1);
      i = end;
    } else re += c.replace(/[.\\^$|(){}/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(name);
};

const triggers = (name) => pushPatterns().some((p) => filterMatches(p, name));

/** Evaluate a job `if:` for one event. Only what these conditions use is supported. */
const evaluate = (expr, github) => {
  if (expr === null) return true;
  const js = expr
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/ == /g, " === ")
    .replace(/ != /g, " !== ");
  expect(js, `unsupported construct in: ${expr}`).toMatch(
    /^[\w.()',/\s!&|=-]+$/,
  );
  const startsWith = (s, p) => String(s).startsWith(p);
  return Boolean(new Function("github", "startsWith", `return (${js});`)(github, startsWith));
};

const PUBLISHING = ["train-versions", "train-tags", "panel-image-train", "core-image-train"];
const VERIFYING = [
  "conventions",
  "promotion-gate",
  "typecheck",
  "unit-tests",
  "lint",
  "dependency-audit",
  "secret-scan",
  "panel-e2e",
  "core-tarball-smoke",
  "installer-e2e",
  "pr-image-mode",
  "panel-image",
  "core-image",
];

const events = {
  "push feat/0.5.0": { event_name: "push", ref: "refs/heads/feat/0.5.0" },
  "push beta/0.5.0": { event_name: "push", ref: "refs/heads/beta/0.5.0" },
  "pull_request": { event_name: "pull_request", ref: "refs/pull/584/merge" },
};

describe("the push trigger for integration branches (#584)", () => {
  const names = {
    match: ["feat/0.5.0", "feat/0.6.0", "feat/1.0.0", "feat/10.20.30", "beta/0.5.0", "beta/0.5.0-f1"],
    // Ticket branches are the landmine: `feat/*` would take all of them.
    noMatch: [
      "feat/553-adopt-actana-client",
      "feat/584-integration-push",
      "feat/0.5",
      "feat/0.5.0-rc1",
      "feat/0.5.0.1",
      "feat/v0.5.0",
      "feat/0.5.0/x",
      "feat/",
      "ci/584-integration-branch-push",
      "main",
    ],
  };

  it("lists the integration pattern next to the train's, and no wildcard star", () => {
    const patterns = pushPatterns();
    expect(patterns).toContain("beta/**");
    expect(patterns.filter((p) => p.startsWith("feat/"))).toEqual(["feat/[0-9]+.[0-9]+.[0-9]+"]);
  });

  it("starts a run for feat/x.y.z and for the train", () => {
    for (const name of names.match) expect(triggers(name), name).toBe(true);
  });

  it("starts no run for a ticket branch or any other name, while it does for feat/x.y.z", () => {
    // Paired with the positive case: before the trigger existed, no name
    // matched, so the negatives alone passed on any workflow.
    expect(triggers("feat/0.5.0")).toBe(true);
    for (const name of names.noMatch) expect(triggers(name), name).toBe(false);
  });

  it("still has no branch-wide feat filter that a ticket branch would satisfy", () => {
    for (const p of pushPatterns()) {
      expect(p, "a `*` after feat/ would match ticket branches").not.toMatch(/^feat\/\*/);
    }
  });

  it("keeps the concurrency group on the full ref, cancelling only its own ref's runs", () => {
    const group = ci.match(/^ {2}group: (.+)$/m)[1];
    expect(group).toContain("github.ref");
    // Two integration branches must not share a group.
    const key = (ref) =>
      group.includes("startsWith(github.ref, 'refs/heads/beta/')") && ref.startsWith("refs/heads/beta/")
        ? `ci-train-${ref}`
        : `ci-${ref}`;
    expect(key("refs/heads/feat/0.5.0")).not.toBe(key("refs/heads/feat/0.6.0"));
    expect(key("refs/heads/feat/0.5.0")).not.toBe(key("refs/heads/beta/0.5.0"));
    expect(ci).toMatch(/cancel-in-progress: \$\{\{ !startsWith\(github\.ref, 'refs\/heads\/beta\/'\) \}\}/);
  });
});

describe("which jobs a push to feat/x.y.z reaches (#584)", () => {
  it("runs every verifying job, including the real image builds", () => {
    for (const job of VERIFYING) {
      expect(evaluate(jobIf(job), events["push feat/0.5.0"]), `${job} on push feat/0.5.0`).toBe(true);
    }
  });

  it("reaches the image builds but no publishing job", () => {
    // The positive half makes this fail before the change; the negatives alone
    // would pass on any workflow that never ran a feat push.
    expect(evaluate(jobIf("panel-image"), events["push feat/0.5.0"])).toBe(true);
    for (const job of PUBLISHING) {
      expect(evaluate(jobIf(job), events["push feat/0.5.0"]), `${job} on push feat/0.5.0`).toBe(false);
    }
  });

  it("leaves Train rules to pull requests: a push has no pull request to block", () => {
    expect(evaluate(jobIf("train-rules"), events["push feat/0.5.0"])).toBe(false);
    expect(evaluate(jobIf("train-rules"), events.pull_request)).toBe(true);
  });

  it("leaves the promotion gate unconditional, and its script says not applicable", () => {
    expect(jobIf("promotion-gate")).toBeNull();
    const gate = spawnSync("bash", [path.join(repoRoot, "scripts/promotion-gate.sh")], {
      env: { PATH: process.env.PATH, EVENT_NAME: "push" },
      encoding: "utf8",
    });
    expect(gate.status).toBe(0);
    expect(gate.stdout).toContain("No merge button to guard");
  });

  it("keeps every publishing job keyed to beta/ alone", () => {
    for (const job of PUBLISHING) {
      expect(jobIf(job), job).toBe("startsWith(github.ref, 'refs/heads/beta/')");
      expect(evaluate(jobIf(job), events["push beta/0.5.0"]), `${job} on push beta/0.5.0`).toBe(true);
      expect(evaluate(jobIf(job), events.pull_request), `${job} on pull_request`).toBe(false);
    }
  });

  it("does not run the pull-request image jobs on a train push, as before", () => {
    for (const job of ["pr-image-mode", "panel-image", "core-image", "train-rules"]) {
      expect(evaluate(jobIf(job), events["push beta/0.5.0"]), `${job} on push beta/0.5.0`).toBe(false);
    }
  });

  it("leaves pull_request behaviour unchanged", () => {
    for (const job of [...VERIFYING, "train-rules"]) {
      expect(evaluate(jobIf(job), events.pull_request), `${job} on pull_request`).toBe(true);
    }
  });

  it("does not put a dispatch on a ticket branch into the image jobs, while a feat push is", () => {
    expect(evaluate(jobIf("panel-image"), events["push feat/0.5.0"])).toBe(true);
    const dispatch = { event_name: "workflow_dispatch", ref: "refs/heads/feat/553-adopt-actana-client" };
    for (const job of ["pr-image-mode", "panel-image", "core-image", "conventions", ...PUBLISHING]) {
      expect(evaluate(jobIf(job), dispatch), job).toBe(false);
    }
  });
});

/** The `run:` script of one named step, dedented back to column zero. */
const stepScript = (stepName) => {
  const marker = `- name: ${stepName}\n`;
  const at = ci.indexOf(marker);
  expect(at, `no step named ${JSON.stringify(stepName)}`).toBeGreaterThan(-1);
  const rest = ci.slice(at + marker.length);
  const run = rest.indexOf("run: |\n");
  expect(run, `${stepName} has no run block`).toBeGreaterThan(-1);
  const body = rest.slice(run + "run: |\n".length);
  const indent = body.match(/^ */)[0].length;
  const lines = [];
  for (const line of body.split("\n")) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
};

/** Run the two resolver steps the way the job does, and read the outputs back. */
const resolve = ({ env, skipResolver = false, resolverFile = null }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-image-mode-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // A push has no pull request: any `gh` call is a bug, so it records itself.
    const called = path.join(dir, "gh-called");
    fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\ntouch ${called}\nexit 1\n`, {
      mode: 0o755,
    });
    const resolved = path.join(dir, "pr-image-mode.env");
    const output = path.join(dir, "output");
    fs.writeFileSync(output, "");
    const base = {
      PATH: `${bin}:${process.env.PATH}`,
      RESOLVED: resolved,
      GITHUB_OUTPUT: output,
      MERGE_SHA: "0123456789abcdef0123456789abcdef01234567",
      REPO: "actana/control",
      // The runner sets every `env:` key, to the empty string when the payload
      // has no such field — and `set -u` in the resolver depends on it.
      PR: "",
      BASE: "",
      HEAD: "",
      HEAD_REPO: "",
      HEAD_SHA: "",
      DRAFT: "",
      CHANGED_FILES: "",
      ...env,
    };
    const run = (script) =>
      spawnSync("bash", ["-c", script], { env: base, encoding: "utf8" });
    let resolver = { status: 0, stdout: "" };
    if (resolverFile !== null) fs.writeFileSync(resolved, resolverFile);
    else if (!skipResolver) resolver = run(stepScript("Work out the mode"));
    const decide = run(stepScript("Decide"));
    const out = Object.fromEntries(
      fs
        .readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { out, resolver, decide, ghCalled: fs.existsSync(called) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const push = { EVENT_NAME: "push", REF_NAME: "feat/0.5.0", DRAFT: "" };

describe("the image-mode resolver on a push to feat/x.y.z (#584)", () => {
  it("builds for real, never the draft skip, and pushes nothing", () => {
    const { out, resolver, decide, ghCalled } = resolve({ env: push });
    expect(resolver.status, resolver.stdout).toBe(0);
    expect(decide.status).toBe(0);
    expect(out.mode).toBe("build");
    expect(out.push).toBe("false");
    expect(out.tags).toBe("");
    expect(out.dev_tags).toBe("");
    expect(out.version).toBe("");
    expect(out.ref).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(ghCalled, "a push has no pull request to ask the API about").toBe(false);
  });

  it("stages its per-arch tags under the branch, not under a pull request", () => {
    const { out } = resolve({ env: push });
    expect(out.stage).toBe("integration-feat-0.5.0");
    expect(out.stage).not.toMatch(/^pr-/);
  });

  it("does not depend on the draft flag being absent or falsy", () => {
    for (const DRAFT of ["", "false", "true"]) {
      const { out } = resolve({ env: { ...push, DRAFT } });
      expect(out.mode, `DRAFT=${JSON.stringify(DRAFT)}`).toBe("build");
    }
  });

  it("falls back to a build that publishes nothing when the resolver never finished", () => {
    const { out } = resolve({ env: push, skipResolver: true });
    expect(out.mode).toBe("build");
    expect(out.push).toBe("false");
    expect(out.stage).toBe("integration-feat-0.5.0");
  });

  it("forces push=false even if the resolver's answer says otherwise", () => {
    const { out } = resolve({
      env: push,
      resolverFile:
        "mode=build\npush=true\nstage=x\nref=abc\ntags=beta-0.5.0\ndev_tags=sha-abc\nversion=0.5.0\nwhy=test\n",
    });
    expect(out.push).toBe("false");
    expect(out.tags).toBe("");
    expect(out.dev_tags).toBe("");
  });
});

describe("the image-mode resolver on a pull request is unchanged (#584)", () => {
  const pr = {
    EVENT_NAME: "pull_request",
    REF_NAME: "584/merge",
    PR: "584",
    BASE: "feat/0.5.0",
    HEAD: "ci/584-integration-branch-push",
    HEAD_REPO: "actana/control",
    HEAD_SHA: "fedcba9876543210fedcba9876543210fedcba98",
    CHANGED_FILES: "1",
  };

  it("still resolves a draft to the pass mode, with no gh call needed", () => {
    const { out } = resolve({ env: { ...pr, DRAFT: "true" } });
    expect(out.mode).toBe("pass");
    expect(out.push).toBe("false");
    expect(out.stage).toBe("pr-584");
  });

  it("still publishes a same-repo non-draft pull request that touches code", () => {
    // The fake `gh` fails, so the file list is empty and the diff reads as code.
    const { out } = resolve({ env: { ...pr, DRAFT: "false" } });
    expect(out.mode).toBe("build");
    expect(out.push).toBe("true");
    expect(out.dev_tags).toMatch(/^pr-584\d{6}$/);
  });
});

describe("the Conventions push path (#584)", () => {
  const git = (cwd, ...args) =>
    spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

  /** Run "Lint commits in PR" in a scratch repo with a commitlint that records its arguments. */
  const lint = (event, pick) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-conv-"));
    try {
      const repo = path.join(dir, "repo");
      fs.mkdirSync(repo);
      git(repo, "init", "-q");
      const shas = [];
      for (const n of [1, 2, 3]) {
        git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", `ci: c${n}`);
        shas.push(git(repo, "rev-parse", "HEAD").stdout.trim());
      }
      const bin = path.join(dir, "tmp/commitlint/node_modules/.bin");
      fs.mkdirSync(bin, { recursive: true });
      const args = path.join(dir, "args");
      fs.writeFileSync(path.join(bin, "commitlint"), `#!/usr/bin/env bash\necho "$@" > ${args}\n`, {
        mode: 0o755,
      });
      const env = {
        PATH: process.env.PATH,
        RUNNER_TEMP: path.join(dir, "tmp"),
        GITHUB_WORKSPACE: repo,
        BASE_SHA: "",
        HEAD_SHA: "",
        BEFORE_SHA: "",
        AFTER_SHA: shas[2],
        ...pick(shas),
        ...event,
      };
      const run = spawnSync("bash", ["-c", stepScript("Lint commits in PR")], { cwd: repo, env, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      return { called: fs.readFileSync(args, "utf8").trim(), shas };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("lints the commits a push brought: before..after", () => {
    const { called, shas } = lint({ EVENT_NAME: "push" }, (s) => ({ BEFORE_SHA: s[0] }));
    expect(called).toContain(`--from ${shas[0]} --to ${shas[2]}`);
    expect(called).not.toContain("--last");
  });

  it("lints only the tip when the branch is new (all-zero before)", () => {
    const { called } = lint({ EVENT_NAME: "push" }, () => ({ BEFORE_SHA: "0".repeat(40) }));
    expect(called).toContain("--last");
    expect(called).not.toContain("--from");
  });

  it("lints only the tip when before is no longer in the clone", () => {
    const { called } = lint({ EVENT_NAME: "push" }, () => ({ BEFORE_SHA: "deadbeef".repeat(5) }));
    expect(called).toContain("--last");
    expect(called).not.toContain("--from");
  });

  it("still lints base..head on a pull request", () => {
    const { called, shas } = lint({ EVENT_NAME: "pull_request" }, (s) => ({
      BASE_SHA: s[0],
      HEAD_SHA: s[1],
    }));
    expect(called).toContain(`--from ${shas[0]} --to ${shas[1]}`);
  });
});
