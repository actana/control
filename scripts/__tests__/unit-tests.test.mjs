// The properties #257 asks for, asserted rather than trusted.
//
// The ticket's guiding criterion is behavioural — "a red `Unit Tests` run names
// every package that failed, and never hides one behind another" — and the way
// it was broken was a shell chain nobody read closely. So the chain is gone and
// the properties that replaced it are pinned here: every package is a stage,
// no stage can be skipped, a failure is never swallowed, and the report names
// the packages that failed.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEAK_PREFIXES,
  MIN_FREE_BYTES,
  MIN_FREE_INODES,
  STAGES,
  countByPrefix,
  diskHeadroom,
  exitCodeFor,
  failedStages,
  isLeakedName,
  SUSPICIOUS_DROP_BYTES,
  diskVerdict,
  isProcessAlive,
  leftoverReport,
  sandboxPid,
  staleSandboxes,
  renderAnnotations,
  renderJobSummary,
  renderReport,
  sandboxPath,
  stageCommand,
  stagePrefix,
  stripAnsi,
  summaryLine,
} from "../lib/unit-tests.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** A stage result, as `run-unit-tests.mjs` would have built it. */
function result(label, ok, summary = null, exitCode = ok ? 0 : 1) {
  return { id: label, label, ok, exitCode, summary, durationMs: 1234 };
}

describe("the stage list", () => {
  it("covers every workspace package — a sixth package cannot be silently untested", () => {
    const onDisk = fs
      .readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const staged = STAGES.filter((stage) => stage.kind === "package")
      .map((stage) => stage.dir)
      .sort();
    expect(staged).toEqual(onDisk);
  });

  it("names each package the way its package.json does", () => {
    for (const stage of STAGES.filter((s) => s.kind === "package")) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "packages", stage.dir, "package.json"), "utf8"),
      );
      expect(manifest.name).toBe(stage.pkg);
      // Every package must actually have the script the stage invokes,
      // otherwise the stage is a no-op that reports green.
      expect(manifest.scripts?.test).toBeTruthy();
    }
  });

  it("runs the root suite as well as the packages", () => {
    expect(STAGES.filter((stage) => stage.kind === "root")).toHaveLength(1);
    expect(STAGES[0].id).toBe("root");
  });

  it("keeps the topological order a reader of the old logs will recognise", () => {
    expect(STAGES.map((stage) => stage.id)).toEqual(["root", "sdk", "shared", "cli", "core", "panel"]);
  });
});

describe("the commands the stages run", () => {
  it("drives one package at a time, so there is no recursive run to bail out of", () => {
    for (const stage of STAGES.filter((s) => s.kind === "package")) {
      const { command, args } = stageCommand(stage);
      expect(command).toBe("pnpm");
      expect(args).toEqual(["-C", `packages/${stage.dir}`, "run", "test"]);
      // `-r` is the bail itself. `--filter` is subtler and was measured: it
      // routes a single package through the recursive runner too, and prints
      // `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL]` when that package fails — the
      // one string #257 requires a red log never to contain.
      expect(args).not.toContain("-r");
      expect(args).not.toContain("--recursive");
      expect(args).not.toContain("--filter");
    }
  });

  it("runs the root suite through the repo's own vitest", () => {
    const { command, args } = stageCommand(STAGES[0]);
    expect([command, ...args].join(" ")).toBe("pnpm exec vitest run");
  });

  it("reproduces the `packages/<dir> test:` prefix the acceptance criteria grep for", () => {
    const core = STAGES.find((stage) => stage.id === "core");
    expect(stagePrefix(core)).toBe("packages/core test: ");
    expect(stagePrefix(STAGES[0])).toBe("");
  });
});

describe("reading a run's verdict", () => {
  it("finds vitest's summary line under ANSI colour", () => {
    const coloured = `\u001b[32m Test Files \u001b[39m 1 failed | 29 passed (30)\n`;
    expect(summaryLine(coloured)).toBe("Test Files  1 failed | 29 passed (30)");
  });

  it("says nothing rather than guessing when a stage never got that far", () => {
    expect(summaryLine("Error: Cannot find module\n")).toBeNull();
    expect(summaryLine(undefined)).toBeNull();
  });

  it("leaves ordinary text alone", () => {
    expect(stripAnsi("packages/cli test: ok")).toBe("packages/cli test: ok");
  });
});

