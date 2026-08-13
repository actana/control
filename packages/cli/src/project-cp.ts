// `actana project cp` — files between this machine and a Project on a Core
// (#129 F12, #168).
//
//   actana project cp ./dist api:build      up
//   actana project cp api:build ./dist      down
//
// **There is no `actana cp`.** D8's noun grammar holds: every client verb hangs
// off a noun, and this one is about a Project's files, so it lives on
// `project`. A root-level `cp` would also be the one command in the tree whose
// name promised something about the local filesystem that it does not do.
//
// ## Which side is remote, and why that is a whole module
//
// The direction is read off the arguments — one side carries `<project>:` and
// the other does not — which is the `scp` shape and the one an operator's
// fingers already know. It is also the shape with the famous ambiguity, so the
// parse is decided, written down and tested in `project-file-target.ts` rather
// than left to a regex here.
//
// ## A folder is one tar, and the executable bit is the reason
//
// A directory crosses as a single streamed archive (ADR 0029), packed by
// `local-tar.ts` on the way up and unpacked by it on the way down. #168's "a
// folder copies both ways and keeps its executable bits" is what that buys: a
// mode is a field in a tar header, and a transfer that sent N files over N
// requests would have to invent a side channel for it — or, like most such
// transfers, quietly hand everything 0o644 and let the operator find out when
// their `./deploy` will not run.
//
// The Core does the packing in the other direction, for the same reason it
// does not do it here: whichever side owns the disk owns the walk.
//
// ## Two rules about output, and both are #168 asking for them
//
// **Progress is for a terminal, and `--json` has none.** A rewriting status
// line goes to the terminal while the transfer runs, and only when there is a
// terminal to write it to. Under `--json` there is not one byte of it: stdout
// carries exactly one document, and a consumer parsing it must not have to
// filter a spinner out first.
//
// **Every overwrite is named.** Not counted — named, with its path, in the
// output. F5 exists to prevent a silent clobber, and a summary reading "412
// files written" over a tree that quietly replaced eleven of them is precisely
// the failure it is aimed at. The Core reports `written` / `overwritten` per
// entry on the way up; on the way down this side checks what was already there
// before it writes, because the local disk is the one it can see.
//
// ## What this file does not do
//
// It does not validate the remote path. Absolute, `..`, outside the root, too
// long, already a directory — every one of those is the Core's answer (F3, F11,
// ADR 0027 D5), and it gives them with a code and a sentence. A client-side
// copy of those rules would be a second implementation that cannot see the
// disk it is ruling on, and the two would drift the first time either moved.

import fs from "node:fs";
import path from "node:path";
import { formatJson } from "./cli-output.ts";
import { resolveCore } from "./core-resolution.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import { packLocalTree, streamChunks, unpackTarInto, LocalTarError } from "./local-tar.ts";
import {
  remoteDirectorySource,
  remoteFileDestination,
  transferDirection,
} from "./project-file-target.ts";
import { ProjectFilesError, type ProjectFileTransfers } from "./project-files-gateway.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type { CoreFileProgress } from "@actana/sdk/core-files.ts";

/**
 * How long a transfer waits for the Core to *answer*, not to finish.
 *
 * The same 30s every other noun dials with. It is a connect and request
 * deadline, and the file surface's own reads have no deadline at all — a
 * ten-gigabyte folder takes as long as it takes, and a timer that killed it
 * half-way would leave a partial tree behind and call it a timeout.
 */
const TRANSFER_TIMEOUT_MS = 30_000;

/** One entry that landed, in the shape both directions report. */
type LandedEntry = { path: string; result: "written" | "overwritten"; size: number };

