// The `-dev` tag sweep's decisions (ADR 0023 D45, and D38 — *the
// delete-capable credential*).
//
// This is a destructive unattended cron against a registry with no undelete,
// and — because Docker Hub personal access tokens carry an account-wide
// permission level rather than a repository list — the allowlist in
// `dev-tag-sweep.mjs` is the *only* thing standing between it and
// `actana/panel`. So the guard is tested first and hardest, including the case
// that matters: a release repository handed to it by name.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_AGE_DAYS,
  SWEEPABLE_REPOSITORIES,
  assertSweepable,
  classifyTag,
  decideTag,
  formatPlan,
  planSweep,
  yearMonthOf,
} from "../lib/dev-tag-sweep.mjs";

const NOW = new Date("2026-08-07T00:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const open = (...numbers) => new Set(numbers);

describe("the repository guard", () => {
  it("is exactly the two -dev repositories", () => {
    expect(SWEEPABLE_REPOSITORIES).toEqual(["panel-dev", "core-dev"]);
  });

  it("admits each of them", () => {
    for (const repository of SWEEPABLE_REPOSITORIES) {
      expect(assertSweepable(repository)).toBe(repository);
    }
  });

  // The case the whole guard exists for. The cleanup token can delete these.
  it.each(["panel", "core"])("refuses a release repository (%s)", (repository) => {
    expect(() => assertSweepable(repository)).toThrow(/refusing to sweep '.*'/);
  });

  // No globs, no prefixes. `panel-dev` on the list must not make `panel`
  // reachable, and a `panel-dev-old` typo must not be reachable either.
  it.each(["panel-dev-old", "panel-de", "PANEL-DEV", "panel-dev ", "../panel", ""])(
    "refuses a near-miss on the name (%s)",
    (repository) => {
      expect(() => assertSweepable(repository)).toThrow();
    },
  );

  it("refuses a non-string repository", () => {
    for (const value of [undefined, null, 7, ["panel-dev"]]) {
      expect(() => assertSweepable(value)).toThrow();
    }
  });

  // A config that deletes nothing is a mistake worth fixing; a config that
  // deletes everything is an incident. Empty means stop.
  it.each([[[]], [null], [""], [{}]])("refuses an empty or unset allowlist (%s)", (allowlist) => {
    expect(() => assertSweepable("panel-dev", allowlist)).toThrow(/empty or unset/);
  });

  // Omitting the argument is the one case that does not throw, and only
  // because the fallback is the hard-coded list above — which is never empty.
  it("falls back to the hard-coded list when no allowlist is passed", () => {
    expect(assertSweepable("panel-dev")).toBe("panel-dev");
    expect(() => assertSweepable("panel")).toThrow();
  });

  it("refuses an allowlist holding anything but non-empty strings", () => {
    expect(() => assertSweepable("panel-dev", ["panel-dev", ""])).toThrow(/non-empty repository names/);
    expect(() => assertSweepable("panel-dev", ["panel-dev", null])).toThrow(/non-empty repository names/);
  });

  it("guards planSweep itself, not just the caller", () => {
    expect(() =>
      planSweep({ repository: "core", tags: [], openPullRequests: open(), now: NOW }),
    ).toThrow(/refusing to sweep 'core'/);
  });
});

describe("what a tag name is", () => {
  it("reads the PR id back out of a fixed-width month suffix", () => {
    expect(classifyTag("pr-109202608")).toEqual({
      kind: "pr-image",
      pullRequest: 109,
      yearMonth: "202608",
    });
    // Four-digit PR ids parse the same way — the suffix is what is fixed.
    expect(classifyTag("pr-1234202601")).toMatchObject({ pullRequest: 1234, yearMonth: "202601" });
  });

  it("recognises the per-architecture build scaffolding", () => {
    expect(classifyTag("pr-109-amd64")).toEqual({
      kind: "pr-scaffold",
      pullRequest: 109,
      arch: "amd64",
    });
    expect(classifyTag("pr-109-arm64")).toMatchObject({ kind: "pr-scaffold", arch: "arm64" });
  });

  it("recognises a commit pin", () => {
    expect(classifyTag("sha-a1b2c3d")).toEqual({ kind: "sha" });
  });

  // The reason the patterns are anchored regexes and not prefixes: a release
  // tag that somehow reaches a `-dev` repository must be unrecognised, and an
  // unrecognised tag is never deleted.
  it.each([
    "latest",
    "0.1.0",
    "beta-0.1.0",
    "v0.1.0",
    "pr-109",
    "pr-1092026",
    "pr-109202613",
    "pr-109-riscv64",
    "sha-",
    "sha-zzzzzzz",
    "shalom",
    "prometheus",
  ])("does not recognise %s", (name) => {
    expect(classifyTag(name)).toEqual({ kind: "unrecognised" });
  });
});

describe("what gets deleted", () => {
  const decide = (name, lastUpdated, openSet) =>
    decideTag({ name, lastUpdated }, { openPullRequests: openSet, now: NOW });

  it("deletes a PR image whose pull request is closed", () => {
    const decision = decide("pr-109202608", daysAgo(1), open(110));
    expect(decision.delete).toBe(true);
    expect(decision.reason).toMatch(/#109 is closed/);
  });

  it("keeps this month's image for a pull request still open", () => {
    expect(decide("pr-109202608", daysAgo(1), open(109)).delete).toBe(false);
  });

  // D10: a pull request open across a month boundary starts a new tag, and the
  // previous month's is dead the moment it does.
  it("deletes last month's image for a pull request open across the boundary", () => {
    const decision = decide("pr-109202607", daysAgo(10), open(109));
    expect(decision.delete).toBe(true);
    expect(decision.reason).toMatch(/202607.*202608/);
  });

  it("deletes an open pull request's image once it passes the age limit", () => {
    // Same month, still open, but untouched for longer than the threshold.
    const decision = decide("pr-109202608", daysAgo(DEFAULT_MAX_AGE_DAYS + 1), open(109));
    expect(decision.delete).toBe(true);
  });

  it("deletes scaffolding for a closed pull request and keeps a live build's", () => {
    expect(decide("pr-109-amd64", daysAgo(1), open(110)).delete).toBe(true);
    expect(decide("pr-109-amd64", daysAgo(1), open(109)).delete).toBe(false);
    expect(decide("pr-109-arm64", daysAgo(DEFAULT_MAX_AGE_DAYS + 1), open(109)).delete).toBe(true);
  });

  it("deletes a commit pin only once it is stale", () => {
    expect(decide("sha-a1b2c3d", daysAgo(DEFAULT_MAX_AGE_DAYS + 1), open()).delete).toBe(true);
    expect(decide("sha-a1b2c3d", daysAgo(DEFAULT_MAX_AGE_DAYS - 1), open()).delete).toBe(false);
  });

  it("never deletes a tag class it does not own, however old", () => {
    for (const name of ["latest", "0.1.0", "beta-0.1.0"]) {
      expect(decide(name, daysAgo(900), open()).delete).toBe(false);
    }
  });

  // An unparseable or absent timestamp is not evidence of staleness.
  it("keeps a tag whose age it cannot determine", () => {
    expect(decide("sha-a1b2c3d", null, open()).delete).toBe(false);
    expect(decide("sha-a1b2c3d", "not a date", open()).delete).toBe(false);
  });

  // "We could not list the pull requests" must never read as "they are all
  // closed" — that would sweep every review in flight in one pass.
  it("refuses to decide without the set of open pull requests", () => {
    expect(() => decideTag({ name: "pr-109202608" }, { now: NOW })).toThrow(/open pull request/);
  });

  it("honours a custom age limit", () => {
    const tag = { name: "sha-a1b2c3d", lastUpdated: daysAgo(10) };
    expect(decideTag(tag, { openPullRequests: open(), now: NOW, maxAgeDays: 5 }).delete).toBe(true);
    expect(decideTag(tag, { openPullRequests: open(), now: NOW, maxAgeDays: 30 }).delete).toBe(false);
  });
});

describe("the report", () => {
  const tags = [
    { name: "pr-109202608", lastUpdated: daysAgo(1) }, // open, this month → kept
    { name: "pr-109202607", lastUpdated: daysAgo(40) }, // last month → deleted
    { name: "pr-77-amd64", lastUpdated: daysAgo(2) }, // closed PR → deleted
    { name: "sha-a1b2c3d", lastUpdated: daysAgo(90) }, // stale pin → deleted
    { name: "sha-9999999", lastUpdated: daysAgo(2) }, // fresh pin → kept
    { name: "latest", lastUpdated: daysAgo(400) }, // not ours → kept
  ];
  const plan = planSweep({
    repository: "panel-dev",
    tags,
    openPullRequests: open(109),
    now: NOW,
  });

  it("splits the tags into what goes and what stays", () => {
    expect(plan.considered).toBe(6);
    expect(plan.deletes.map((d) => d.name).sort()).toEqual([
      "pr-109202607",
      "pr-77-amd64",
      "sha-a1b2c3d",
    ]);
    expect(plan.skips.map((d) => d.name).sort()).toEqual([
      "latest",
      "pr-109202608",
      "sha-9999999",
    ]);
  });

  // A sweep that logged only its deletions would print the same thing whether
  // it examined six tags or six hundred it never fetched.
  it("names every tag it skipped and why, not only what it deleted", () => {
    const text = formatPlan(plan);
    expect(text).toContain("6 tag(s) considered, 3 deleted, 3 kept");
    for (const tag of tags) expect(text).toContain(tag.name);
    expect(text).toContain("not a tag class this sweep owns");
  });

  it("says so when it is a dry run", () => {
    expect(formatPlan(plan, { dryRun: true })).toContain("3 would delete");
  });
});

describe("yearMonthOf", () => {
  it("is UTC and zero-padded, matching the tag the publisher writes", () => {
    expect(yearMonthOf(new Date("2026-01-31T23:59:59Z"))).toBe("202601");
    expect(yearMonthOf(new Date("2026-12-01T00:00:00Z"))).toBe("202612");
  });
});
