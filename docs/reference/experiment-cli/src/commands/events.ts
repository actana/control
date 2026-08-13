// events — the Core's event log: task and session lifecycle, harness installs.

import type { Ctx } from "../args.ts";
import type { CoreClient } from "../client.ts";

export async function run(client: CoreClient, ctx: Ctx): Promise<void> {
  // lastEventId 0 replays the log from the beginning; --since picks up later.
  const since = Number(ctx.flag("since") ?? 0);
  await client.subscribe(Number.isFinite(since) ? since : 0);
  ctx.keepOpen = true;

  const only = ctx.flag("kind");
  client.onEvent = (event) => {
    const kind = String(event.kind);
    if (only && !kind.startsWith(only)) return;
    console.log(`${event.eventId}\t${kind}\t${String(event.payload)}`);
  };
  console.error("[streaming events — ctrl-c to stop]");
}
