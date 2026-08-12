// The one file that knows about `process`.
//
// Everything above it takes its side effects as arguments and returns an exit
// code (see `actana-cli.ts`), so this is where the real argv, the real
// environment, the real streams and the real Core dial get bound to it — and
// the only place `process.exit` is called.
//
// `bin/actana.mjs` loads the bundle this compiles into. That shim is the path
// npm links as the `actana` command; this is what it runs.

import { runActanaCli } from "./actana-cli.ts";
import { probeCore } from "./core-probe.ts";
import { connectCore } from "./core-connection.ts";
import { EXIT_FAILURE } from "./exit-codes.ts";
import { homedir } from "node:os";

/** Read stdin to end. Only called by a verb that was told to read it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const verbose = process.argv.includes("--verbose");

const code = await runActanaCli({
  argv: process.argv.slice(2),
  env: process.env,
  home: homedir(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  // Verbose goes to stderr so it cannot corrupt the stdout a `--json` consumer
  // is parsing, and it is a no-op rather than a filtered sink when the flag is
  // off — a disabled sink that still formats its argument is a disabled sink
  // that can still be handed something it should not have been.
  verbose: verbose ? (line) => process.stderr.write(`actana: ${line}\n`) : () => {},
  readStdin,
  stdinIsTty: Boolean(process.stdin.isTTY),
  probe: probeCore,
  connect: connectCore,
  now: () => Date.now(),
}).catch((err: unknown) => {
  // A throw that reached here is a defect, not an operator error: every
  // expected failure returns an exit code. Print the message and nothing about
  // the inputs — a stack trace from inside the blob path is one of the few ways
  // credential material could still reach a terminal.
  process.stderr.write(`actana: ${err instanceof Error ? err.message : String(err)}\n`);
  return EXIT_FAILURE;
});

process.exit(code);
