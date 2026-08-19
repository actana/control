// The guiding property of #257, asserted by *running the driver*rather than by
// reading it.
//
// `unit-tests.test.mjs` pins the pieces — `exitCodeFor` over synthetic arrays,
// the stage list, the report's wording. None of that would catch a `break` in
// the stage loop, an `&&` creeping back into the spawn, or an early `exit`
// between two stages. Those are exactly the bugs this ticket exists because of:
// the old shell chain was wrong in a way every unit test around it still passed.
//
// So this drives the real `scripts/run-unit-tests.mjs` in a throwaway repo root
// with `pnpm` shimmed, and asks the one question that matters: when a stage
// fails, do the stages *after* it still run and still report?

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STAGES } from "../lib/unit-tests.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** A throwaway repo root: the real driver, a shimmed `pnpm`, nothing else. */
let fixture;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mc-driver-"));
  fs.mkdirSync(path.join(fixture, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "bin"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "tmp"), { recursive: true });

  // The driver and the library under test, verbatim.
  for (const file of [["run-unit-tests.mjs"], ["lib", "unit-tests.mjs"]]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", ...file), path.join(fixture, "scripts", ...file));
  }

  // The native preflight is a gate, not a stage; it is not what is under test.
  fs.writeFileSync(path.join(fixture, "scripts", "ensure-node-sqlite.mjs"), "process.exit(0);\n");

  for (const stage of STAGES.filter((s) => s.kind === "package")) {
    fs.mkdirSync(path.join(fixture, "packages", stage.dir), { recursive: true });
  }

  // `pnpm`, shimmed: it reports which stage it was asked to run and fails the
  // ones named in `FAKE_FAILING_STAGES`. Everything else about the driver —
  // the loop, the spawn, the exit-code aggregation, the report — is real.
  const shim = `#!/usr/bin/env node
const args = process.argv.slice(2);
const dirFlag = args.indexOf("-C");
const id = dirFlag === -1 ? "root" : args[dirFlag + 1].replace("packages/", "");
const failing = (process.env.FAKE_FAILING_STAGES ?? "").split(",").filter(Boolean);
if (failing.includes(id)) {
  console.log(" Test Files  1 failed | 19 passed (20)");
  process.exit(1);
}
console.log(" Test Files  20 passed (20)");
process.exit(0);
`;
  const shimPath = path.join(fixture, "bin", "pnpm");
  fs.writeFileSync(shimPath, shim);
  fs.chmodSync(shimPath, 0o755);
});

afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

/** Run the real driver against the fixture, failing the named stages. */
function driveWith(failing) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(fixture, "scripts", "run-unit-tests.mjs")], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}`,
        FAKE_FAILING_STAGES: failing.join(","),
        // Keep the sandbox and its startup sweep inside the fixture.
        TMPDIR: path.join(fixture, "tmp"),
        TEMP: path.join(fixture, "tmp"),
        TMP: path.join(fixture, "tmp"),
        GITHUB_ACTIONS: "",
        GITHUB_STEP_SUMMARY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}

describe("the driver, actually driven", () => {
  it("runs every stage and exits 0 when they all pass", async () => {
    const { exitCode, output } = await driveWith([]);
    for (const stage of STAGES) expect(output).toContain(`>>> ${stage.label}:`);
    expect(output).toContain(`All ${STAGES.length} stages passed.`);
    expect(exitCode).toBe(0);
  }, 60_000);

  it("still runs — and still reports — every stage after the first one fails", async () => {
    // `sdk` is the first package stage. Under `pnpm -r` its failure meant
    // shared, cli, core and panel never ran at all; #246 lost 573 lines of
    // Panel tests exactly this way.
    const { exitCode, output } = await driveWith(["sdk"]);

    expect(output).toContain("FAIL  packages/sdk");
    for (const stage of STAGES.filter((s) => s.id !== "sdk")) {
      expect(output).toContain(`>>> ${stage.label}:`);
      expect(output).toContain(`PASS  ${stage.label.padEnd(16)} passed`);
    }
    expect(output).toContain("1 of 6 stages FAILED: packages/sdk");
    expect(exitCode).toBe(1);
  }, 60_000);

  it("still runs every package after the root suite fails", async () => {
    // The other half of the old chain: `vitest run && pnpm -r test` meant a
    // red root suite skipped all five packages.
    const { exitCode, output } = await driveWith(["root"]);

    expect(output).toContain("FAIL  root suite");
    for (const stage of STAGES.filter((s) => s.kind === "package")) {
      expect(output).toContain(`PASS  ${stage.label.padEnd(16)} passed`);
    }
    expect(exitCode).toBe(1);
  }, 60_000);

  it("names every failing stage, not just the first", async () => {
    const { exitCode, output } = await driveWith(["sdk", "panel"]);
    expect(output).toContain("2 of 6 stages FAILED: packages/sdk, packages/panel");
    expect(exitCode).toBe(1);
  }, 60_000);

  it("never prints the recursive-run bail the ticket is named after", async () => {
    const { output } = await driveWith(["cli"]);
    expect(output).not.toContain("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL");
  }, 60_000);

  it("sweeps a sandbox left behind by a run that could not clean up after itself", async () => {
    // SIGKILL cannot be trapped, so a killed run leaves `act-testrun-<pid>`
    // under a prefix the `mc-*`/`actana-*` leak check deliberately ignores.
    const orphan = path.join(fixture, "tmp", "act-testrun-999999");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "junk"), "x");

    const { output } = await driveWith([]);
    expect(output).toContain("swept");
    expect(fs.existsSync(orphan)).toBe(false);
  }, 60_000);
});
