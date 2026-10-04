// The daemon's side of the Files API helper (issue 557, ADR 0041 D25): run one
// operation on `~` as `core`, and relay what it answers.
//
// In the container each request is one short-lived child, started through `asCore`
// with the bundled helper (`core-files-op.cjs`, next to the daemon's own bundle).
// The request line and then the HTTP body go to its stdin; its stdout is the answer,
// a head line and then the body, and is relayed to the client as it arrives. Its
// environment is what `asCore` builds for any child of `core` and nothing the
// daemon holds. The daemon never opens a path in `~` for the Files API.
//
// Outside the container there is no second user: the same operation runs in this
// process with `core`'s home (the operator's, on metal), so nothing about a metal
// install changes.
//
// **Two deadlines, one of them absent on purpose.** The head has one: a helper that
// has not said anything within `HEAD_TIMEOUT_MS` is stuck and is killed. The body
// has none, since a multi-gigabyte upload takes as long as it takes; what ends a
// transfer is the client hanging up, and that kills the helper through `killAsCore`
// (after the privilege switch it is another uid, and the daemon has no CAP_KILL).
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import log from "@actana/shared/log";
import type { AsCoreOptions } from "@actana/shared/core-home";
import { asCore, coreIdentity, killAsCoreQuietly, type KillAsCoreOptions, type SpawnSpec } from "./core-identity";
import { ClientGoneError, refuse, type FilesOpRequest, type FilesOut } from "./files-ops";

/** The helper's bundle, beside `core-entry.cjs` (`build.mjs` emits both into `dist`). */
export const CORE_FILES_OP_BUNDLE = "core-files-op.cjs";
/** A helper that has sent no head by now is stuck; every head is immediate. */
export const HEAD_TIMEOUT_MS = 30_000;
const MAX_HEAD_BYTES = 64 * 1024;
const STDERR_EXCERPT = 500;

export type CoreFilesHelperOptions = AsCoreOptions & {
  /** Where the helper bundle is. Tests point it at one they built. */
  helperPath?: string;
  /** Builds the launch spec. Tests pass one that keeps the clean environment but cannot `setpriv`. */
  wrap?: typeof asCore;
  /** How long the helper may take to send its head. Tests shorten it. */
  headTimeoutMs?: number;
  /** Options for the kill of a helper whose client hung up (`killAsCore`). */
  killOptions?: KillAsCoreOptions;
};

/** Are Files API operations to run in a helper? Exactly when the daemon and `core` are different users. */
export function filesRunAsHelper(options: CoreFilesHelperOptions = {}): boolean {
  return coreIdentity(options.identityEnv ?? process.env) !== null;
}

type HelperSpec = SpawnSpec & { args: string[] };

function helperSpec(options: CoreFilesHelperOptions): HelperSpec {
  const helper = options.helperPath ?? path.join(__dirname, CORE_FILES_OP_BUNDLE);
  // `env: {}` on purpose. `asCore` builds the child's environment from it and from
  // nothing else; the daemon's own `process.env` is never the base.
  const spec = { command: process.execPath, args: [helper], env: {} };
  return (options.wrap ? options.wrap(spec, options) : asCore(spec, options)) as HelperSpec;
}

/**
 * Run `request` as `core` and answer `res` with what the helper says.
 *
 * Resolves once the helper has finished or the client has gone and the helper has
 * been told to stop, so a caller holding the write lease can release it after.
 */
