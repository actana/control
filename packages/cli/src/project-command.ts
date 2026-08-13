// `actana project` — the Projects a Core owns (#129 D10).
//
//   actana project ls [--json]         every Project on the selected Core
//   actana project add <name> <path>   register one at a path on the Core
//   actana project browse [path]       walk the Core's disk to find that path
//   actana project cp <src> <dst>      copy files in or out of one (#168)
//   actana project files <project>     list a Project's files (#168)
//
// The last two are phase 3's, and they hang off this noun rather than off the
// root: **there is no `actana cp`** (#129 F12). D8's noun grammar holds — every
// client verb hangs off a noun — and the two verbs are big enough that their
// bodies live in `project-cp.ts` and `project-files-ls.ts` with the reasoning
// that goes with them. What stays here is the dispatch and the help, so the
// shape of the noun is still readable in one file.
//
// Two facts shape all three verbs, and both are about *whose machine* is being
// talked about.
//
// **A Project's path is a path on the Core, not on this laptop.** The operator
// is typing on one machine and naming a folder on another, so `project add`
// never resolves what it is given against the working directory and never
// stats it locally — a `.` that quietly became `/home/you/somewhere` would
// register a Project at a path the Core has never heard of, or worse, at one it
// has and that means something else entirely. The path crosses as typed and the
// Core validates it (CONTEXT.md "Project": *a Project's path is a VM path; only
// the Core can validate it*). The one check made here is that it is absolute,
// which is not validation but a refusal to guess.
//
// **`browse` walks the Core's disk through `dirList`.** Same reason, and it is
// what makes `add` usable without ssh: the picker the Panel gets in a browser
// is the listing this prints in a terminal, off the same frame, answered by the
// process that owns the disk.
//
// **A Core-owned Project's path is immutable after creation (ADR 0022).** No op
// carries a path after `create`, so there is nothing for an edit verb to send —
// and this noun therefore offers none. That is not an omission to be filled in
// later by whoever notices: an `actana project set-path` that accepted the
// argument and dropped it is exactly the half-save ADR 0022 exists to end, so
// the names somebody would reach for are caught below and answered with the
// fact instead. Growing an op that carries a Core-validated path is #104.

import { formatJson, formatTable } from "./cli-output.ts";
import { runProjectCp } from "./project-cp.ts";
import { runProjectFiles } from "./project-files-ls.ts";
import { errorText, openCore, type CoreLinkClient } from "./core-connection.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";
import type { CoreLinkDirListing, CoreLinkProjectSnapshot } from "@actana/sdk/core-link-frames.ts";

export const PROJECT_HELP = `actana project — the Projects a Core owns

Usage
  actana project ls                    list the Projects on the selected Core
  actana project add <name> <path>     register a Project at a path on the Core
  actana project browse [path]         list folders on the Core's disk
  actana project files <project>       list the files inside a Project
  actana project cp <src> <dst>        copy files in or out of a Project

Flags
  --core <name>   which Core to talk to
  --json          machine-readable output — every list command has it
  --depth <n>     how far \`files\` descends. Default: the whole tree
  --limit <n>     stop \`files\` after this many entries
  --sha256        digest every file in a listing. Off by default: it reads them
  --verbose       explain the steps, on stderr. Never prints a blob.

Copying files, in either direction
  One side carries the Project, the other is on this machine — the \`scp\` shape.

    actana project cp ./dist api:build     up: build becomes a copy of dist
    actana project cp api:build ./dist     down: dist becomes a copy of build
    actana project files api:build         what is in there now

  A folder crosses as one archive and keeps its permissions, so an executable
  arrives executable. Every file that replaced one already there is named in
  the output, and \`--json\` lists them under "overwritten".

  A local path is told apart from \`<project>:<path>\` by a rule, not a guess:
  a separator before the colon means local (\`./notes:draft.md\`, \`C:\\dist\`),
  and that leading \`./\` is how you name any local file with a colon in it.

The path is the Core's, not this machine's
  \`add\` takes an absolute path on the Core and sends it as typed: nothing here
  resolves it against your working directory or checks it exists locally, because
  this is not the machine it names. \`browse\` is how you find it — it lists the
  Core's disk over the link, never yours.

    actana project browse                 start at the Core's home directory
    actana project browse /srv/work       list one folder on the Core
    actana project add api /srv/work/api  register it

A Project's path is fixed once it exists
  No frame carries a path after creation (ADR 0022), so there is no verb here
  that edits one — a Project at a different folder is a different Project.`;

/** The verbs somebody will try when they want to move a Project, and cannot. */
const PATH_EDIT_VERBS = new Set(["edit", "mv", "move", "set-path", "setpath", "path", "update"]);

