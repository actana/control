// What the Shared folder's sync does to `~/shared`, and the only way it does it (#562,
// ADR 0041 D33).
//
// The sync runs in the daemon, which is `actana` in the container and cannot open
// `/home/core`. Every list, read, write and delete in `~/shared` is therefore one
// request to the Files helper (`core-files-op.cjs`, ADR 0041 D31), started through
// `asCore`, which runs as `core`, confines the path under the home (an absolute path, a
// `..` and a symlink that leaves the home are refused) and answers on stdout. The daemon
// never opens a path in `~`, and the key is never given to the helper: its environment
// is the one `asCore` builds, and what it is sent is a request and file bytes.
//
// Outside the container there is no second user. The same operation runs in this
// process, with the same code, so a metal install behaves the same.
//
// Whatever the sync is told about `~/shared` is the data of a folder Sessions write to,
// so a symlink is never followed: the helper's listing reports one as a link and it is
// left out, and the folder itself must be a directory and not a link.

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { AsCoreOptions } from "@actana/shared/core-home";
import log from "@actana/shared/log";
import { asCore, coreIdentity, killAsCoreQuietly, type KillAsCoreOptions, type SpawnSpec } from "./core-identity";
import { CORE_FILES_OP_BUNDLE } from "./core-files-helper-client";
import { runFilesOp, type FilesOpRequest, type FilesOut } from "./files-ops";
import { isEventPath } from "./shared-folder-feed";

/** One regular file in the Shared folder, by its path inside it. */
export type LocalFile = { path: string; size: number; mtime: number; mode: number };

/** What a listing could and could not see. */
export type LocalListing = {
  files: LocalFile[];
  /**
   * Folders (by path inside the Shared folder, `""` for the folder itself) the listing could not read or
   * walk. Nothing under one of them is known, so it is not "gone": the sync leaves that subtree alone.
   */
  unreadable: string[];
};

/** What the sync needs of the folder. A test swaps it for one on a plain directory. */
export type SharedHome = {
  /** Every regular file under `~/shared`, or null when the folder is not there (or is not a folder). */
  list(): Promise<LocalListing | null>;
  /** One file as it is now, or null when it is not a regular file there. */
  stat(rel: string): Promise<LocalFile | null>;
  read(rel: string): Promise<Buffer>;
  /** Write one file, creating its parents, and set its mtime. Answers what is on disk now. */
  write(rel: string, data: Buffer, mtimeMs: number, mode?: number): Promise<{ size: number; mtime: number }>;
  /** Delete one file. One that is already gone is fine. */
  remove(rel: string): Promise<void>;
};

export class SharedHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedHomeError";
  }
}

type Answer = { status: number; headers: Record<string, string>; body: Buffer };

/** Moves one request to whoever does it as `core`. */
type Transport = (request: FilesOpRequest, body: Buffer | null) => Promise<Answer>;

/** The name of the folder under `~`, the one prefix every request is built under. */
const FOLDER = "shared";

