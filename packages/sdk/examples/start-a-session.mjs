// A plain Node script that starts a Session on a Core, sends it a prompt, and
// reads the result. No terminal is involved anywhere (#129 D11, issue 155).
//
// Run it:
//
//     ACTANA_CORE_BLOB=~/.config/actana/registration-blob.txt \
//     ACTANA_PROJECT_ID=p-… \
//     ACTANA_CWD=/home/op/projects/thing \
//       node packages/sdk/examples/start-a-session.mjs "summarise this repo"
//
// `node`, directly — no bundler, no loader, no TypeScript step. That is the
// point of the acceptance criterion this file answers: the SDK has to be usable
// from a cron job, a CI runner and a web service, none of which has a terminal,
// and two of which have no build step either.
//
// Note what is NOT here. Nothing reads `process.stdin`, nothing sets raw mode,
// nothing asks whether a TTY exists. And nothing waits a fixed number of
// milliseconds for the harness to be ready before sending the prompt: the
// prompt is handed to the Core as text, the Core delivers it on the harness's
// own schedule (ADR 0026), and this script waits for the Core to report the
// turn over. The script does not know which harness it started, what that
// harness paints while it boots, or which dialog it opens first — and it does
// not need to.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CoreClient } from "@actana/sdk/core-client";
import { CoreSession } from "@actana/sdk/core-session";

/** The registration blob: the base64 paste itself, or a path to the file holding it. */
function loadBlob() {
  const raw = process.env.ACTANA_CORE_BLOB?.trim();
  if (!raw) throw new Error("set ACTANA_CORE_BLOB to a registration blob or a path to one");
  const source =
    raw.startsWith("~") || raw.startsWith("/")
      ? readFileSync(raw.replace(/^~/, homedir()), "utf8")
      : raw;
  return JSON.parse(Buffer.from(source.trim(), "base64").toString("utf8"));
}

const prompt = process.argv[2] ?? "Reply with exactly: hello from the SDK";
const projectId = process.env.ACTANA_PROJECT_ID;
const cwd = process.env.ACTANA_CWD;
if (!projectId || !cwd) {
  throw new Error("set ACTANA_PROJECT_ID and ACTANA_CWD (a path inside that Project's root)");
}

const client = CoreClient.fromRegistrationBlob(loadBlob(), { connectTimeoutMs: 15_000 });
const info = await client.connect();
console.log(`connected to ${info.coreId} (core-link ${info.protocolVersion})`);

// The Core validates the working directory against its registered Projects, the
// command's binary against the harness's canonical one, and every flag against
// its allow-list. A rejection arrives here as a thrown error carrying the Core's
// own reason — this script does not second-guess any of it in advance.
const session = await CoreSession.start(client, {
  projectId,
  cwd,
  harness: process.env.ACTANA_HARNESS ?? "claude-code",
  title: "SDK example session",
  prompt,
  dangerouslySkipPermissions: process.env.ACTANA_SKIP_PERMISSIONS === "1",
});
console.log(`session ${session.taskId} running on pty ${session.ptyId}`);

session.onStatus((status) => console.log(`  status → ${status}`));

// Waits on the Core's report — the harness's own lifecycle hooks moving the
// Session's status — not on the output going quiet.
const idle = await session.waitForIdle({ timeoutMs: Number(process.env.ACTANA_TIMEOUT_MS ?? 300_000) });
console.log(`settled: ${idle.status}${idle.exited ? ` (process exited ${idle.exitCode})` : ""}`);

// What a terminal would be showing, including everything that scrolled off the
// top of it — which is where the harness's answer is, several screens back.
console.log("─".repeat(60));
console.log(session.screen());
console.log("─".repeat(60));

await session.kill();
client.close();