/**
 * The verbs this noun has reserved but not built.
 *
 * **Empty on this train**, which is what a reservation is supposed to end as.
 * `cp` and `files` were the two — reserved by #161 so that the shape of this
 * noun was decided in one place rather than bolted on by whichever ticket got
 * there first — and #168 built them, so each left the table as it landed. The
 * table stays because the distinction it draws has not gone anywhere: a verb a
 * later phase adds owes the reader a ticket number rather than "unknown verb",
 * and a row here is the whole of saying so. `project rm` (#210) is the next one
 * that will want it, and it is deliberately *not* pre-reserved: a reservation
 * with no ticket in flight is a promise this build cannot keep.
 */
const RESERVED_VERBS: Record<string, string> = {};

/** Dispatch a `project` verb. `args.positionals` still has `project` at [0]. */
export async function runProjectCommand(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const [verb, ...rest] = args.positionals.slice(1);

  if (args.help || verb === undefined) {
    deps.out(PROJECT_HELP);
    return verb === undefined && !args.help ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "ls":
    case "list":
      return projectLs(deps, args, paths);
    case "add":
      return projectAdd(deps, args, paths, rest);
    case "browse":
      return projectBrowse(deps, args, paths, rest);
    case "cp":
      return runProjectCp(deps, args, paths, rest);
    case "files":
      return runProjectFiles(deps, args, paths, rest);
    default: {
      if (PATH_EDIT_VERBS.has(verb)) return refusePathEdit(deps, verb);
      const reserved = RESERVED_VERBS[verb];
      if (reserved) {
        deps.err(`actana project ${verb}: not built yet — ${reserved}.`);
        return EXIT_UNIMPLEMENTED;
      }
      deps.err(`actana project: unknown verb "${verb}".`);
      deps.err("Verbs: ls, add, browse, files, cp. `actana project --help` lists them.");
      return EXIT_USAGE;
    }
  }
}

/** `actana project ls [--json]` — every Project the selected Core owns. */
async function projectLs(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
): Promise<number> {
  const opened = await openCore(deps, args, paths, "actana project ls");
  if (!opened.ok) return opened.code;
  const { client, name } = opened.core;

  let projects: CoreLinkProjectSnapshot[];
  try {
    projects = await client.projectsList();
  } catch (err) {
    deps.err(`actana project ls: ${errorText(err)}`);
    return EXIT_FAILURE;
  } finally {
    client.close();
  }

  if (args.json) {
    deps.out(
      formatJson(
        projects.map((project) => ({
          projectId: project.projectId,
          name: project.name,
          path: project.path,
          pinned: project.pinned,
          updatedAt: project.updatedAt,
        })),
      ),
    );
    return EXIT_OK;
  }

  if (projects.length === 0) {
    deps.out(
      `No Projects on ${name ?? "this Core"}. \`actana project add <name> <path>\` registers one.`,
    );
    return EXIT_OK;
  }

  const table = formatTable(
    ["NAME", "PATH", "PINNED", "ID"],
    projects.map((project) => [
      project.name,
      project.path,
      project.pinned ? "*" : "",
      project.projectId,
    ]),
  );
  for (const line of table) deps.out(line);
  return EXIT_OK;
}

/**
 * `actana project add <name> <path>`.
 *
 * The path is checked for exactly one thing here — that it is absolute — and
 * sent unresolved. Everything else about it (does it exist, is it a directory,
 * is it readable) is a question about a disk this process cannot see, and the
 * Core answers it: an invalid path comes back as an `error` frame, which
 * `projectsMutate` turns into the rejection printed below.
 */
