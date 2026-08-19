import { defineConfig } from "vitest/config";
import * as os from "node:os";
import path from "node:path";

// How many test files may run at once.
//
// Issue #257 §3: the Panel suite fails two to four files in a full run that
// pass in isolation, all with `Test timed out in 5000ms` — vitest's default
// per-test budget. There is nothing slow about those tests. There are 142 files
// fanning out across every core the machine has, and the heavy ones
// (`src/server/panel-link/**` boots a real Core in-process and pairs it over a
// websocket) end up bidding for CPU against every jsdom render in the suite.
//
// This MUST be the top-level `maxWorkers`. `test.poolOptions` was *removed* in
// Vitest 4 and this repo pins 4.1.6: the old shape is accepted, logs a
// ` DEPRECATED ` banner, and then runs completely unconstrained. Measured on a
// clean 4.1.6 project, six files each sleeping 1.5s:
//
//   no limit                                  1.84s   6 files at once
//   poolOptions: { threads: { maxThreads } }  1.71s   6 at once — IGNORED
//   maxWorkers: 1, minWorkers: 1             10.03s   serialised
//
// Re-measured on the real Panel suite, ten-core developer machine under load,
// unconstrained forced with `VITEST_MAX_WORKERS=10`:
//
//   unconstrained   4 runs, 4 red   3-4 files, 3-9 tests   tests 132.7s / 49.9s wall
//   maxWorkers=4    5 runs, 3 red*  1-2 files, 0-4 tests   tests  55.0s / 56.5s wall
//
//   * two of the five were fully green, 142 files / 1441 tests.
//
// So the cap is a large, real improvement and it is now actually engaged — the
// aggregate in-test time more than halves, which is the contention going away.
// It is NOT a fix: this suite still goes red under load, so #257 §3's "0 failed
// on three consecutive runs" is not met and is being carved out to its own
// ticket rather than reported as delivered. Wall clock is a wash — the earlier
// claim that the constrained run was *faster* was taken with the CLI flag on an
// idle machine and did not survive re-measurement.
//
// The ceiling only bites above four. A CI runner with two or four cores keeps
// exactly the parallelism it already had — the Panel suite was green there —
// so this costs nothing in CI.
const cpus = os.availableParallelism?.() ?? os.cpus().length;
const maxWorkers = Math.max(2, Math.min(4, cpus));

export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` too: a component whose whole point is what it renders is best
    // tested by rendering it.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Top-level and pool-agnostic: `test.poolOptions` was *removed* in Vitest 4
    // — the pinned 4.1.6 accepts it, logs a ` DEPRECATED ` banner and then runs
    // completely unconstrained. See the measurement above.
    maxWorkers,
    minWorkers: 1,
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "@actana/sdk": path.resolve(__dirname, "../sdk/src"),
      "@actana/shared": path.resolve(__dirname, "../shared/src"),
      // Test-only: the core-link suites drive the Panel's client against the
      // real Core server rather than a hand-rolled stand-in.
      "@actana/core": path.resolve(__dirname, "../core/src"),
    },
  },
});
