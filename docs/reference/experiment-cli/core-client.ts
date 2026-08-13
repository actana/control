#!/usr/bin/env node
// core-client — drive an Actana Core over its core-link protocol.
//
// Node 24 runs this TypeScript directly (type stripping), so there is no build
// step. `core-client help` is the manual.
//
// This file is the entry point only: argument routing, the connection, and
// error reporting. Everything a command does lives in src/commands/.

import { makeCtx, UsageError } from "./src/args.ts";
import type { Ctx } from "./src/args.ts";
import { loadBlob } from "./src/blob.ts";
import { CoreClient } from "./src/client.ts";
import * as core from "./src/commands/core.ts";
import * as events from "./src/commands/events.ts";
import * as harness from "./src/commands/harness.ts";
import { printHelp } from "./src/commands/help.ts";
import * as project from "./src/commands/project.ts";
import * as session from "./src/commands/session.ts";
import * as status from "./src/commands/status.ts";

type Command = (client: CoreClient, ctx: Ctx) => Promise<void>;

const RESOURCES: Record<string, Command> = {
  project: project.run,
  session: session.run,
  harness: harness.run,
  status: status.run,
  events: events.run,
};

/**
 * The flat command names, kept working.
 *
 * These were the whole CLI before it grew resources, and scripts already use
 * them. Each expands into its `<resource> <verb>` form, so there is one
 * implementation and no drift.
 */
const ALIASES: Record<string, string[]> = {
  projects: ["project", "ls"],
  "add-project": ["project", "create"],
  ls: ["project", "browse"],
  sessions: ["session", "ls"],
  start: ["session", "start"],
  logs: ["session", "logs"],
  tail: ["session", "logs"],
  attach: ["session", "attach"],
  send: ["session", "send"],
  enter: ["session", "enter"],
  // `stop` meant Escape before the resources existed. Keeping that meaning is
  // the honest choice — anything else silently changes what an old command
  // does. `session interrupt` is the name to use now.
  stop: ["session", "interrupt"],
  interrupt: ["session", "interrupt"],
  resume: ["session", "resume"],
  kill: ["session", "kill"],
  harnesses: ["harness", "ls"],
  install: ["harness", "install"],
  cores: ["core", "ls"],
};

/**
 * Pull `--core <name>` out of the arguments, wherever it sits.
 *
 * It selects which Core the whole command runs against, so it is global rather
 * than per-verb: `--core pr session ls` and `session ls --core pr` mean the same
 * thing. Removing it here also keeps it out of the verb's own positionals.
 */
function extractCore(argv: string[]): { core?: string; rest: string[] } {
  const rest: string[] = [];
  let core: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--core") {
      core = argv[++i];
      if (core === undefined) throw new UsageError("--core needs a Core name");
      continue;
    }
    rest.push(argv[i]);
  }
  return { core, rest };
}

async function main(): Promise<void> {
  const { core: selected, rest: raw } = extractCore(process.argv.slice(2));

  // Help needs neither credentials nor a connection.
  if (!raw.length || raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    printHelp(raw[1]);
    return;
  }

  const expanded = ALIASES[raw[0]] ? [...ALIASES[raw[0]], ...raw.slice(1)] : raw;

  // `core` is answered from the blobs on disk — no credentials, no connection.
  if (expanded[0] === "core") {
    if (expanded.includes("--help") || expanded.includes("-h")) printHelp("core");
    else core.run(expanded.slice(1), selected);
    return;
  }

  const resource = expanded[0];
  const command = RESOURCES[resource];

  if (!command) {
    printHelp();
    console.error(`\ncore-client: unknown command "${resource}"`);
    process.exitCode = 2;
    return;
  }

  if (expanded.includes("--help") || expanded.includes("-h")) {
    printHelp(resource);
    return;
  }

  const ctx = makeCtx(expanded.slice(1));
  const client = await CoreClient.connect(loadBlob(selected));
  try {
    await command(client, ctx);
  } finally {
    // Streaming commands own the socket until they exit the process.
    if (!ctx.keepOpen) client.close();
  }
}

main().catch((err: Error) => {
  if (err instanceof UsageError) {
    printHelp(err.resource);
    console.error(`\ncore-client: ${err.message}`);
    process.exit(2);
  }
  console.error(`core-client: ${err.message}`);
  process.exit(1);
});
