#!/usr/bin/env node
// `pnpm test` — every stage, every time, and a report that names what failed.
//
// The rationale lives next to the logic in `lib/unit-tests.mjs`. This file is
// the driver: preflight the machine, sandbox the run's temp directory, run
// each stage to completion regardless of what the last one did, then say what
// happened — on the console, as GitHub annotations, and in the job summary.
//
// The one thing it must never do is exit zero while a stage was red.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  STAGES,
  diskHeadroom,
  exitCodeFor,
  leakedEntries,
  leftoverReport,
  renderAnnotations,
  renderJobSummary,
  renderReport,
  sandboxPath,
  stageCommand,
  stagePrefix,
  staleSandboxes,
  summaryLine,
} from "./lib/unit-tests.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const onGitHub = Boolean(process.env.GITHUB_ACTIONS);

// -- Preflight: the machine ---------------------------------------------------
//
// Read before anything runs, and printed whether or not it is a problem. #257
// §5's lesson is that the wrong diagnosis ran for six days because the log did
// not say what the machine looked like; one line at the top is the whole fix.

const realTmp = fs.realpathSync(os.tmpdir());
const disk = diskHeadroom(realTmp);
const workspaceDisk = diskHeadroom(repoRoot);

console.log("Unit Tests — machine preflight");
console.log(`  temp      ${disk.message}`);
console.log(`  workspace ${workspaceDisk.message}`);

if (disk.exhausted || workspaceDisk.exhausted) {
  const culprit = disk.exhausted ? disk : workspaceDisk;
  const message =
    `Out of disk before a single test ran — ${culprit.message}. ` +
    "This run is a machine failure, not a code failure; nothing below it would have meant anything.";
  console.error(`\nDISK: ${message}`);
  if (onGitHub) console.log(`::error title=Unit Tests — out of disk::${message}`);
  writeJobSummary(
    ["## Unit Tests", "", "**Aborted before running: the machine is out of disk.**", "", `- ${culprit.message}`].join(
      "\n",
    ),
  );
  process.exit(1);
}

// -- Preflight: the native binding --------------------------------------------
//
// Was the first link of the old `&&` chain. It stays a gate rather than a
// stage: without a loadable better-sqlite3 every suite fails for one reason,
// and five identical stack traces are not five pieces of information.

const native = await run(process.execPath, [path.join(repoRoot, "scripts", "ensure-node-sqlite.mjs")], {
  prefix: "native: ",
});
if (native.exitCode !== 0) {
  const message = "The Node better-sqlite3 binding could not be prepared — every suite would fail on it.";
  console.error(`\nNATIVE: ${message}`);
  if (onGitHub) console.log(`::error title=Unit Tests — native binding::${message}`);
  process.exit(native.exitCode || 1);
}

// -- The temp sandbox ---------------------------------------------------------

// A sandbox is removed on exit and on the three signals a process can trap.
// SIGKILL, a runner OOM and a cancelled CI job are not among them, and this
// prefix is deliberately outside the `mc-*`/`actana-*` globs the leak check
// greps for — so a survivor is drift under a name nothing would ever flag.
// One readdir at startup closes it. Live runs' sandboxes are left alone.
const stale = staleSandboxes(realTmp);
for (const name of stale) {
  try {
    fs.rmSync(path.join(realTmp, name), { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`  could not remove the stale sandbox ${name}: ${error.message}`);
  }
}
if (stale.length) console.log(`  swept     ${stale.length} sandbox(es) left by runs that were killed`);

const tmpBefore = leakedEntries(realTmp);
const sandbox = sandboxPath(realTmp, process.pid);
fs.mkdirSync(sandbox, { recursive: true });

let cleaned = false;
function removeSandbox() {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`could not remove the run's temp sandbox ${sandbox}: ${error.message}`);
  }
}
process.on("exit", removeSandbox);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    removeSandbox();
    process.exit(130);
  });
}

console.log(`  sandbox   TMPDIR=${sandbox} (removed when this run ends)`);
console.log("");

// -- The stages ---------------------------------------------------------------

const results = [];
for (const stage of STAGES) {
  const { command, args } = stageCommand(stage);
  const prefix = stagePrefix(stage);
  console.log(`>>> ${stage.label}: ${command} ${args.join(" ")}`);
  const started = performance.now();
  const outcome = await run(command, args, {
    prefix,
    env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
  });
  const durationMs = performance.now() - started;
  results.push({
    id: stage.id,
    label: stage.label,
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    summary: summaryLine(outcome.output),
    durationMs,
  });
  console.log("");
}

// -- What the run left behind -------------------------------------------------

const stranded = leakedEntries(sandbox);
const tmpAfter = leakedEntries(realTmp);
// Read again, not reused from preflight: the realistic way a job dies of disk
// is to start with 40 GiB and exhaust it during the Panel suite. A single
// preflight reading reports that run as healthy and never says `DISK:`.
const diskAfter = diskHeadroom(realTmp);
const leftovers = leftoverReport({ before: tmpBefore, after: tmpAfter, stranded });

console.log("Temp directories");
console.log(`  ${leftovers.message}`);
for (const [prefix, count] of leftovers.byPrefix.slice(0, 12)) {
  console.log(`    ${String(count).padStart(4)}  ${prefix}*`);
}
for (const name of leftovers.escaped) console.log(`  ESCAPED: ${path.join(realTmp, name)}`);

console.log("");
console.log("Disk, after the run");
console.log(`  temp      ${diskAfter.message}`);

removeSandbox();

// -- The report ---------------------------------------------------------------

console.log(renderReport(results, { leftovers, disk, diskAfter }));
if (onGitHub) {
  for (const annotation of renderAnnotations(results, { leftovers, disk, diskAfter })) console.log(annotation);
}
writeJobSummary(renderJobSummary(results, { leftovers, disk, diskAfter }));

// A leaked directory is a failure of the job, not of a package: it is reported
// on its own rather than blamed on whichever stage happened to run last.
process.exit(leftovers.ok ? exitCodeFor(results) : 1);

// -- Plumbing -----------------------------------------------------------------

/**
 * Run one command to completion, streaming its output line by line under a
 * prefix and keeping a copy so the `Test Files` line can be read back out.
 *
 * Never rejects: a stage that cannot even be spawned is a stage that failed,
 * and the run carries on to the next one.
 */
function run(command, args, { prefix = "", env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    const partial = { stdout: "", stderr: "" };

    const pump = (streamName, stream, sink) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        partial[streamName] += chunk;
        const lines = partial[streamName].split("\n");
        partial[streamName] = lines.pop() ?? "";
        for (const line of lines) sink.write(`${prefix}${line}\n`);
      });
    };
    pump("stdout", child.stdout, process.stdout);
    pump("stderr", child.stderr, process.stderr);

    child.on("error", (error) => {
      process.stderr.write(`${prefix}could not run ${command}: ${error.message}\n`);
      output += `\n${error.message}`;
      resolve({ exitCode: 1, output });
    });
    child.on("close", (code, signal) => {
      for (const [streamName, sink] of [
        ["stdout", process.stdout],
        ["stderr", process.stderr],
      ]) {
        if (partial[streamName]) sink.write(`${prefix}${partial[streamName]}\n`);
      }
      resolve({ exitCode: code ?? (signal ? 1 : 0), output });
    });
  });
}

function writeJobSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, `${markdown}\n`);
  } catch (error) {
    console.error(`could not write the job summary: ${error.message}`);
  }
}