describe("the exit code", () => {
  it("is non-zero when any stage failed, wherever it sat in the order", () => {
    const stages = STAGES.map((stage) => result(stage.label, true));
    for (let index = 0; index < stages.length; index += 1) {
      const mixed = stages.map((entry, i) => (i === index ? result(entry.label, false) : entry));
      expect(exitCodeFor(mixed)).toBe(1);
    }
  });

  it("is zero only when every stage passed", () => {
    expect(exitCodeFor(STAGES.map((stage) => result(stage.label, true)))).toBe(0);
  });

  it("does not buy readability with a swallowed failure", () => {
    // The failing stage is the first one; four green stages follow it. The
    // old chain would not have run them; the new runner must run them *and*
    // still go red.
    const results = [result("root suite", false, "Test Files  1 failed (16)"), ...STAGES.slice(1).map((s) => result(s.label, true))];
    expect(results).toHaveLength(STAGES.length);
    expect(exitCodeFor(results)).toBe(1);
  });
});

describe("the report a reviewer reads", () => {
  const mixed = [
    result("root suite", true, "Test Files  16 passed (16)"),
    result("packages/sdk", true, "Test Files  12 passed (12)"),
    result("packages/shared", true, "Test Files  9 passed (9)"),
    result("packages/cli", false, "Test Files  1 failed | 29 passed | 1 skipped (31)"),
    result("packages/core", true, "Test Files  60 passed (60)"),
    result("packages/panel", false, "Test Files  2 failed | 140 passed (142)"),
  ];

  it("names every stage, including the ones that passed", () => {
    const report = renderReport(mixed);
    for (const stage of STAGES) expect(report).toContain(stage.label);
  });

  it("answers 'which packages failed' without a re-run", () => {
    const report = renderReport(mixed);
    expect(report).toContain("2 of 6 stages FAILED: packages/cli, packages/panel");
  });

  it("carries each stage's Test Files line, so 'did panel run at all' has an answer", () => {
    const report = renderReport(mixed);
    expect(report).toContain("Test Files  2 failed | 140 passed (142)");
    expect(report).toContain("Test Files  60 passed (60)");
  });

  it("says so plainly when everything passed", () => {
    expect(renderReport(mixed.map((entry) => ({ ...entry, ok: true, exitCode: 0 })))).toContain(
      "All 6 stages passed.",
    );
  });

  it("raises an annotation per failing package, named", () => {
    const annotations = renderAnnotations(mixed);
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toContain("::error title=Unit Tests — packages/cli failed::");
    expect(annotations[0]).toContain("Test Files  1 failed | 29 passed | 1 skipped (31)");
    expect(annotations[1]).toContain("packages/panel");
  });

  it("raises no annotation on a green run", () => {
    expect(renderAnnotations(mixed.map((entry) => ({ ...entry, ok: true })))).toEqual([]);
  });

  it("puts a row per stage in the job summary, so the run page names them too", () => {
    const summary = renderJobSummary(mixed);
    for (const stage of STAGES) expect(summary).toContain(`| ${stage.label} |`);
    expect(summary).toContain("**2 of 6 stages failed:** packages/cli, packages/panel");
  });

  it("keeps each summary row to four columns — vitest's line is full of pipes", () => {
    const rows = renderJobSummary(mixed)
      .split("\n")
      .filter((line) => line.startsWith("| "));
    for (const row of rows) {
      expect(row.replace(/\\\|/g, "").split("|").filter(Boolean)).toHaveLength(4);
    }
    expect(renderJobSummary(mixed)).toContain("1 failed \\| 29 passed \\| 1 skipped (31)");
  });

  it("still lists the failures when the machine was the cause", () => {
    const disk = { exhausted: true, message: "/tmp: 12.0 MiB free — BELOW the floor this job needs" };
    expect(renderReport(mixed, { disk })).toContain("DISK:");
    expect(renderAnnotations(mixed, { disk })[0]).toContain("out of disk");
    expect(failedStages(mixed)).toHaveLength(2);
  });
});

