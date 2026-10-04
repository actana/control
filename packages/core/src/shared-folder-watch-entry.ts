// Bundle entry of the Shared folder watcher (`dist/core-shared-watch.cjs`, #561).
// The daemon starts it through `asCore` in the container; see `shared-folder-feed.ts`.

import { runSharedWatchMain } from "./shared-folder-watch-main";

// Logging goes through `console.log`, which is stdout, and stdout is the protocol.
console.log = console.info = (...args: unknown[]) => console.error(...args);

runSharedWatchMain({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`shared-watch: crashed: ${String(err)}\n`);
    process.exitCode = 70;
  },
);
