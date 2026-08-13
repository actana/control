// Reaching a Core for `project cp` and `project files` (#129 F12, #168).
//
// The seam `session-gateway.ts` opened for the `session` noun, at the same
// width and for the same reason: one module that dials, so the verbs above it —
// argument parsing, tables, `--json` shapes, exit codes, the progress display —
// are exercised by unit tests with a fake and no Core anywhere near them.
//
// **This is where the SDK is used, and it is used rather than re-implemented.**
// #168's line about it is not decoration: *the CLI consumes the SDK, it does
// not talk HTTP itself.* Nothing in this package builds a URL, sets a bearer
// header, or knows that a file crosses over HTTPS rather than over the core
// link (ADR 0028). `client.project(id).files` is the whole of the contract, and
// PR 217 wrote it; PR 219 settled where `list` points. A second HTTP client
// here would be a second place the route lives, and #218 is the ticket about
// what that costs.
//
// Three things do belong here rather than in the command module, because each
// is a property of *talking to a Core* rather than of printing:
//
//   1. **A Project is named, not numbered.** An operator types `api:src`, not
//      `p_01H…:src`. Resolution is a `projectsList` over the core link — the
//      same one `session start` does, with the same refusal to guess when a
//      name matches twice.
//   2. **The one-write-per-Project rule keeps its sentence (F8).** The Core's
//      `409` carries *which* transfer holds the Project and *when it started*,
//      and that prose is carried through to the operator intact rather than
//      flattened to "busy". See {@link ProjectFilesError}.
//   3. **Nothing retries.** The SDK does not, deliberately, and neither does
//      this: a conflict that resolved itself by sleeping would take an
//      immediate, well-worded refusal and turn it into a hang with no output.
//
// Everything handed back is plain data or an async iterable of it. No
// `CoreClient`, no `CoreProject`, and no `CoreFilesError` escapes — which is
// what keeps `project-cp.ts` free of the SDK, and free of a socket.

import { CoreClient } from "@actana/sdk/core-client.ts";
import {
  CoreFilesConflictError,
  CoreFilesRequestError,
  CoreFilesStreamError,
  CoreFilesUnavailableError,
} from "@actana/sdk/core-files-http.ts";
import type { CoreFiles } from "@actana/sdk/core-files.ts";
import type {
  CoreFileDownload,
  CoreFileDownloadOptions,
  CoreFileEntry,
  CoreFileListOptions,
  CoreFileProgress,
  CoreFileUploadOptions,
} from "@actana/sdk/core-files.ts";
import type { CoreLinkProjectSnapshot } from "@actana/sdk/core-link-frames.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";

/**
 * What went wrong, in a vocabulary the verbs can turn into a message and an
 * exit code without parsing English out of an SDK error.
 *
 * `conflict` is the one that earns its own kind rather than folding into
 * `refused`. It is F8 — another write already holds this Project — and #168
 * asks for it by name: *a transfer refused by the one-write-per-Project rule
 * should say who holds it, not just "busy"*. The Core's message is the only
 * thing that knows who: it names the path being written and the moment the
 * transfer started. So the kind exists to stop a caller writing its own
 * shorter sentence over the top of that one.
 */
export type ProjectFilesErrorKind =
  | "no-such-project"
  | "conflict"
  | "unavailable"
  | "not-found"
  | "refused";

export class ProjectFilesError extends Error {
  readonly kind: ProjectFilesErrorKind;
  /** The Core's own refusal code, when it sent one — `transfer-in-progress`, `not-found`, … */
  readonly code: string | null;

  constructor(
    kind: ProjectFilesErrorKind,
    message: string,
    options: { cause?: unknown; code?: string | null } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProjectFilesError";
    this.kind = kind;
    this.code = options.code ?? null;
  }
}