describe("the disk verdict, over a whole run", () => {
  const gib = 1024 * 1024 * 1024;
  const reading = (freeBytes, extra = {}) => ({
    target: "/tmp",
    freeBytes,
    freeInodes: 1_000_000,
    exhausted: false,
    unknown: false,
    message: `/tmp: ${freeBytes / gib} GiB free`,
    ...extra,
  });

  it("says nothing when the run started and ended with room", () => {
    const verdict = diskVerdict(reading(40 * gib), reading(39 * gib));
    expect(verdict.ok).toBe(true);
    expect(verdict.lines).toEqual([]);
  });

  it("says DISK when a run that started healthy exhausted the disk while running", () => {
    // The realistic incident: 40 GiB at preflight, nothing left by the time
    // the Panel suite is done. The preflight reading alone calls this healthy.
    const before = reading(40 * gib);
    const after = reading(0.2 * gib, { exhausted: true, message: "/tmp: 205 MiB free — BELOW the floor" });
    const verdict = diskVerdict(before, after);

    expect(verdict.exhausted).toBe(true);
    expect(verdict.lines.join("\n")).toContain("EXHAUSTED the disk while it ran");
    expect(renderReport([], { disk: before, diskAfter: after })).toContain("DISK:");
    expect(renderAnnotations([], { disk: before, diskAfter: after })[0]).toContain("out of disk");
    expect(renderJobSummary([], { disk: before, diskAfter: after })).toContain("ran out of disk");
  });

  it("says DISK when the run ate more space than a test run plausibly could", () => {
    // Never crossed the floor, so no reading is `exhausted` — but a unit test
    // run whose net footprint is megabytes did not legitimately spend 20 GiB.
    const before = reading(60 * gib);
    const after = reading(40 * gib);
    const verdict = diskVerdict(before, after);

    expect(verdict.exhausted).toBe(false);
    expect(verdict.drained).toBe(true);
    expect(verdict.droppedBytes).toBeGreaterThan(SUSPICIOUS_DROP_BYTES);
    expect(renderReport([], { disk: before, diskAfter: after })).toContain("DISK:");
    expect(renderAnnotations([], { disk: before, diskAfter: after })[0]).toContain("drained the disk");
  });

  it("does not cry drain over a run that used an ordinary amount of space", () => {
    expect(diskVerdict(reading(40 * gib), reading(39.5 * gib)).drained).toBe(false);
  });

  it("degrades to the preflight reading alone rather than inventing a verdict", () => {
    const before = reading(0.2 * gib, { exhausted: true, message: "/tmp: 205 MiB free — BELOW the floor" });
    const verdict = diskVerdict(before, null);
    expect(verdict.exhausted).toBe(true);
    expect(verdict.drained).toBe(false);
    expect(renderReport([], { disk: before })).toContain("DISK:");
  });

  it("stays quiet when a reading could not be taken at all", () => {
    const unknown = { target: "/tmp", ok: true, exhausted: false, unknown: true, message: "unknown" };
    expect(diskVerdict(unknown, unknown).ok).toBe(true);
  });
});

