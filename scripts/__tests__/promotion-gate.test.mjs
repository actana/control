// The promotion gate's guard, exercised rather than eyeballed (#264).
//
// `scripts/promotion-gate.sh` is the mechanism that makes a hand merge of a
// `beta/x.y.z → main` pull request fatal instead of merely documented. Four
// documents and `promote.yml:191-193` already said the button must not be
// pressed when #259 was squash-merged on 2026-08-18; the release it destroyed
// was abandoned. So the guard is not asserted by grepping a YAML string — the
// real script is run, with the event payload's fields, and both of its
// branches are executed.
//
// Three things have to hold together, and each fails here on its own:
//
//   1. **The script refuses the one case and waves through the others.** A
//      gate pull request exits non-zero; a pull request into a train, a
//      pull request into `main` from a non-`beta/*` head, and a non-pull-request
//      event all exit zero. The third rule is criterion 6 of #264: only one
//      check may refuse a mis-targeted pull request into `main`, and it is
//      `Train rules` for ADR 0023 D1's reason, not this one.
//   2. **The refusal carries what a person needs.** D5 and D16 by name, and
//      the dispatch that is correct instead — not a link to somewhere the
//      names live.
//   3. **The check the ruleset requires is the job that runs it.** A ruleset
//      waiting on a context nothing reports is Pending forever, and a job
//      whose name drifted from the payload is exactly that. The name is read
//      out of `ci.yml` and the payload is asserted to require *it*, the same
//      way the manifest assertion is pinned in `workflows.test.mjs`, so a
//      coordinated rename stays green and a one-sided one does not.
//
// And the job carries no `if:`. ADR 0023 D33: a required check whose job is
// skipped stays Pending forever, blocking the pull request permanently —
// including the pull request that would remove the requirement. Every
// not-applicable case in this guard is an early successful exit inside the
// script, which is the property this file pins.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const GATE = path.join(repoRoot, "scripts/promotion-gate.sh");
const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

/** One job block, from its key up to the next job at the same indent. */
const jobBlock = (source, name) => {
  const start = source.indexOf(`\n  ${name}:`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

/** The real script, with the fields `ci.yml` hands it off the event payload. */
const run = (env) => {
  const result = spawnSync("bash", [GATE], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  expect(result.error, `${GATE} did not run`).toBeUndefined();
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

const gatePullRequest = {
  EVENT_NAME: "pull_request",
  BASE: "main",
  HEAD: "beta/0.3.3",
  HEAD_SHA: "d438e5ce9caacc24d47526957eeb0cf2e5d27d56",
  PR_NUMBER: "259",
};

describe("the promotion gate guard (#264, ADR 0023 D5, D16)", () => {
  it("refuses a pull request from a train into main", () => {
    const { status, out } = run(gatePullRequest);
    expect(status, "a gate pull request must fail this check").toBe(1);
    expect(out).toContain("::error title=");
  });

  it("refuses whatever the train is called, not one hard-coded version", () => {
    for (const head of ["beta/0.1.0", "beta/1.2.3", "beta/10.0.0"]) {
      const { status } = run({ ...gatePullRequest, HEAD: head });
      expect(status, `${head} → main was not refused`).toBe(1);
    }
  });

  it("names D5, D16 and the dispatch that is correct instead", () => {
    const { out } = run(gatePullRequest);
    // The names, not a link to where the names live: whoever is looking at
    // this has already demonstrated that reading the documentation first is
    // not what happens.
    expect(out).toContain("ADR 0023 D5");
    expect(out).toContain("ADR 0023 D16");
    expect(out).toMatch(/gh workflow run promote\.yml -f train=beta\/0\.3\.3/);
    // The head SHA is quoted, because D16's assertion is about that SHA and a
    // squash is precisely what changes it.
    expect(out).toContain(gatePullRequest.HEAD_SHA);
  });

  it("puts the whole refusal in the annotation, not just its first line", () => {
    const { out } = run(gatePullRequest);
    const annotation = out.split("\n").find((line) => line.startsWith("::error title="));
    expect(annotation, "no ::error annotation").toBeTruthy();
    // A literal newline would end the workflow command and leave the rest as
    // plain log text — the message would then not stand alone in the Checks
    // tab, which is the whole of criterion 2. `%0A` is how it survives.
    expect(annotation).toContain("%0A");
    for (const fragment of ["ADR 0023 D5", "ADR 0023 D16", "gh workflow run promote.yml"]) {
      expect(annotation, `the annotation drops ${fragment}`).toContain(fragment);
    }
  });

  it("writes the same refusal to the run summary when there is one", () => {
    const summary = path.join(
      fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "gate-")),
      "summary.md",
    );
    fs.writeFileSync(summary, "");
    run({ ...gatePullRequest, GITHUB_STEP_SUMMARY: summary });
    const written = fs.readFileSync(summary, "utf8");
    expect(written).toContain("ADR 0023 D5");
    expect(written).toContain("gh workflow run promote.yml -f train=beta/0.3.3");
  });

  // ADR 0023 D46. A sub-beta head into `main` is still red, and being red is
  // the point: exiting 0 here would satisfy `docs/rulesets/main.json`'s
  // required context and hand back the merge button on a pull request that
  // must never be merged — the exact failure this file exists to prevent.
  // Only the printed next step changes, because `promote.yml` refuses a
  // sub-beta dispatch and sending the reader there would be a second refusal
  // instead of an answer.
  it("stays red on a sub-beta head, and prints the merge-back instead", () => {
    const { status, out } = run({ ...gatePullRequest, HEAD: "beta/0.4.5-f1" });
    expect(status, "a sub-beta gate must fail this check too").toBe(1);
    expect(out).toContain("gh pr create --base beta/0.4.5 --head beta/0.4.5-f1");
    expect(out, "promote.yml refuses this dispatch — do not send anyone to it").not.toContain(
      "gh workflow run promote.yml -f train=beta/0.4.5-f1",
    );
    // The annotation carries it whole, the same way the plain refusal does.
    const annotation = out.split("\n").find((line) => line.startsWith("::error title="));
    expect(annotation).toContain("gh pr create --base beta/0.4.5");
  });

  it("keeps the plain train's dispatch exactly as it was", () => {
    // D46 must not have moved the instruction on the pull request that is
    // ninety-nine promotions in a hundred.
    const { out } = run({ ...gatePullRequest, HEAD: "beta/0.4.5" });
    expect(out).toContain("gh workflow run promote.yml -f train=beta/0.4.5");
    expect(out).not.toContain("gh pr create");
  });

  // Criterion 6. Everything that is not a gate pull request reaches a
  // mergeable state, and each of these is an early successful exit rather
  // than a skipped job (D33).
  it("passes a pull request into an open train", () => {
    const { status, out } = run({
      EVENT_NAME: "pull_request",
      BASE: "beta/0.3.3",
      HEAD: "feat/some-work",
    });
    expect(status).toBe(0);
    expect(out).toContain("::notice title=");
  });

  it("passes a pull request into main from a non-beta head, and says who refuses it", () => {
    const { status, out } = run({
      EVENT_NAME: "pull_request",
      BASE: "main",
      HEAD: "feat/some-work",
    });
    expect(status, "this guard must not be the thing that refuses a D1 violation").toBe(0);
    expect(out).toContain("Train rules");
  });

  it("passes on a push and on a dispatch, rather than being skipped there", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const { status, out } = run({ EVENT_NAME: event, BASE: "", HEAD: "" });
      expect(status, `${event} did not exit 0`).toBe(0);
      expect(out).toContain("::notice title=");
    }
  });
});