export function runFilesOpAsCore(
  request: FilesOpRequest,
  req: IncomingMessage,
  res: ServerResponse,
  options: CoreFilesHelperOptions = {},
): Promise<void> {
  const out = responseOut(res);
  return new Promise<void>((resolve) => {
    let spec: HelperSpec;
    try {
      spec = helperSpec(options);
    } catch (err) {
      log.error("core-files.helper-spec-failed", { error: err instanceof Error ? err.message : String(err) });
      refuse(out, { status: 500, code: "write-failed", message: "the Core could not start its file helper" });
      return resolve();
    }

    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    let headBuffer = Buffer.alloc(0);
    let headDone = false;
    let stderr = "";
    let settled = false;
    const kill = (why: string): void => killAsCoreQuietly(child, "SIGKILL", `core-files.${why}`, options.killOptions);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headTimer);
      resolve();
    };

    const headTimer = setTimeout(() => {
      if (headDone) return;
      log.error("core-files.helper-no-head", { timeoutMs: options.headTimeoutMs ?? HEAD_TIMEOUT_MS });
      kill("head-timeout");
      refuse(out, { status: 500, code: "write-failed", message: "the Core's file helper did not answer" });
    }, options.headTimeoutMs ?? HEAD_TIMEOUT_MS);

    // A client that hangs up ends the transfer: the helper is another uid, so it is
    // signalled through `killAsCore`, and its pipes are let go so nothing waits on them.
    res.on("close", () => {
      if (child.exitCode === null && child.signalCode === null) kill("client-gone");
      req.unpipe(child.stdin);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.stdin.on("error", () => undefined); // the helper may answer and exit before it reads all of the body
    child.on("error", (error) => {
      log.error("core-files.helper-spawn-failed", { error: error.message });
      refuse(out, { status: 500, code: "write-failed", message: "the Core could not start its file helper" });
      finish();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (res.destroyed) return;
      if (headDone) return void relay(chunk);
      headBuffer = Buffer.concat([headBuffer, chunk]);
      const newline = headBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (headBuffer.length > MAX_HEAD_BYTES) {
          kill("bad-head");
          refuse(out, { status: 500, code: "write-failed", message: "the Core's file helper sent no usable answer" });
        }
        return;
      }
      let head: { status: number; headers: Record<string, string> };
      try {
        head = parseHead(headBuffer.subarray(0, newline).toString("utf8"));
      } catch (err) {
        kill("bad-head");
        log.error("core-files.helper-bad-head", { error: err instanceof Error ? err.message : String(err) });
        refuse(out, { status: 500, code: "write-failed", message: "the Core's file helper sent no usable answer" });
        return;
      }
      headDone = true;
      clearTimeout(headTimer);
      res.writeHead(head.status, head.headers);
      const rest = headBuffer.subarray(newline + 1);
      if (rest.length > 0) relay(rest);
    });

    const relay = (chunk: Buffer): void => {
      if (res.destroyed) return;
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once("drain", () => child.stdout.resume());
      }
    };

    child.on("close", (code, signal) => {
      const excerpt = stderr.trim().slice(0, STDERR_EXCERPT);
      if (!headDone) {
        if (!res.headersSent && !res.destroyed) {
          log.error("core-files.helper-failed", { status: code, signal, stderr: excerpt });
          refuse(out, { status: 500, code: "write-failed", message: "the Core's file helper failed" });
        }
      } else if (code === 0) {
        res.end();
      } else {
        // The head went out, so the body is cut short. Cutting the connection is the
        // only way left to say it is not whole.
        if (signal === null) log.error("core-files.helper-failed", { status: code, stderr: excerpt });
        res.destroy();
      }
      finish();
    });

    // The request line, then the body. Only a write has one; everything else ends stdin here.
    child.stdin.write(`${JSON.stringify(request)}\n`);
    if (request.op === "write") req.pipe(child.stdin);
    else child.stdin.end();
  });
}

function parseHead(line: string): { status: number; headers: Record<string, string> } {
  const parsed: unknown = JSON.parse(line);
  const candidate = parsed as { status?: unknown; headers?: unknown };
  if (
    typeof candidate.status !== "number" ||
    !Number.isInteger(candidate.status) ||
    candidate.status < 200 ||
    candidate.status > 599 ||
    typeof candidate.headers !== "object" ||
    candidate.headers === null
  ) {
    throw new Error("the head is not {status, headers}");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidate.headers as Record<string, unknown>)) {
    if (typeof value === "string") headers[name] = value;
  }
  return { status: candidate.status, headers };
}

/** A {@link FilesOut} onto an HTTP response, with the daemon's backpressure rule. */
export function responseOut(res: ServerResponse): FilesOut {
  return {
    get headSent() {
      return res.headersSent;
    },
    head(status, headers) {
      res.writeHead(status, headers);
    },
    write: (chunk) => (res.write(chunk) ? Promise.resolve() : drained(res)),
    end: () => void res.end(),
    destroy: () => void res.destroy(),
  };
}

/**
 * Wait for a backpressured response to drain, or for the connection to die.
 *
 * **`'drain'` is never emitted on a destroyed stream.** A promise that waits for
 * that event alone never settles once the client hangs up, and the operation
 * awaiting it parks forever: no `finally` above it ever runs. On a write that left
 * the lease held for the lifetime of the process, and on a read it left the
 * `packDirectory` generator suspended with its file handle open. So `close` and
 * `error` settle it too, and they settle it by throwing {@link ClientGoneError}.
 */
function drained(res: ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.reject(new ClientGoneError());
  return new Promise<void>((resolve, reject) => {
    const settle = (err: Error | null): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = (): void => settle(null);
    const onClose = (): void => settle(new ClientGoneError());
    const onError = (err: Error): void => settle(err);
    res.on("drain", onDrain);
    res.on("close", onClose);
    res.on("error", onError);
  });
}