/** `actana project cp <src> <project>:<path>` — and the reverse. */
export async function runProjectCp(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [sourceToken, destToken, ...extra] = rest;
  if (sourceToken === undefined || destToken === undefined) {
    deps.err("actana project cp: a source and a destination are required —");
    deps.err("  actana project cp <src> <project>:<path>     copy into a Project");
    deps.err("  actana project cp <project>:<path> <dst>     copy out of one");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana project cp: unexpected argument "${extra[0]}".`);
    deps.err("Two paths, and a path with spaces in it needs quoting.");
    return EXIT_USAGE;
  }

  const direction = transferDirection(sourceToken, destToken);
  if (!direction.ok) {
    deps.err(`actana project cp: ${direction.error}.`);
    deps.err("A local file whose name contains a colon is unambiguous as `./name:with-colon`.");
    return EXIT_USAGE;
  }

  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) return failed(deps, args, resolved.error);

  deps.verbose(`dialling ${resolved.core.blob.endpoint}`);
  let gateway;
  try {
    gateway = await deps.openFiles(resolved.core.blob, { timeoutMs: TRANSFER_TIMEOUT_MS });
  } catch (err) {
    return failed(deps, args, `${resolved.core.blob.endpoint} did not answer — ${messageOf(err)}`);
  }

  // Owned out here rather than inside the transfer, because a transfer that
  // throws part-way has still written the entries it got to and those entries
  // are the answer to "what did this replace?". A `landed` that lived inside
  // `upload`/`download` would be discarded by the throw along with the only
  // record of them (F5).
  const landed: LandedEntry[] = [];
  try {
    const project = await gateway.project(direction.remote.project);
    deps.verbose(`Project "${project.name}" is ${project.projectId} at ${project.path} on the Core`);

    if (direction.direction === "upload") {
      await upload(deps, args, project, direction.local, direction.remote.path, landed);
    } else {
      await download(deps, args, project, direction.remote.path, direction.local, landed);
    }

    return report(deps, args, {
      core: resolved.core.name,
      project,
      direction: direction.direction,
      source: sourceToken,
      destination: destToken,
      landed,
    });
  } catch (err) {
    return failed(deps, args, messageOf(err), err, landed);
  } finally {
    gateway.close();
  }
}

/**
 * Local → Core.
 *
 * A directory becomes one tar and a file goes as raw bytes, and the branch is
 * the whole difference: the Core reads `Content-Type` and nothing else to
 * decide whether to unpack (the SDK's `kind`), so a folder sent as a file would
 * land as a file *named* like the folder, and a file sent as a tar would be
 * refused as a corrupt archive.
 *
 * `contentLength` is passed for the single-file case because it is what lets
 * the Core run its free-space precheck and refuse `507` *before* the bytes
 * cross rather than fail with `ENOSPC` half-way in. A tar's length is not known
 * until the tree has been walked, so there is nothing honest to declare — and
 * declaring a guess would be worse than declaring nothing.
 */
async function upload(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  project: ProjectFileTransfers,
  localPath: string,
  remotePath: string,
  /** Appended to as entries land. The caller owns it, so a throw does not take it. */
  landed: LandedEntry[],
): Promise<void> {
  const stats = await fs.promises.stat(localPath).catch(() => null);
  if (!stats) {
    // This machine's disk, so this machine answers. Nothing about the *remote*
    // path is checked here — see the module header.
    throw new Error(`${localPath} is not a file or folder on this machine`);
  }

  const progress = openProgress(deps, args);
  try {
    const stream = stats.isDirectory()
      ? project.upload({
          path: remoteDirectorySource(remotePath),
          kind: "tar",
          body: packLocalTree(localPath, (entry) => progress.packing(entry.path)),
        })
      : project.upload({
          path: remoteFileDestination(remotePath, localPath),
          kind: "file",
          body: fs.createReadStream(localPath),
          mode: stats.mode & 0o777,
          mtime: Math.floor(stats.mtimeMs),
          contentLength: stats.size,
        });

    for await (const line of stream) {
      const entry = landedFrom(line);
      if (!entry) continue;
      landed.push(entry);
      progress.landed(entry, landed);
    }
  } finally {
    progress.close();
  }
}

/** One progress line as a landed entry, or null for the `done` line's totals. */
function landedFrom(line: CoreFileProgress): LandedEntry | null {
  if (line.type !== "entry") return null;
  return { path: line.path, result: line.result, size: line.size };
}

/**
 * Core → local.
 *
 * The Core decides which of the two shapes comes back: a folder is announced as
 * `x-actana-transfer-kind: tar` and anything else is bytes. This side does not
 * ask in advance and does not guess from the path — a `list` first would be a
 * second round trip and a race, and the header is already authoritative.
 *
 * Overwrites are detected here rather than reported by anybody, because this is
 * the disk being written to. `unpackTarInto` checks each entry as it lands; the
 * single-file path checks once, below.
 */
async function download(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  project: ProjectFileTransfers,
  remotePath: string,
  localPath: string,
  /** Appended to as entries land. The caller owns it, so a throw does not take it. */
  landed: LandedEntry[],
): Promise<void> {
  const answer = await project.download({ path: remoteDirectorySource(remotePath) });
  const progress = openProgress(deps, args);

  try {
    if (answer.kind === "tar") {
      await unpackTarInto(streamChunks(answer.stream), localPath, (entry) => {
        const one: LandedEntry = { path: entry.path, result: entry.result, size: entry.size };
        landed.push(one);
        progress.landed(one, landed);
      });
      return;
    }

    // A file landing on an existing directory takes its own name inside it,
    // which is what `cp` does and what an operator typing `cp api:a.txt .`
    // means. Any other destination is taken literally, including one that does
    // not exist yet.
    const destination = (await isDirectory(localPath))
      ? path.join(localPath, path.basename(remotePath))
      : localPath;
    const existing = await fs.promises.lstat(destination).catch(() => null);
    const result = existing ? "overwritten" : "written";

    await fs.promises.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
    const handle = await fs.promises.open(destination, "w");
    let bytes = 0;
    try {
      for await (const chunk of streamChunks(answer.stream)) {
        await handle.write(chunk);
        bytes += chunk.length;
        progress.bytes(destination, bytes);
      }
    } finally {
      await handle.close();
    }
    // Explicitly, and after the bytes: `open` masks a mode through the umask,
    // so an executable written that way arrives un-executable on most machines.
    if (answer.mode !== null) await fs.promises.chmod(destination, answer.mode & 0o777).catch(() => {});
    if (answer.mtime !== null && answer.mtime > 0) {
      const when = new Date(answer.mtime);
      await fs.promises.utimes(destination, when, when).catch(() => {});
    }

    const one: LandedEntry = { path: destination, result, size: bytes };
    landed.push(one);
    progress.landed(one, landed);
  } finally {
    progress.close();
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  const stats = await fs.promises.stat(candidate).catch(() => null);
  return stats?.isDirectory() ?? false;
}

// ─── Progress ────────────────────────────────────────────────────────────────

/**
 * The live status line, and the two conditions under which there is not one.
 *
 * `--json` is the first and it is absolute: a document on stdout is the whole
 * of that mode's output. **Not a terminal** is the second — a transfer whose
 * output is piped into a file or another program should not fill it with
 * carriage returns, and `isTty` is true only when *both* halves of the terminal
 * are one, which is exactly the question being asked.
 *
 * It writes through {@link CliTerminal}, not `deps.out`: this is a line that
 * gets overwritten rather than a line of output, and the last thing it does is
 * erase itself, so what remains on the screen afterwards is only the result.
 */
type Progress = {
  /** A file the local walk has read, on the way up. */
  packing(entryPath: string): void;
  /** An entry that landed, either direction. */
  landed(entry: LandedEntry, all: LandedEntry[]): void;
  /** Bytes into a single-file download, where there are no entries to count. */
  bytes(destination: string, written: number): void;
  close(): void;
};

function openProgress(deps: ActanaCliDeps, args: ParsedArgs): Progress {
  if (args.json || !deps.terminal.isTty) {
    return { packing: () => {}, landed: () => {}, bytes: () => {}, close: () => {} };
  }

  let painted = false;
  const paint = (line: string): void => {
    // Truncated to the terminal's width, because a line longer than the screen
    // wraps and then `\r` returns to the start of the *last* row — leaving the
    // earlier rows on screen and turning a status line into a growing wall.
    const width = Math.max(20, deps.terminal.size().cols - 1);
    const text = line.length > width ? `${line.slice(0, width - 1)}…` : line;
    deps.terminal.write(`\r${text}${" ".repeat(Math.max(0, width - text.length))}`);
    painted = true;
  };

  return {
    packing: (entryPath) => paint(`  reading ${entryPath}`),
    landed: (entry, all) => {
      const overwritten = all.reduce((n, one) => (one.result === "overwritten" ? n + 1 : n), 0);
      const tally = overwritten > 0 ? `${all.length} entries, ${overwritten} overwritten` : `${all.length} entries`;
      paint(`  ${tally} — ${entry.path}`);
    },
    bytes: (destination, written) => paint(`  ${formatBytes(written)} — ${destination}`),
    close: () => {
      if (!painted) return;
      const width = Math.max(20, deps.terminal.size().cols - 1);
      deps.terminal.write(`\r${" ".repeat(width)}\r`);
    },
  };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

/**
 * What happened, once — as a document under `--json`, as prose otherwise.
 *
 * Both name every overwrite. The JSON carries them as an array a script can act
 * on, and the prose lists them one per line above the summary, because a count
 * is what F5 is trying to stop somebody from being able to publish.
 */
function report(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  outcome: {
    core: string | null;
    project: ProjectFileTransfers;
    direction: "upload" | "download";
    source: string;
    destination: string;
    landed: LandedEntry[];
  },
): number {
  const overwritten = outcome.landed.filter((entry) => entry.result === "overwritten");
  const bytes = outcome.landed.reduce((total, entry) => total + entry.size, 0);

  if (args.json) {
    deps.out(
      formatJson({
        core: outcome.core,
        project: outcome.project.name,
        projectId: outcome.project.projectId,
        direction: outcome.direction,
        source: outcome.source,
        destination: outcome.destination,
        entries: outcome.landed.length,
        bytes,
        written: outcome.landed.length - overwritten.length,
        // Named, not counted — the same rule the prose below keeps, in the
        // shape a script can read.
        overwritten: overwritten.map((entry) => entry.path),
      }),
    );
    return EXIT_OK;
  }

  for (const entry of overwritten) deps.out(`  overwrote ${entry.path}`);
  const what = outcome.landed.length === 1 ? "1 entry" : `${outcome.landed.length} entries`;
  deps.out(`Copied ${what} (${formatBytes(bytes)}) — ${outcome.source} → ${outcome.destination}`);
  if (overwritten.length > 0) {
    const many = overwritten.length === 1 ? "1 was an overwrite" : `${overwritten.length} were overwrites`;
    deps.out(`  ${many}, named above.`);
  }
  return EXIT_OK;
}

/**
 * One failure, reported the same way every time: JSON on stdout when `--json`
 * promised a document, prose on stderr always.
 *
 * **A part-way failure still names what it replaced.** F5 says every overwrite
 * is named in the output, and a transfer that replaced eleven files and lost
 * the connection on the twelfth has overwritten eleven files — the criterion
 * does not stop applying because the verb is about to exit non-zero. Those
 * entries are the ones an operator most needs, because they are the ones they
 * now have to reason about restoring, and under `--json` there is no progress
 * line they might have watched scroll past. So `overwritten` appears on the
 * error document with the same name and the same shape it has on the success
 * one: a script reads one key either way, and the exit code says which
 * happened. Prose puts them *above* the failure, so the last line on the
 * screen is still why it stopped.
 *
 * The F8 refusal gets a second line and it is the only other special case in
 * here. The Core's message already names the transfer holding the Project and
 * when it started — #168 asks for exactly that, *who holds it, not just
 * "busy"* — so what is added is the one thing the Core cannot know: that
 * waiting is the remedy, and that nothing here has been retrying behind the
 * operator's back.
 */
function failed(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  message: string,
  err?: unknown,
  landed: LandedEntry[] = [],
): number {
  const overwritten = landed.filter((entry) => entry.result === "overwritten");

  if (args.json) {
    deps.out(
      formatJson({
        error: message,
        entries: landed.length,
        overwritten: overwritten.map((entry) => entry.path),
      }),
    );
  } else {
    for (const entry of overwritten) deps.err(`  overwrote ${entry.path}`);
    if (overwritten.length > 0) {
      const many =
        overwritten.length === 1 ? "1 file was replaced" : `${overwritten.length} files were replaced`;
      deps.err(`${many} before this stopped, named above.`);
    }
  }
  deps.err(`actana project cp: ${message}`);
  if (err instanceof ProjectFilesError && err.kind === "conflict") {
    deps.err("Nothing was retried — one write at a time per Project (F8). Try again once that one is done.");
  }
  if (err instanceof LocalTarError && err.code === "unsafe-entry-path") {
    deps.err("Nothing was written for that entry. The rest of the archive was not unpacked.");
  }
  return EXIT_FAILURE;
}

/** Bytes a human reads, at three significant figures and no more. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