describe("the guard is wired to the ruleset it is required by (#264)", () => {
  const job = jobBlock(ci, "promotion-gate");

  it("runs the real script from ci.yml, so the tests above cover what CI runs", () => {
    expect(job).toContain("scripts/promotion-gate.sh");
    // The event payload's fields, by the names the script reads.
    for (const key of ["EVENT_NAME:", "BASE:", "HEAD:", "HEAD_SHA:", "PR_NUMBER:"]) {
      expect(job, `the job does not pass ${key}`).toContain(key);
    }
  });

  it("carries no job-level if:, so the check can never be Pending (ADR 0023 D33)", () => {
    // Anchored at the job's own indent: a step-level `if:` is four spaces
    // deeper and is not what D33 is about.
    expect(job).not.toMatch(/^ {4}if:/m);
  });

  it("is required on main under the name the job actually reports", () => {
    const name = /^ {4}name: (.+)$/m.exec(job);
    expect(name, "the promotion-gate job has no name:").not.toBeNull();
    const context = name[1].trim();
    // Read out of `ci.yml` and asserted against the payload, rather than
    // asserting one literal in two places: a coordinated rename of the job and
    // the ruleset is correct and stays green; renaming either alone is the
    // Pending-forever failure and fails here.
    const main = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "docs/rulesets/main.json"), "utf8"),
    );
    const checks = main.rules.find((rule) => rule.type === "required_status_checks");
    expect(checks, "main.json requires no status checks at all").toBeTruthy();
    const contexts = checks.parameters.required_status_checks.map((c) => c.context);
    expect(contexts, `docs/rulesets/main.json does not require ${context}`).toContain(context);
  });

  it("is required on main only — a train does not gate on it", () => {
    // It runs on every pull request and passes on a train, so requiring it
    // there would be harmless and pointless. Naming a context in a ruleset is
    // what locks the repository when it is wrong (ADR 0023 D38, *one check
    // name*), so the list stays as short as the guarantee needs.
    const beta = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/rulesets/beta.json"), "utf8"));
    const checks = beta.rules.find((rule) => rule.type === "required_status_checks");
    const contexts = checks?.parameters?.required_status_checks?.map((c) => c.context) ?? [];
    expect(contexts).not.toContain("Promotion gate");
  });
});
