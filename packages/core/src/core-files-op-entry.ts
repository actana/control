// Bundle entry of the Files API helper (`dist/core-files-op.cjs`, issue 557).
// The daemon starts it through `asCore`, once per request; see `core-files-helper-client.ts`.

import { runCoreFilesOpMain } from "./core-files-op-main";

// Logging goes through `console.log`, which is stdout, and stdout is the answer.
console.log = console.info = (...args: unknown[]) => console.error(...args);

runCoreFilesOpMain({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`core-files-op: crashed: ${String(err)}\n`);
    process.exitCode = 70;
  },
);
