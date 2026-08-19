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
// Measured on a ten-core developer machine, on the branch this was written:
//
//   default (10 workers)   4 files failed, 9 tests failed, 43.7s
//   --maxWorkers=4         0 failed, 1441 passed,          30.9s
//
// The constrained run is not only green, it is *faster* — past four workers
// these suites were spending more time contending than testing. So the fix is
// a ceiling and not a raised timeout: #257 is explicit that a blanket
// `testTimeout` would paper over the failures rather than explain them, and
// nothing here needed more time once it stopped queueing for a core.
//
// The ceiling only bites above four. A CI runner with two or four cores keeps
// exactly the parallelism it already had — the Panel suite was green there —
// so this costs nothing in CI and fixes the machines where it was red.
const cpus = os.availableParallelism?.() ?? os.cpus().length;
const maxThreads = Math.max(2, Math.min(4, cpus));

export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` too: a component whose whole point is what it renders is best
    // tested by rendering it.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    poolOptions: {
      threads: { maxThreads, minThreads: 1 },
    },
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
