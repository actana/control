// The Files API helper's whole program (issue 557, ADR 0041 D25): read one request,
// run it as the user this process is, and answer on stdout.
//
// It is started by the daemon through `asCore` (`core-files-helper-client.ts`), one
// process per request, so every byte it reads or writes in `~` is read or written
// by `core` and by nobody else. `core-files-op-entry.ts` is the bundle entry that
// calls it; it is split out so a test can run it without starting a process.
//
//   stdin   one line of JSON, a `FilesOpRequest`, then the request body's bytes
//   stdout  one line of JSON, `{"status":…,"headers":{…}}`, then the body's bytes
//   stderr  for a person reading `docker compose logs`
//
// Exit status: 0 when the answer is complete (a refusal such as a 404 is a complete
// answer), 2 when the process refused to run at all (the daemon's environment, a
// HOME that is not a path, a request line that is not a request) and 70 for a crash.
// A non-zero status after the head was sent tells the daemon the body is not whole.
//
// **The helper never runs with the daemon's environment**, exactly as the home-ops
// helper does not: a variable in the daemon's `AC_` namespace means somebody started
// this process some other way, and it refuses to start. Its root is `HOME`, which
// `asCore` set, and nothing a request says can change that.
import * as path from "node:path";
import type { Readable } from "node:stream";
import { ClientGoneError, runFilesOp, type FilesOpRequest, type FilesOut } from "./files-ops";
import { parseFilesOpRequest } from "./files-op-request";

/** A request line is a few paths; far past that is not a request. */
const MAX_REQUEST_LINE_BYTES = 64 * 1024;

export type FilesHelperIo = {
  stdin: Readable;
  stdout: Readable & NodeJS.WritableStream;
  stderr: { write: (chunk: string) => unknown };
  env: NodeJS.ProcessEnv;
};

class RequestLineError extends Error {}

/** Split the request line off stdin; what follows it is the body, untouched. */
async function splitRequestLine(stdin: Readable): Promise<{ line: string; body: AsyncIterable<Uint8Array> }> {
  const iterator = stdin[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  let head = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) throw new RequestLineError("stdin ended before the request line");
    head = Buffer.concat([head, Buffer.isBuffer(value) ? value : Buffer.from(value)]);
    const newline = head.indexOf(0x0a);
    if (newline >= 0) {
      const line = head.subarray(0, newline).toString("utf8");
      const rest = head.subarray(newline + 1);
      const body = (async function* (): AsyncGenerator<Uint8Array> {
        if (rest.length > 0) yield rest;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        }
      })();
      return { line, body };
    }
    if (head.length > MAX_REQUEST_LINE_BYTES) throw new RequestLineError("the request line is too long");
  }
}

/** The daemon's own configuration is the `AC_` namespace; `AC_HOOK_` is what a Session reads back. */
function daemonVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => key.startsWith("AC_") && !key.startsWith("AC_HOOK_"));
}

/** A {@link FilesOut} onto stdout: the head as one JSON line, then the body's bytes as they come. */
function stdoutOut(stdout: FilesHelperIo["stdout"]): FilesOut {
  let headSent = false;
  let gone = false;
  stdout.on("error", () => {
    gone = true;
  });
  stdout.on("close", () => {
    gone = true;
  });
  return {
    get headSent() {
      return headSent;
    },
    head(status, headers) {
      headSent = true;
      stdout.write(`${JSON.stringify({ status, headers })}\n`);
    },
    write(chunk) {
      if (gone) return Promise.reject(new ClientGoneError());
      if (stdout.write(chunk)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const settle = (err: Error | null): void => {
          stdout.off("drain", onDrain);
          stdout.off("close", onClose);
          stdout.off("error", onError);
          if (err) reject(err);
          else resolve();
        };
        const onDrain = (): void => settle(null);
        const onClose = (): void => settle(new ClientGoneError());
        const onError = (): void => settle(new ClientGoneError());
        stdout.on("drain", onDrain);
        stdout.on("close", onClose);
        stdout.on("error", onError);
      });
    },
    end() {
      // Nothing to close: the process exits when the operation returns.
    },
    destroy() {
      // The body is not whole. A non-zero exit is how the daemon is told.
      process.exitCode = 1;
    },
  };
}

export async function runCoreFilesOpMain(io: FilesHelperIo): Promise<number> {
  const refused = (why: string): number => {
    io.stderr.write(`core-files-op: refused: ${why}\n`);
    return 2;
  };

  const inherited = daemonVariables(io.env);
  if (inherited.length > 0) {
    return refused(`refusing to run with the daemon's environment (${inherited.join(", ")})`);
  }
  const home = io.env.HOME;
  if (!home || !path.isAbsolute(home) || home.includes("\0")) return refused("HOME is not an absolute path");

  let request: FilesOpRequest;
  let body: AsyncIterable<Uint8Array>;
  try {
    const split = await splitRequestLine(io.stdin);
    body = split.body;
    request = parseFilesOpRequest(JSON.parse(split.line) as unknown);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }

  const out = stdoutOut(io.stdout);
  try {
    await runFilesOp(request, body, out, { root: path.resolve(home) });
  } catch (err) {
    if (err instanceof ClientGoneError) return 1;
    io.stderr.write(`core-files-op: crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 70;
  }
  return process.exitCode === 1 ? 1 : 0;
}