/** One Project's files, on one Core, with the Project already resolved. */
export type ProjectFileTransfers = {
  projectId: string;
  /** The Project's name as the Core spells it — not necessarily what was typed. */
  name: string;
  /** The Project's path on the Core's machine, for output that says where bytes went. */
  path: string;
  /** The tree under a path, one entry at a time. */
  list(opts?: CoreFileListOptions): AsyncIterable<CoreFileEntry>;
  /**
   * Write a stream in, and watch it land: one `entry` line per file, each
   * carrying `written` or `overwritten`, then a `done` line with the totals.
   *
   * Lazy, like the SDK's — the request goes out on the first `next()`, so a
   * caller that never drains it never sends anything.
   */
  upload(opts: CoreFileUploadOptions): AsyncIterable<CoreFileProgress>;
  /** Read a file, or a folder as one streamed tar. Nothing is buffered. */
  download(opts: CoreFileDownloadOptions): Promise<CoreFileDownload>;
};

export type ProjectFilesGateway = {
  /** Resolve a Project by id or by name, and bind its file surface. */
  project(wanted: string): Promise<ProjectFileTransfers>;
  close(): void;
};

/** How the file verbs reach a Core. Injected, so every verb is testable. */
export type OpenProjectFilesFn = (
  blob: CoreRegistrationBlob,
  opts: { timeoutMs: number },
) => Promise<ProjectFilesGateway>;

/**
 * The real gateway: connect once, and hand back a Project handle bound to that
 * connection.
 *
 * One connection for the whole command, because both verbs need two things off
 * the same Core — a `projectsList` over the link to resolve the name, and the
 * HTTPS file routes for the transfer itself. The client is what holds the
 * bearer and the capability announcement that make the second one legal (F9),
 * which is why the file surface is reached through it rather than built beside
 * it.
 */
export const openProjectFiles: OpenProjectFilesFn = async (blob, opts) => {
  const client = CoreClient.fromRegistrationBlob(blob, {
    connectTimeoutMs: opts.timeoutMs,
    requestTimeoutMs: opts.timeoutMs,
  });
  const info = await client.connect();
  if (!info.compatible) {
    client.close();
    throw new Error(
      `this Core speaks core-link ${info.protocolVersion ?? "(none reported)"}, which this CLI does not. ` +
        "Update whichever of the two is older — `actana core status` reports both.",
    );
  }
  return new CoreLinkProjectFilesGateway(client);
};

class CoreLinkProjectFilesGateway implements ProjectFilesGateway {
  constructor(private readonly client: CoreClient) {}

  async project(wanted: string): Promise<ProjectFileTransfers> {
    const projects = await this.client.projectsList();
    const project = resolveProject(projects, wanted);
    return bindProjectFiles(this.client.project(project.projectId).files, project);
  }

  close(): void {
    this.client.close();
  }
}

/**
 * The SDK's `CoreFiles` as this module's {@link ProjectFileTransfers}.
 *
 * Separated from the gateway above so it can be handed a `CoreFiles` that came
 * from somewhere else — which is exactly what `project-files-live.test.ts`
 * does, driving the verbs against the Core's *real* HTTP routes with only the
 * core link (and therefore only the name resolution) replaced. An adapter a
 * live suite cannot reach is an adapter no live suite tests.
 */
export function bindProjectFiles(
  files: CoreFiles,
  project: { projectId: string; name: string; path: string },
): ProjectFileTransfers {
  return {
    projectId: project.projectId,
    name: project.name,
    path: project.path,
    list: (listOpts = {}) => translateIterable(() => files.list(listOpts)),
    upload: (uploadOpts) => translateIterable(() => files.upload(uploadOpts)),
    download: async (downloadOpts) => {
      try {
        return await files.download(downloadOpts);
      } catch (err) {
        throw projectFilesErrorFrom(err);
      }
    },
  };
}

/**
 * A Project by id, or by name.
 *
 * By id first, because an id is unambiguous and a name is what somebody types.
 * A name matching two Projects is an error rather than a coin toss — the same
 * call `session-gateway.ts` makes, and it matters more here: writing a folder
 * into the wrong repository is a mistake that overwrites files.
 */
