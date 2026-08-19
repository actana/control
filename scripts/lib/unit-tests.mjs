// What a red `Unit Tests` run has to say, and the shape that makes it say it.
//
// The job used to run one shell chain:
//
//     pnpm native:node && vitest run && pnpm -r test
//
// and both links in that chain throw information away. `&&` stops at the first
// non-zero exit, so a failure in the 16-file root suite means none of the five
// packages run at all. And `pnpm -r` bails on the first failing package by
// default, in topological order — sdk → shared → cli → core → panel — so a
// single flake in `packages/cli` means `core` and `panel` never run either.
//
// That is not a theoretical loss. Issue #257 §1 lists three runs of
// 2026-08-18 that ended on the same four lines:
//
//     packages/cli test:  Test Files  1 failed | 29 passed | 1 skipped (31)
//     [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @actana/cli@0.3.0 test: `vitest run`
//
// The sharpest was #246 — a *Panel* fix carrying 573 lines of new Panel tests,
// none of which ran, on a log with no `packages/panel test:` line in it. The
// reviewer of that pull request learned nothing about the change under review.
//
// So: every stage runs, always, and the exit codes are aggregated at the end
// rather than short-circuited on the way through. The cost on a green run is
// zero (every stage ran anyway) and on a red run it is the remaining stages'
// runtime — which is exactly the runtime you want spent, because that is the
// information currently being discarded.
//
// The stages are run one package at a time rather than with `pnpm -r
// --no-bail` on purpose. `--no-bail` would fix the bail, but the guiding
// criterion — *never hide one package behind another* — would then rest on a
// flag staying in a string. Driving the packages from here makes it a property
// of the runner: there is no bail to disable, each package's exit code is its
// own, and the report can name a failing package without parsing pnpm's
// end-of-run summary. `packages/<dir> test:` line prefixes are reproduced so
// the log reads as it always has, and so the greps in #257's acceptance
// criteria keep working.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The stages of a full `pnpm test`, in the order they run.
 *
 * `root` is the repo-level suite over `scripts/**` (vitest.config.ts); the
 * rest are the workspace packages, kept in the topological order `pnpm -r`
 * used so a familiar log stays familiar. Order is presentation only — no stage
 * can be skipped because an earlier one failed, which is the entire point.
 *
 * `unit-tests.test.mjs` asserts this list against `packages/*` on disk, so a
 * sixth package added next year fails a test here instead of silently never
 * being tested in CI.
 */
export const STAGES = [
  { id: "root", label: "root suite", kind: "root" },
  { id: "sdk", label: "packages/sdk", kind: "package", pkg: "@actana/sdk", dir: "sdk" },
  { id: "shared", label: "packages/shared", kind: "package", pkg: "@actana/shared", dir: "shared" },
  { id: "cli", label: "packages/cli", kind: "package", pkg: "@actana/cli", dir: "cli" },
  { id: "core", label: "packages/core", kind: "package", pkg: "@actana/core", dir: "core" },
  { id: "panel", label: "packages/panel", kind: "package", pkg: "@actana/panel", dir: "panel" },
];

/**
 * The command a stage runs.
 *
 * `pnpm -C <dir> run test`, and deliberately not `pnpm --filter <name> test`:
 * `--filter` goes through pnpm's *recursive* runner even for a single package,
 * and a failure there still prints
 *
 *     [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @actana/cli@0.3.3 test: `vitest run`
 *
 * — the exact line #257 asks to never see again, and one a reader would
 * reasonably take as proof the bail was still happening. `-C` runs the
 * package's own script with no recursion to bail out of, so the string is
 * structurally absent rather than suppressed by a flag.
 */
export function stageCommand(stage) {
  if (stage.kind === "root") return { command: "pnpm", args: ["exec", "vitest", "run"] };
  return { command: "pnpm", args: ["-C", `packages/${stage.dir}`, "run", "test"] };
}

/**
 * The prefix every line of a stage's output carries.
 *
 * `pnpm -r` wrote `packages/cli test: …`; the acceptance criteria in #257 are
 * written against exactly that string ("confirm the resulting red run still
 * contains `packages/core test: Test Files …`"), so it is reproduced rather
 * than improved on. The root suite is unprefixed, as it was.
 */
export function stagePrefix(stage) {
  return stage.kind === "root" ? "" : `${stage.label} test: `;
}

/** vitest's own one-line verdict, plucked back out of a stage's output. */
export function summaryLine(output) {
  const match = /^\s*Test Files\s+.*$/m.exec(stripAnsi(output ?? ""));
  return match ? match[0].trim() : null;
}

/** ANSI is fine on a terminal and noise in a job summary. */
export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * The run's exit code.
 *
 * Non-zero if *any* stage failed. Readability is bought with the remaining
 * stages' runtime, never by swallowing a failure — #257 asks for both, and a
 * green run that hid a red package would be a worse bug than the one this
 * replaces.
 */