async function projectAdd(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [name, projectPath, ...extra] = rest;
  if (name === undefined || projectPath === undefined) {
    deps.err("actana project add: a name and a path are required —");
    deps.err("  actana project add <name> <path-on-the-core>");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana project add: unexpected argument "${extra[0]}".`);
    deps.err("A path with spaces in it needs quoting.");
    return EXIT_USAGE;
  }
  if (!projectPath.startsWith("/")) {
    // POSIX-absolute, checked as a string. Not `path.isAbsolute` — that answers
    // for *this* machine, and on Windows it would accept `C:\…` for a Core that
    // is a Linux VM and reject a perfectly good `/srv/work`.
    deps.err(`actana project add: "${projectPath}" is not an absolute path.`);
    deps.err("A Project's path is a path on the Core's machine, not on this one.");
    deps.err("`actana project browse` lists the Core's disk to find it.");
    return EXIT_USAGE;
  }

  const opened = await openCore(deps, args, paths, "actana project add");
  if (!opened.ok) return opened.code;
  const { client, name: coreName } = opened.core;

  let project: CoreLinkProjectSnapshot | null;
  try {
    deps.verbose(`creating Project "${name}" at ${projectPath} on the Core`);
    project = await client.projectsMutate({ op: "create", name, path: projectPath });
  } catch (err) {
    deps.err(`actana project add: the Core refused it — ${errorText(err)}`);
    return EXIT_FAILURE;
  } finally {
    client.close();
  }

  if (project === null) {
    // `projectsMutate` answers `null` for a mutation that hit no row. `create`
    // has no row to miss, so this is a Core with no mutation port wired — worth
    // saying plainly rather than printing a success line for a Project that was
    // never written.
    deps.err("actana project add: the Core accepted the frame and created nothing.");
    deps.err("That Core has no project store wired — `actana core status` reports what it is.");
    return EXIT_FAILURE;
  }

  if (args.json) {
    deps.out(
      formatJson({
        projectId: project.projectId,
        name: project.name,
        path: project.path,
        pinned: project.pinned,
        updatedAt: project.updatedAt,
      }),
    );
    return EXIT_OK;
  }

  deps.out(`Added Project "${project.name}" → ${project.path}`);
  deps.out(`  on ${coreName ?? "the selected Core"}, id ${project.projectId}`);
  deps.out("  the path is fixed from here (ADR 0022) — a different folder is a different Project.");
  return EXIT_OK;
}

/**
 * `actana project browse [path] [--json]` — the Core's disk, one folder at a
 * time.
 *
 * With no argument the Core answers with its own default (its home), which is
 * why nothing here invents a starting point: a path this process chose would be
 * a path off this machine's layout, and the whole subject is the other one's.
 */
async function projectBrowse(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [requested, ...extra] = rest;
  if (extra.length > 0) {
    deps.err(`actana project browse: unexpected argument "${extra[0]}".`);
    return EXIT_USAGE;
  }

  const opened = await openCore(deps, args, paths, "actana project browse");
  if (!opened.ok) return opened.code;
  const { client, name, endpoint } = opened.core;

  let listing: CoreLinkDirListing;
  try {
    listing = await dirList(client, requested ?? null);
  } catch (err) {
    deps.err(`actana project browse: ${errorText(err)}`);
    return EXIT_FAILURE;
  } finally {
    client.close();
  }

  if (args.json) {
    deps.out(
      formatJson({
        core: name,
        endpoint,
        path: listing.path,
        parent: listing.parent,
        home: listing.home,
        roots: listing.roots,
        entries: listing.entries,
        truncated: listing.truncated,
      }),
    );
    return EXIT_OK;
  }

  deps.out(`${listing.path}    (on ${name ?? endpoint})`);
  if (listing.entries.length === 0) {
    deps.out("  (no folders here)");
  } else {
    const table = formatTable(
      ["", "FOLDER", "SUBFOLDERS"],
      listing.entries.map((entry) => [
        "",
        entry.name,
        entry.childCount > 0 ? String(entry.childCount) : "",
      ]),
    );
    // The header is dropped: two of its three columns are an indent and a count
    // whose meaning the numbers already carry, and a folder listing that opens
    // with a header row reads as a report rather than as a place.
    for (const line of table.slice(1)) deps.out(line);
  }
  if (listing.truncated) {
    deps.err("warning: the Core capped this listing — some folders are not shown.");
  }
  if (listing.parent !== null) deps.out(`  up: actana project browse ${listing.parent}`);
  for (const root of listing.roots) deps.out(`  ${root.label}: ${root.path}`);
  return EXIT_OK;
}

/**
 * Send `dirList` and read the answer as a frame.
 *
 * `dirList` has no typed method on the client and no arm in `unwrapResponse`, so
 * this goes through `request` — the seam that hands the frame over untouched —
 * and turns the two failure shapes into one thrown sentence for the verb above.
 */
async function dirList(client: CoreLinkClient, requested: string | null): Promise<CoreLinkDirListing> {
  const frame = await client.request({ type: "dirList", reqId: "", path: requested });
  if (frame.type === "dirListResult") return frame.listing;
  if (frame.type === "error") throw new Error(frame.message);
  throw new Error(`the Core answered a dirList with a ${frame.type} frame`);
}

/**
 * What a Core-owned Project's path being immutable sounds like at the command
 * line (ADR 0022).
 *
 * `EXIT_USAGE`, not `EXIT_UNIMPLEMENTED`: this is not a verb waiting on a
 * ticket, it is a verb the protocol has nothing to carry. The distinction is
 * the whole reason both codes exist.
 */
function refusePathEdit(deps: ActanaCliDeps, verb: string): number {
  deps.err(`actana project ${verb}: a Core-owned Project's path cannot be changed.`);
  deps.err("No frame carries a path after creation (ADR 0022), so there is nothing to send —");
  deps.err("a Project at a different folder is a new one: `actana project add <name> <path>`.");
  deps.err("Growing an op that carries a Core-validated path is tracked in #104.");
  return EXIT_USAGE;
}
