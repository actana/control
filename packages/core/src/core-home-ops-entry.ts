// Bundle entry of the `core-home-ops` helper (`dist/core-home-ops.cjs`, issue 559).
// The daemon starts it through `asCore`; see `core-home-ops-client.ts`.

import { runCoreHomeOpsMain } from "./core-home-ops-main";

// Logging goes through `console.log`, which is stdout, and stdout is the answer.
console.log = console.info = (...args: unknown[]) => console.error(...args);

runCoreHomeOpsMain({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`core-home-ops: crashed: ${String(err)}\n`);
    process.exitCode = 70;
  },
);
