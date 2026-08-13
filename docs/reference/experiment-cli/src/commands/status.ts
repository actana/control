// status — is this Core reachable, and what does it have on it.

import type { Ctx } from "../args.ts";
import type { CoreClient } from "../client.ts";
import { PROTOCOL_VERSION } from "../protocol.ts";
import type { Project, Session } from "../protocol.ts";
import { availability } from "./harness.ts";

export async function run(client: CoreClient, _ctx: Ctx): Promise<void> {
  const harnesses = await availability(client);
  const projects = await client.call<Project[]>("projectsList");
  const sessions = await client.call<Session[]>("sessionsList");
  const live = sessions.filter((s) => s.ptyId).length;

  console.log(`endpoint    ${client.blob.endpoint}`);
  console.log(`label       ${client.blob.label ?? "(none)"}`);
  console.log(`protocol    ${PROTOCOL_VERSION} (client)`);
  console.log(`projects    ${projects.length}`);
  console.log(`sessions    ${live} running, ${sessions.length} total`);
  console.log(
    `harnesses   ${Object.entries(harnesses)
      .map(([id, entry]) => `${id}=${entry.status}`)
      .join("  ")}`,
  );
}