export type SharedHomeOptions = AsCoreOptions & {
  /** `core`'s home: the folder is `<home>/shared`. */
  home: string;
  /** Where the helper bundle is. Tests point it at one they built. */
  helperPath?: string;
  /** Builds the launch spec. Tests pass one that keeps the clean environment but cannot `setpriv`. */
  wrap?: typeof asCore;
  /** The most a single request may take, then the helper is killed. */
  timeoutMs?: number;
  killOptions?: KillAsCoreOptions;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function createSharedHome(options: SharedHomeOptions): SharedHome {
  const identityEnv = options.identityEnv ?? process.env;
  const transport: Transport = coreIdentity(identityEnv) ? helperTransport(options) : inProcessTransport(options.home);
  return buildSharedHome(transport);
}

/** The operations over any transport. Exported for the tests that count what crosses it. */
export function buildSharedHome(transport: Transport): SharedHome {
  const target = (rel: string): string => {
    if (!isEventPath(rel)) throw new SharedHomeError("the sync was given a path outside the Shared folder");
    return `${FOLDER}/${rel}`;
  };

  return {
    async list() {
      // The folder must be a directory under the home, not a link: a link would make the
      // helper walk wherever it points inside the home, and a listing is what gets uploaded.
      const top = await transport({ op: "list", path: "", headOnly: false, depth: 1 }, null);
      if (top.status !== 200) throw new SharedHomeError(`listing the home failed (${top.status})`);
      const folder = ndjson(top.body).find((line) => line.type === "entry" && line.path === FOLDER);
      if (!folder) return null;
      if (folder.kind !== "directory") return null;

      const answer = await transport({ op: "list", path: FOLDER, headOnly: false }, null);
      if (answer.status === 404) return null;
      if (answer.status !== 200) throw new SharedHomeError(`listing the Shared folder failed (${answer.status})`);
      const files: LocalFile[] = [];
      const unreadable: string[] = [];
      let complete = false;
      for (const line of ndjson(answer.body)) {
        if (line.type === "error") throw new SharedHomeError(`listing the Shared folder failed: ${String(line.message)}`);
        if (line.type === "done") complete = true;
        if (line.type === "skipped" && typeof line.path === "string") {
          // A directory the helper could not open or walk: what is under it is unknown, not deleted.
          if (line.path === FOLDER) unreadable.push("");
          else if (line.path.startsWith(`${FOLDER}/`)) unreadable.push(line.path.slice(FOLDER.length + 1));
          else unreadable.push("");
          continue;
        }
        const file = fileOf(line);
        if (file) files.push(file);
      }
      // A listing that did not end is a listing that stopped early: the rest is unknown.
      if (!complete) throw new SharedHomeError("listing the Shared folder did not finish");
      return { files, unreadable };
    },

    async stat(rel) {
      const answer = await transport({ op: "list", path: target(rel), headOnly: false, depth: 1 }, null);
      if (answer.status === 404) return null;
      if (answer.status !== 200) throw new SharedHomeError(`looking at ${rel} failed (${answer.status})`);
      const entry = ndjson(answer.body).find((line) => line.type === "entry" && line.path === `${FOLDER}/${rel}`);
      return entry ? fileOf(entry) : null;
    },

    async read(rel) {
      const answer = await transport({ op: "read", path: target(rel), headOnly: false }, null);
      if (answer.status !== 200) throw new SharedHomeError(`reading ${rel} failed (${answer.status})`);
      return answer.body;
    },

    async write(rel, data, mtimeMs, mode = 0o644) {
      const answer = await transport(
        { op: "write", path: target(rel), tar: false, contentLength: data.length, fileMode: mode, fileMtime: mtimeMs },
        data,
      );
      if (answer.status !== 200) throw new SharedHomeError(`writing ${rel} failed (${answer.status})`);
      const lines = ndjson(answer.body);
      const failed = lines.find((line) => line.type === "error");
      if (failed) throw new SharedHomeError(`writing ${rel} failed: ${String(failed.message)}`);
      const entry = lines.find((line) => line.type === "entry");
      if (!entry || typeof entry.size !== "number" || typeof entry.mtime !== "number") {
        throw new SharedHomeError(`writing ${rel} gave no answer`);
      }
      return { size: entry.size, mtime: entry.mtime };
    },

    async remove(rel) {
      const answer = await transport({ op: "delete", path: target(rel) }, null);
      if (answer.status !== 200 && answer.status !== 404) throw new SharedHomeError(`deleting ${rel} failed (${answer.status})`);
    },
  };
}

/** A listing line as a regular file in the Shared folder, or null. */
function fileOf(line: Record<string, unknown>): LocalFile | null {
  if (line.type !== "entry" || line.kind !== "file") return null;
  const full = line.path;
  if (typeof full !== "string" || !full.startsWith(`${FOLDER}/`)) return null;
  const rel = full.slice(FOLDER.length + 1);
  const { size, mtime, mode } = line;
  if (!isEventPath(rel) || typeof size !== "number" || typeof mtime !== "number") return null;
  return { path: rel, size, mtime, mode: typeof mode === "number" ? mode & 0o777 : 0o644 };
}

function ndjson(body: Buffer): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const text of body.toString("utf8").split("\n")) {
    if (text.length === 0) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null) lines.push(value as Record<string, unknown>);
    } catch {
      // A line that is not JSON is not an answer; the operation's own checks say what is missing.
    }
  }
  return lines;
}

/** Metal: the daemon and `core` are one user, so the operation runs here. */
function inProcessTransport(home: string): Transport {
  const root = path.resolve(home);
  return async (request, body) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    let broken = false;
    const out: FilesOut = {
      get headSent() {
        return status !== 0;
      },
      head(s, h) {
        status = s;
        headers = h;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
        return Promise.resolve();
      },
      end() {},
      destroy() {
        broken = true;
      },
    };
    async function* bytes(): AsyncGenerator<Uint8Array> {
      if (body) yield body;
    }
    await runFilesOp(request, bytes(), out, { root });
    if (broken) throw new SharedHomeError("the operation was cut short");
    return { status, headers, body: Buffer.concat(chunks) };
  };
}

type HelperSpec = SpawnSpec & { args: string[] };

/** The container: one helper process per request, started through `asCore`. */
function helperTransport(options: SharedHomeOptions): Transport {
  const helper = options.helperPath ?? path.join(__dirname, CORE_FILES_OP_BUNDLE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request, body) =>
    new Promise<Answer>((resolve, reject) => {
      let spec: HelperSpec;
      try {
        // `env: {}` on purpose: `asCore` builds the child's environment and the daemon's,
        // which is where nothing secret should ever be, is never the base.
        const base = { command: process.execPath, args: [helper], env: {} };
        spec = (options.wrap ? options.wrap(base, options) : asCore(base, options)) as HelperSpec;
      } catch (err) {
        return reject(new SharedHomeError(`the Shared folder helper could not be started: ${String(err)}`));
      }
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        killAsCoreQuietly(child, "SIGKILL", "shared-sync.helper-timeout", options.killOptions);
        done(new SharedHomeError(`the Shared folder helper did not finish in ${timeoutMs} ms`));
      }, timeoutMs);
      const done = (failure: Error | null, answer?: Answer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve(answer!);
      };
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
      child.stdin.on("error", () => undefined);
      child.on("error", (err) => done(new SharedHomeError(`the Shared folder helper failed to start: ${err.message}`)));
      child.on("close", (code) => {
        const all = Buffer.concat(out);
        const newline = all.indexOf(0x0a);
        if (code !== 0 || newline < 0) {
          log.warn("shared-sync.helper-failed", { status: code, stderr: stderr.trim().slice(0, 500) });
          return done(new SharedHomeError(`the Shared folder helper failed (exit ${String(code)})`));
        }
        try {
          const head = JSON.parse(all.subarray(0, newline).toString("utf8")) as { status?: unknown; headers?: unknown };
          if (typeof head.status !== "number") throw new Error("no status");
          done(null, {
            status: head.status,
            headers: (head.headers ?? {}) as Record<string, string>,
            body: all.subarray(newline + 1),
          });
        } catch {
          done(new SharedHomeError("the Shared folder helper sent no usable answer"));
        }
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      child.stdin.end(body ?? undefined);
    });
}
