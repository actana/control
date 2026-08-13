// project — the directories on the Core that sessions are allowed to run in.

import { UsageError } from "../args.ts";
import type { Ctx } from "../args.ts";
import type { CoreClient } from "../client.ts";
import type { DirListing, Project } from "../protocol.ts";

/** Accepts an id, a name, or a path. */
export async function findProject(client: CoreClient, ref: string): Promise<Project> {
  const projects = await client.call<Project[]>("projectsList");
  const project = projects.find((p) => p.projectId === ref || p.name === ref || p.path === ref);
  if (!project) throw new Error(`no such project: ${ref} (try \`project ls\`)`);
  return project;
}

async function list(client: CoreClient): Promise<void> {
  const projects = await client.call<Project[]>("projectsList");
  if (!projects.length) {
    console.log("(no projects — create one with `project create <path>`)");
    return;
  }
  for (const p of projects) console.log(`${p.projectId}  ${p.name}\t${p.path}`);
}

async function create(client: CoreClient, path: string, name?: string): Promise<void> {
  // `path` is validated on the Core: absolute, resolvable, and a directory.
  const label = name ?? path.split("/").filter(Boolean).pop() ?? path;
  const project = await client.call<Project | null>("projectsMutate", {
    mutation: { op: "create", name: label, path },
  });
  if (!project) throw new Error("the Core refused to create the project");
  console.log(`${project.projectId}  ${project.name}\t${project.path}`);
}

async function remove(client: CoreClient, ref: string, confirmed: boolean): Promise<void> {
  const project = await findProject(client, ref);
  // The Core's removal op is `archive`, and it cascades: every task under the
  // project goes with it. The files on disk are untouched — this unregisters
  // the project, it does not delete the directory.
  if (!confirmed) {
    throw new Error(
      `removing "${project.name}" (${project.projectId}) also removes every session recorded under it. ` +
        `The directory ${project.path} is left alone. Re-run with --yes to confirm.`,
    );
  }
  await client.call("projectsMutate", { mutation: { op: "archive", projectId: project.projectId } });
  console.log(`removed ${project.projectId}  ${project.name}`);
}

async function browse(client: CoreClient, path?: string): Promise<void> {
  const listing = await client.call<DirListing>("dirList", { path: path ?? null });
  console.log(listing.path);
  for (const entry of listing.entries ?? []) {
    console.log(`  ${entry.isDirectory ? "d" : "-"} ${entry.name}`);
  }
}

async function inspect(client: CoreClient, ref: string): Promise<void> {
  console.log(JSON.stringify(await findProject(client, ref), null, 2));
}

export async function run(client: CoreClient, ctx: Ctx): Promise<void> {
  const [verb, ...args] = ctx.positional;
  switch (verb) {
    case "ls":
    case undefined:
      await list(client);
      return;
    case "create":
      if (!args[0]) throw new UsageError("project create needs a path", "project");
      await create(client, args[0], args[1] ?? ctx.flag("name"));
      return;
    case "rm":
      if (!args[0]) throw new UsageError("project rm needs a project", "project");
      await remove(client, args[0], ctx.has("yes"));
      return;
    case "browse":
      await browse(client, args[0]);
      return;
    case "inspect":
      if (!args[0]) throw new UsageError("project inspect needs a project", "project");
      await inspect(client, args[0]);
      return;
    default:
      throw new UsageError(`unknown verb: project ${verb}`, "project");
  }
}
