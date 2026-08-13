// `actana project files` — what is actually in a Project (#129 F12, #168).
//
//   actana project files api                the whole tree
//   actana project files api:src            one subtree
//   actana project files api --depth 1      the immediate children
//   actana project files api --sha256       with a digest per file
//   actana project files api --json         the same, machine-readable
//
// The Project is named the same way `cp` names it — `<project>` on its own, or
// `<project>:<path>` for a subtree — so one form is learned once. The parse and
// its ambiguities live in `project-file-target.ts`.
//
// **`--json` is the point of the verb as much as the table is.** #168 asks for
// "machine-readable, like every other list command in the CLI", and the shape
// that makes true is the one `project ls` and `session ls` already emit: a bare
// array of objects on stdout, two-space indented, nothing else on the stream.
// Not NDJSON, even though NDJSON is what crosses the wire — a consumer of this
// CLI reads one document per command, and a list that streamed would be the
// only one in the tree that did not.
//
// **`--sha256` is off unless asked for, and that is the Core's decision showing
// through.** A listing does not have the bytes in hand, so a digest per entry
// means reading every file under the path (ADR 0027 D6). Left off, every
// `sha256` is null — which reads as "nobody asked", not "no digest exists".

import { formatJson, formatTable } from "./cli-output.ts";
import { resolveCore } from "./core-resolution.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import { parseTransferTarget, remoteDirectorySource } from "./project-file-target.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type { CoreFileEntry, CoreFileListOptions } from "@actana/sdk/core-files.ts";

/** The same dial deadline every other noun uses. */
const LIST_TIMEOUT_MS = 30_000;

/** `actana project files <project>[:<path>]`. */
export async function runProjectFiles(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [target, ...extra] = rest;
  if (target === undefined) {
    deps.err("actana project files: a Project is required —");
    deps.err("  actana project files <project>[:<path>] [--depth <n>] [--sha256] [--json]");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana project files: unexpected argument "${extra[0]}".`);
    deps.err("A subtree is part of the same argument: `actana project files api:src/lib`.");
    return EXIT_USAGE;
  }

  const parsed = parseTransferTarget(target);
  // A bare `api` is the Project's root, and a `<project>:<path>` is a subtree.
  // A token the parser called local is one that named no Project at all, which
  // for this verb is only ever a typo — there is no local side to list.
  const project = parsed.kind === "remote" ? parsed.project : target;
  const subtree = parsed.kind === "remote" ? remoteDirectorySource(parsed.path) : "";

  const depth = readDepth(args);
  if (depth.error) {
    deps.err(`actana project files: ${depth.error}.`);
    return EXIT_USAGE;
  }
  const limit = readLimit(args);
  if (limit.error) {
    deps.err(`actana project files: ${limit.error}.`);
    return EXIT_USAGE;
  }

  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) return failed(deps, args, resolved.error);

  deps.verbose(`dialling ${resolved.core.blob.endpoint}`);
  let gateway;
  try {
    gateway = await deps.openFiles(resolved.core.blob, { timeoutMs: LIST_TIMEOUT_MS });
  } catch (err) {
    return failed(deps, args, `${resolved.core.blob.endpoint} did not answer — ${messageOf(err)}`);
  }

  try {
    const handle = await gateway.project(project);
    const options: CoreFileListOptions = { path: subtree };
    if (depth.value !== null) options.depth = depth.value;
    if (args.sha256) options.sha256 = true;

    const entries: CoreFileEntry[] = [];
    let truncated = false;
    for await (const entry of handle.list(options)) {
      entries.push(entry);
      if (limit.value !== null && entries.length >= limit.value) {
        // Breaking out here is what cancels the stream — the gateway's
        // `finally` reaches the SDK's, which cancels the response body and lets
        // the Core stop walking a tree nobody is reading any more.
        truncated = true;
        break;
      }
    }

    if (args.json) {
      deps.out(
        formatJson(
          entries.map((entry) => ({
            path: entry.path,
            kind: entry.kind ?? "file",
            size: entry.size,
            mtime: entry.mtime,
            mode: entry.mode,
            sha256: entry.sha256,
          })),
        ),
      );
      return EXIT_OK;
    }

    if (entries.length === 0) {
      const where = subtree.length > 0 ? `${handle.name}:${subtree}` : handle.name;
      deps.out(`Nothing under ${where}.`);
      return EXIT_OK;
    }

    const header = args.sha256 ? ["MODE", "SIZE", "SHA256", "PATH"] : ["MODE", "SIZE", "PATH"];
    const table = formatTable(
      header,
      entries.map((entry) => {
        const row = [modeOf(entry), String(entry.size), nameOf(entry)];
        // The digest is long and the path is what a reader scans for, so the
        // digest goes in the middle and the path stays last — the one column a
        // table cannot pad without making every row ragged.
        return args.sha256 ? [row[0]!, row[1]!, entry.sha256 ?? "—", row[2]!] : row;
      }),
    );
    for (const line of table) deps.out(line);
    if (truncated) {
      deps.err(`warning: stopped at --limit ${limit.value} — the tree has more under it.`);
    }
    return EXIT_OK;
  } catch (err) {
    return failed(deps, args, messageOf(err));
  } finally {
    gateway.close();
  }
}

/**
 * The permission bits, in octal.
 *
 * Octal rather than `rwxr-xr-x` because this surface's whole reason for
 * carrying a mode is the executable bit surviving a transfer (#168), and `755`
 * is how somebody about to type `chmod` thinks about it. The `--json` payload
 * carries the raw number, so nothing is lost to the choice.
 */
function modeOf(entry: CoreFileEntry): string {
  return (entry.mode & 0o777).toString(8).padStart(3, "0");
}

/** `ls -F` conventions: a directory keeps its slash, a symlink gets an `@`. */
function nameOf(entry: CoreFileEntry): string {
  if (entry.kind === "directory") return `${entry.path}/`;
  if (entry.kind === "symlink") return `${entry.path}@`;
  return entry.path;
}

/** `--depth <n>`, or null. Raw off the command line, so this is where it means something. */
function readDepth(args: ParsedArgs): { value: number | null; error?: string } {
  if (args.depth === null) return { value: null };
  const value = Number(args.depth);
  if (!Number.isInteger(value) || value < 1) {
    return { value: null, error: `--depth ${args.depth} is not a whole number of levels (1 or more)` };
  }
  return { value };
}

function readLimit(args: ParsedArgs): { value: number | null; error?: string } {
  if (args.limit === null) return { value: null };
  const value = Number(args.limit);
  if (!Number.isInteger(value) || value < 1) {
    return { value: null, error: `--limit ${args.limit} is not a whole number of entries (1 or more)` };
  }
  return { value };
}

/** One failure: a document on stdout when `--json` promised one, prose on stderr always. */
function failed(deps: ActanaCliDeps, args: ParsedArgs, message: string): number {
  if (args.json) deps.out(formatJson({ error: message }));
  deps.err(`actana project files: ${message}`);
  return EXIT_FAILURE;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