describe("sweeping sandboxes a killed run left behind", () => {
  it("recognises its own sandbox names and nothing else", () => {
    expect(sandboxPid("act-testrun-4321")).toBe(4321);
    expect(sandboxPid("mc-core-db-AbCd12")).toBeNull();
    expect(sandboxPid("act-testrun-not-a-pid")).toBeNull();
  });

  it("collects sandboxes whose owning process is gone", () => {
    const stale = staleSandboxes("/tmp", {
      readdir: () => ["act-testrun-11", "act-testrun-22", "mc-something", "unrelated"],
      alive: () => false,
      self: 99,
    });
    expect(stale).toEqual(["act-testrun-11", "act-testrun-22"]);
  });

  it("never touches a concurrent run's sandbox — that would be the worse bug", () => {
    const stale = staleSandboxes("/tmp", {
      readdir: () => ["act-testrun-11", "act-testrun-22"],
      alive: (pid) => pid === 22,
      self: 99,
    });
    expect(stale).toEqual(["act-testrun-11"]);
  });

  it("never removes the sandbox of the run doing the sweeping", () => {
    const stale = staleSandboxes("/tmp", {
      readdir: () => ["act-testrun-99"],
      alive: () => false,
      self: 99,
    });
    expect(stale).toEqual([]);
  });

  it("treats a directory it cannot read as nothing to sweep", () => {
    expect(
      staleSandboxes("/nope", {
        readdir: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual([]);
  });

  it("counts a process it may not signal as alive, not as stale", () => {
    const alive = isProcessAlive(1, {
      kill: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    expect(alive).toBe(true);
  });
});

describe("the disk preflight", () => {
  const gib = 1024 * 1024 * 1024;
  const statfs = (freeBytes, freeInodes = 1_000_000) => () => ({
    bsize: 4096,
    bavail: freeBytes / 4096,
    ffree: freeInodes,
  });

  it("passes a machine with room", () => {
    const headroom = diskHeadroom("/tmp", { statfs: statfs(40 * gib) });
    expect(headroom.ok).toBe(true);
    expect(headroom.exhausted).toBe(false);
    expect(headroom.message).toContain("/tmp");
    expect(headroom.message).toContain("40.0 GiB free");
  });

  it("fails a machine below the byte floor, and says the word", () => {
    const headroom = diskHeadroom("/tmp", { statfs: statfs(MIN_FREE_BYTES - 4096) });
    expect(headroom.exhausted).toBe(true);
    expect(headroom.message).toContain("BELOW the floor");
  });

  it("fails on inodes too — mkdtemp runs out of those long before bytes", () => {
    const headroom = diskHeadroom("/tmp", { statfs: statfs(40 * gib, MIN_FREE_INODES - 1) });
    expect(headroom.exhausted).toBe(true);
  });

  it("warns without blocking when space is tight but sufficient", () => {
    const headroom = diskHeadroom("/tmp", { statfs: statfs(2 * gib) });
    expect(headroom.ok).toBe(true);
    expect(headroom.tight).toBe(true);
    expect(headroom.message).toContain("tight, but proceeding");
  });

  it("never blocks a run because it could not read the filesystem", () => {
    const headroom = diskHeadroom("/nope", {
      statfs: () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
    });
    expect(headroom.ok).toBe(true);
    expect(headroom.unknown).toBe(true);
  });
});

describe("the temp sandbox and the leak check", () => {
  it("names a sandbox that cannot itself be mistaken for a leak", () => {
    const sandbox = path.basename(sandboxPath("/tmp", 4242));
    expect(isLeakedName(sandbox)).toBe(false);
    for (const prefix of LEAK_PREFIXES) expect(sandbox.startsWith(prefix)).toBe(false);
  });

  it("greps for exactly the prefixes the ticket names", () => {
    expect(LEAK_PREFIXES).toEqual(["mc-", "actana-"]);
    expect(isLeakedName("mc-core-db-boot-Ab12Cd")).toBe(true);
    expect(isLeakedName("actana-cursor-Xy99Zz")).toBe(true);
    expect(isLeakedName("vitest-pool-1")).toBe(false);
  });

  it("counts the real temp root as unchanged when nothing escaped the sandbox", () => {
    const before = ["mc-old-AAAAAA", "actana-old-BBBBBB"];
    const report = leftoverReport({ before, after: before, stranded: ["mc-ut-CCCCCC"] });
    expect(report.escaped).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.message).toContain("no mc-*/actana-* directories were left in the real temp root");
  });

  it("fails, and names them, when a directory ignored TMPDIR", () => {
    const report = leftoverReport({
      before: ["mc-old-AAAAAA"],
      after: ["mc-old-AAAAAA", "mc-hardcoded-DDDDDD", "actana-hardcoded-EEEEEE"],
    });
    expect(report.ok).toBe(false);
    expect(report.escaped).toEqual(["mc-hardcoded-DDDDDD", "actana-hardcoded-EEEEEE"]);
    const annotation = renderAnnotations([], { leftovers: report })[0];
    expect(annotation).toContain("mc-hardcoded-DDDDDD");
    expect(annotation).toContain("actana-hardcoded-EEEEEE");
  });

  it("attributes stranded directories to the prefix their call site chose", () => {
    expect(
      countByPrefix(["mc-ut-AAAAAA", "mc-ut-BBBBBB", "mc-core-db-boot-CCCCCC"]),
    ).toEqual([
      ["mc-ut-", 2],
      ["mc-core-db-boot-", 1],
    ]);
  });
});

describe("the wiring that makes any of this run", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

  it("points `pnpm test` at the runner, with no chain left to short-circuit", () => {
    expect(manifest.scripts.test).toBe("node scripts/run-unit-tests.mjs");
    expect(manifest.scripts.test).not.toContain("&&");
    expect(manifest.scripts.test).not.toContain("pnpm -r");
  });

  it("leaves no `pnpm -r test` anywhere to reintroduce the bail", () => {
    for (const script of Object.values(manifest.scripts)) {
      expect(script).not.toMatch(/pnpm\s+-r\s+test/);
    }
  });

  it("still runs `pnpm test` from the Unit Tests job, under its unchanged name", () => {
    // Renaming a required status check makes every open pull request
    // unmergeable, so the job keeps the name the ruleset knows it by.
    expect(workflow).toContain("    name: Unit Tests\n");
    const job = workflow.slice(workflow.indexOf("  unit-tests:"), workflow.indexOf("  lint:"));
    expect(job).toContain("- run: pnpm test");
  });

  it("checks for leaked temp directories even when the suites went red", () => {
    const job = workflow.slice(workflow.indexOf("  unit-tests:"), workflow.indexOf("  lint:"));
    expect(job).toContain("No temp directories survived the job");
    // Without `if: always()` the check is skipped on exactly the runs whose
    // disk pressure is worth knowing about.
    expect(job).toMatch(/name: No temp directories survived the job\n\s+if: always\(\)/);
    expect(job).toContain("ls -d /tmp/mc-* /tmp/actana-*");
  });
});
