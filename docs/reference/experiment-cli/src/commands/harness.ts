// harness — which agent CLIs the Core can launch, and installing them.

import { UsageError } from "../args.ts";
import type { Ctx } from "../args.ts";
import type { CoreClient } from "../client.ts";
import type { HarnessAvailability } from "../protocol.ts";

export async function availability(client: CoreClient): Promise<Record<string, HarnessAvailability>> {
  return await client.call<Record<string, HarnessAvailability>>("agentsAvailabilityList");
}

async function list(client: CoreClient): Promise<void> {
  for (const [id, entry] of Object.entries(await availability(client))) {
    const detail =
      entry.status === "available"
        ? `${entry.version ?? "?"} at ${entry.path ?? "?"}`
        : (entry.requiredVersion ?? "");
    console.log(`${id.padEnd(12)} ${entry.status.padEnd(10)} ${detail}`);
  }
}

/**
 * Start installing a harness on the Core, and return.
 *
 * Fire and forget on purpose. The install runs on the Core and takes minutes;
 * the request only ever acknowledges the *start*, never the outcome, so there
 * is nothing to usefully wait for on this connection. `harness ls` is how you
 * find out whether it landed — the Core re-probes when the install finishes,
 * and success is defined as "the probe now finds it".
 */
async function install(client: CoreClient, target: string): Promise<void> {
  const ack = await client.request("harnessInstall", { harness: target });
  if (ack.accepted === false) throw new Error(`install refused: ${String(ack.message ?? "")}`);
  console.log(`installing ${target} on the Core — check with \`harness ls\``);
}

export async function run(client: CoreClient, ctx: Ctx): Promise<void> {
  const [verb, ...args] = ctx.positional;
  switch (verb) {
    case "ls":
    case undefined:
      await list(client);
      return;
    case "install":
      if (!args[0]) throw new UsageError("harness install needs a harness id", "harness");
      await install(client, args[0]);
      return;
    default:
      throw new UsageError(`unknown verb: harness ${verb}`, "harness");
  }
}
