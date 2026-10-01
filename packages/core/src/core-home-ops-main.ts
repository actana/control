// The helper process's whole program (issue 559, PR 3): read one request, run it
// as the user this process is, print one answer. `core-home-ops-entry.ts` is the
// bundle entry that calls it; it is split out so a test can run it without
// starting a process.
//
// Exit status is the channel the daemon reads first, then stdout, and stderr is
// for a person reading `docker compose logs`:
//
//   0  the operation ran; stdout is `{"ok":true,"result":...}`
//   1  the request was fine and the operation failed; stdout carries the
//      operator's sentence as `{"ok":false,"code":"failed","message":...}`
//   2  the request was refused and nothing was done (unknown operation, a path
//      outside the home, a malformed field, a daemon environment); stdout is
//      `{"ok":false,"code":<why>,"message":...}`
//
// Anything else is a crash and the daemon reports it as one.
//
// **The helper never runs with the daemon's environment.** `asCore` builds a
// clean one, and this checks it: a variable in the daemon's `AC_` namespace
// means somebody started this process some other way, and it refuses to start.
// Its home is whatever `asCore` set `HOME` to, and the paths a request may name
// are that home and nothing else.

import * as path from "node:path";
import type { Readable } from "node:stream";
import {
  CoreHomeOpFailedError,
  CoreHomeOpRefusedError,
  handleCoreHomeOp,
  parseCoreHomeOpRequest,
  type CoreHomeOpContext,
} from "./core-home-ops";

/** A request is a few paths or one credential; a megabyte is far past any of them. */
const MAX_REQUEST_BYTES = 1024 * 1024;

export type HelperIo = {
  stdin: Readable;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
  env: NodeJS.ProcessEnv;
};

async function readRequest(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new CoreHomeOpRefusedError("too-large", `the request is over ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The daemon's own configuration is the `AC_` namespace; `AC_HOOK_` is what a Session reads back. */
function daemonVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => key.startsWith("AC_") && !key.startsWith("AC_HOOK_"));
}

export async function runCoreHomeOpsMain(io: HelperIo): Promise<number> {
  const answer = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  const refused = (code: string, message: string): number => {
    io.stderr.write(`core-home-ops: refused (${code}): ${message}\n`);
    answer({ ok: false, code, message });
    return 2;
  };

  const inherited = daemonVariables(io.env);
  if (inherited.length > 0) {
    return refused("bad-request", `refusing to run with the daemon's environment (${inherited.join(", ")})`);
  }
  const home = io.env.HOME;
  if (!home || !path.isAbsolute(home) || home.includes("\0")) {
    return refused("bad-request", "HOME is not an absolute path");
  }
  const ctx: CoreHomeOpContext = {
    home: path.resolve(home),
    roots: [path.resolve(home)],
    env: io.env,
  };

  try {
    const text = await readRequest(io.stdin);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CoreHomeOpRefusedError("bad-json", "the request is not JSON");
    }
    const request = parseCoreHomeOpRequest(raw);
    const result = await handleCoreHomeOp(request, ctx);
    answer({ ok: true, result });
    return 0;
  } catch (err) {
    if (err instanceof CoreHomeOpRefusedError) return refused(err.code, err.message);
    if (err instanceof CoreHomeOpFailedError) {
      io.stderr.write(`core-home-ops: failed: ${err.message}\n`);
      answer({ ok: false, code: "failed", message: err.message });
      return 1;
    }
    io.stderr.write(`core-home-ops: crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 70;
  }
}