export function exitCodeFor(results) {
  return results.some((result) => result.ok === false) ? 1 : 0;
}

/** The stages that failed, in run order. */
export function failedStages(results) {
  return results.filter((result) => result.ok === false);
}

/**
 * The block printed at the end of every run, green or red.
 *
 * This is the answer to #257's closing criterion — *take any red run and
 * answer, from the log alone, which packages failed* — so it lists every
 * stage, including the ones that passed. A report that only named failures
 * would leave "did `panel` run at all?" unanswerable, which is the question
 * that started the ticket.
 */
export function renderReport(results, { leftovers = null, disk = null } = {}) {
  const rule = "-".repeat(72);
  const lines = ["", rule, "Unit Tests — every stage, and what it did", rule];
  for (const result of results) {
    const mark = result.ok ? "PASS" : "FAIL";
    const verdict = result.ok ? "passed" : `FAILED (exit ${result.exitCode})`;
    lines.push(`${mark}  ${result.label.padEnd(16)} ${verdict}`);
    if (result.summary) lines.push(`      ${result.summary}`);
  }
  lines.push(rule);

  const failed = failedStages(results);
  if (failed.length === 0) {
    lines.push(`All ${results.length} stages passed.`);
  } else {
    lines.push(
      `${failed.length} of ${results.length} stages FAILED: ${failed.map((f) => f.label).join(", ")}`,
    );
  }

  if (disk?.exhausted) {
    lines.push("");
    lines.push("DISK: this machine was out of space during the run — see the preflight above.");
    lines.push("      Treat the failures above as unexplained until the run is repeated with headroom.");
  }
  if (leftovers?.escaped?.length) {
    lines.push("");
    lines.push(`TEMP: ${leftovers.escaped.length} directories escaped the run's sandbox — see below.`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The same verdict for GitHub's own UI.
 *
 * #257 asks that the failing packages be named "where a reviewer sees them
 * without opening the log". `::error` annotations surface on the checks tab
 * and against the pull request; the job summary renders as a table on the run
 * page. Both are cheap, so both.
 */
export function renderAnnotations(results, { leftovers = null, disk = null } = {}) {
  const lines = [];
  if (disk?.exhausted) {
    lines.push(
      `::error title=Unit Tests — out of disk::${disk.message}. ` +
        "A run that dies of disk is not a run that tells you about your code.",
    );
  }
  for (const failure of failedStages(results)) {
    const detail = failure.summary ?? `exited ${failure.exitCode}`;
    lines.push(`::error title=Unit Tests — ${failure.label} failed::${failure.label}: ${detail}`);
  }
  if (leftovers?.escaped?.length) {
    lines.push(
      `::error title=Unit Tests — temp directories leaked::${leftovers.escaped.length} ` +
        `directories survived the job outside its sandbox: ${leftovers.escaped.slice(0, 10).join(", ")}`,
    );
  }
  return lines;
}

/** The `$GITHUB_STEP_SUMMARY` table — the same facts, rendered for the run page. */
export function renderJobSummary(results, { leftovers = null, disk = null } = {}) {
  const lines = ["## Unit Tests", ""];
  const failed = failedStages(results);
  lines.push(
    failed.length === 0
      ? `All ${results.length} stages passed.`
      : `**${failed.length} of ${results.length} stages failed:** ${failed.map((f) => f.label).join(", ")}`,
  );
  lines.push("");
  lines.push("| Stage | Result | Test Files | Duration |");
  lines.push("| --- | --- | --- | --- |");
  for (const result of results) {
    const verdict = result.ok ? "passed" : `**failed** (exit ${result.exitCode})`;
    // vitest's own summary line is full of `|` separators, which would each
    // open a new column and shred the table.
    const summary = result.summary ? `\`${escapeCell(result.summary)}\`` : "—";
    lines.push(`| ${result.label} | ${verdict} | ${summary} | ${formatDuration(result.durationMs)} |`);
  }
  lines.push("");
  lines.push(
    "Every stage above ran to completion. A failing stage no longer stops the ones after it — " +
      "see [#257](https://github.com/actana/control/issues/257).",
  );
  if (disk) {
    lines.push("", "### Machine", "", `- ${disk.message}`);
    if (disk.exhausted) {
      lines.push("- **This run ran out of disk.** The failures above may be the machine, not the code.");
    }
  }
  if (leftovers) {
    lines.push("", "### Temp directories", "", `- ${leftovers.message}`);
    for (const name of leftovers.escaped.slice(0, 20)) lines.push(`  - \`${name}\``);
  }
  return lines.join("\n");
}

/** A `|` inside a markdown table cell is a column break unless it is escaped. */
export function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|");
}

function formatDuration(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

// -- Disk --------------------------------------------------------------------
//
// #257 §4 could not find the 108-failure `ENOSPC` incident the original report
// described, and says so; what it asks for is the weaker, cheaper precaution —
// "a run whose failures are caused by the machine rather than the code should
// say so". That is this: free space and inode headroom read at the start, said
// out loud, and checked against a floor before a single suite runs. A red run
// that is really a full disk should cost one glance, not a re-run.

/** Below this much free space, the suites are not worth starting. */
export const MIN_FREE_BYTES = 1024 * 1024 * 1024;
/** Below this many free inodes, likewise — `mkdtemp` fails long before bytes run out. */
export const MIN_FREE_INODES = 50_000;
/** Above the floor but below this, the run proceeds and says it is tight. */
export const TIGHT_FREE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Read one filesystem's headroom and decide whether it can carry a test run.
 *
 * `statfs` is injected so the thresholds can be tested at their edges without
 * a machine that is actually full.
 */
export function diskHeadroom(target, { statfs = fs.statfsSync } = {}) {
  let stat;
  try {
    stat = statfs(target);
  } catch (error) {
    return {
      target,
      ok: true,
      exhausted: false,
      unknown: true,
      message: `disk headroom for ${target} is unknown (${error.code ?? error.message})`,
    };
  }
  const freeBytes = stat.bavail * stat.bsize;
  const freeInodes = stat.ffree ?? Number.POSITIVE_INFINITY;
  const exhausted = freeBytes < MIN_FREE_BYTES || freeInodes < MIN_FREE_INODES;
  const tight = !exhausted && freeBytes < TIGHT_FREE_BYTES;
  const message =
    `${target}: ${formatBytes(freeBytes)} free` +
    (Number.isFinite(freeInodes) ? `, ${formatCount(freeInodes)} inodes free` : "") +
    (exhausted ? " — BELOW the floor this job needs" : tight ? " — tight, but proceeding" : "");
  return { target, freeBytes, freeInodes, ok: !exhausted, exhausted, tight, unknown: false, message };
}

export function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatCount(count) {
  return Number.isFinite(count) ? count.toLocaleString("en-US") : "many";
}

// -- Temp directories --------------------------------------------------------
//
// #257 §4's leak is real and measured: 389 stale `mc-*`/`actana-*` directories
// over eight days when the ticket was filed, 1,048 on this checkout the day it
// was implemented, 2.2G of drift. They come from dozens of distinct
// `mkdtempSync(join(tmpdir(), "mc-…"))` call sites across five packages, and
// chasing each one with an `afterEach` would be forty-odd edits that the
// forty-first call site immediately defeats.
//
// So the run gets its own temp root instead. `TMPDIR` is pointed at a per-run
// sandbox, every `os.tmpdir()` in every suite and every child process lands
// inside it, and it is removed when the run ends — pass, fail or signal. The
// count in `/tmp` is then the same before and after by construction rather
// than by everyone remembering.
//
// The sandbox is deliberately *not* named `actana-*` or `mc-*`: it must not
// match the very glob the leak check greps for.

export const SANDBOX_PREFIX = "act-testrun-";
/** The globs #257 names. A directory matching one of these in the real temp root escaped. */
export const LEAK_PREFIXES = ["mc-", "actana-"];

export function isLeakedName(name) {
  return LEAK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Every `mc-*`/`actana-*` entry directly inside `root`, sorted. */
export function leakedEntries(root, { readdir = fs.readdirSync } = {}) {
  let entries;
  try {
    entries = readdir(root);
  } catch {
    return [];
  }
  return entries.filter((name) => isLeakedName(name)).sort();
}

/**
 * What the run did to the real temp root, and what stayed behind in its own.
 *
 * `escaped` is the criterion that fails a run: a directory matching `mc-*` or
 * `actana-*` that appeared in the *real* temp root while the job ran ignored
 * `TMPDIR` — a hardcoded `/tmp/…` path, most likely — and would have drifted
 * forever. `stranded` is the softer half: suites that left directories inside
 * the sandbox. Those cost nothing once the sandbox is removed, so they are
 * reported by name and prefix to make the drift visible and attributable,
 * without turning today's forty call sites into a red train.
 */
export function leftoverReport({ before, after, stranded = [] }) {
  const seen = new Set(before);
  const escaped = after.filter((name) => !seen.has(name));
  const byPrefix = countByPrefix(stranded);
  const message = escaped.length
    ? `${escaped.length} directories escaped the run's TMPDIR sandbox into the real temp root — ` +
      "these survive the job and must be cleaned up at their source"
    : `no mc-*/actana-* directories were left in the real temp root (${stranded.length} were ` +
      "created inside the run's sandbox and removed with it)";
  return { escaped, stranded, byPrefix, message, ok: escaped.length === 0 };
}

/** `mc-core-db-boot-AbCd12` → `mc-core-db-boot-`, so a report names the call site's prefix. */
export function countByPrefix(names) {
  const counts = new Map();
  for (const name of names) {
    const prefix = name.replace(/[A-Za-z0-9]{6}$/, "");
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Where the sandbox lives, given the real temp root. */
export function sandboxPath(realTmp, pid) {
  return path.join(realTmp, `${SANDBOX_PREFIX}${pid}`);
}