function resolveProject(projects: CoreLinkProjectSnapshot[], wanted: string): CoreLinkProjectSnapshot {
  const byId = projects.find((project) => project.projectId === wanted);
  if (byId) return byId;

  const byName = projects.filter((project) => project.name === wanted);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new ProjectFilesError(
      "no-such-project",
      `"${wanted}" names ${byName.length} Projects on this Core — use the Project id: ${byName
        .map((project) => project.projectId)
        .join(", ")}`,
    );
  }
  const known = projects.map((project) => project.name).join(", ");
  throw new ProjectFilesError(
    "no-such-project",
    known.length > 0
      ? `this Core has no Project "${wanted}". It has: ${known}`
      : "this Core has no Projects registered — `actana project add <name> <path>` registers one",
  );
}

/**
 * The SDK's error taxonomy, as this module's.
 *
 * **The message is carried, never rewritten.** Every branch keeps
 * `err.message`, and the conflict branch is the reason the rule is absolute:
 * the Core's `409` reads *"another write transfer is already running on this
 * Project (vendor/, started 2026-08-13T…) — one write at a time per Project"*,
 * and every word after "Project" is the part an operator can act on. A client
 * that substituted "the Project is busy" would be throwing away the only
 * available answer to "busy with what?".
 *
 * Exported because it is the *contract*, not an implementation detail: the fake
 * gateway in `cli-harness.ts` throws through it, so a suite that hands a verb a
 * real `CoreFilesConflictError` sees the same `ProjectFilesError` a real Core
 * would have produced — rather than passing against a fake that agreed with the
 * command module about a mapping neither of them performs.
 */
export function projectFilesErrorFrom(err: unknown): Error {
  if (err instanceof ProjectFilesError) return err;
  if (err instanceof CoreFilesConflictError) {
    return new ProjectFilesError("conflict", err.message, { cause: err, code: err.code });
  }
  if (err instanceof CoreFilesUnavailableError) {
    return new ProjectFilesError("unavailable", err.message, { cause: err });
  }
  if (err instanceof CoreFilesRequestError) {
    const kind: ProjectFilesErrorKind =
      err.status === 404 ? "not-found" : "refused";
    return new ProjectFilesError(kind, err.message, { cause: err, code: err.code });
  }
  if (err instanceof CoreFilesStreamError) {
    // A failure that arrived as the last line of a progress stream, after the
    // `200`. Worth keeping distinguishable in the message rather than the kind:
    // the transfer is *partly done*, and an operator needs to know that a retry
    // is resuming into a half-written tree rather than starting clean.
    return new ProjectFilesError("refused", `the transfer failed part-way through — ${err.message}`, {
      cause: err,
      code: err.code,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * An async iterable whose failures speak this module's vocabulary.
 *
 * A generator wrapper rather than a `.catch`, because the errors that matter
 * most on this surface are thrown from `next()` and not from the call: `upload`
 * sends nothing until it is first pulled, so the `409` that F8 is about arrives
 * *inside* the `for await`, not around it. Laziness is preserved — the factory
 * is not invoked until the first pull either.
 */
function translateIterable<T>(open: () => AsyncIterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      let iterator: AsyncIterator<T>;
      try {
        iterator = open()[Symbol.asyncIterator]();
      } catch (err) {
        throw projectFilesErrorFrom(err);
      }
      try {
        for (;;) {
          let next: IteratorResult<T>;
          try {
            next = await iterator.next();
          } catch (err) {
            throw projectFilesErrorFrom(err);
          }
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // A consumer that broke out early — a `--limit`, a failed local write —
        // has to reach the SDK's own `finally`, which is what cancels the
        // response body and lets the Core stop writing into a socket nobody is
        // reading. Without this the Core holds the Project's write lease until
        // its own timeout, and the *next* transfer gets a puzzling F8 refusal.
        await iterator.return?.().catch(() => {});
      }
    },
  };
}
