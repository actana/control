// A plain Node script that lists, uploads and downloads a Project's files
// (#129 F12, issue 167). No bundler, no loader, no TypeScript step.
//
// Run it:
//
//     ACTANA_CORE_BLOB=~/.config/actana/registration-blob.txt \
//     ACTANA_PROJECT_ID=p-… \
//       node packages/sdk/examples/project-files.mjs
//
// What it demonstrates is the shape rather than the API surface: **every one of
// these calls streams, and none of them buffers a file.** The download below
// goes straight to disk a chunk at a time, so the same six lines work on a
// gigabyte as on this README-sized file — which is the acceptance criterion
// this file answers, and the reason `download` hands back a stream and has no
// method that returns bytes.
//
// Note what has to happen before any of it: the script asks whether this Core
// *has* a file surface. A Core that predates it announces no `files` capability
// on `ready`, and that is a supported state — an old Core, not a broken one.
// Calling anyway would produce a 404 that looks like a missing file.

import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { CoreClient } from "@actana/sdk/core-client";

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

const projectId = process.env.ACTANA_PROJECT_ID;
if (!projectId) throw new Error("set ACTANA_PROJECT_ID to a Project on that Core");

const client = CoreClient.fromRegistrationBlob(loadBlob(), { connectTimeoutMs: 15_000 });
await client.connect();

try {
  // The gate, before anything is sent. `filesCapability()` has the version for
  // a caller that needs more than yes or no.
  if (!client.canUseFileRoutes()) {
    console.error("this Core has no file surface — it predates it, which is fine and not a fault");
    process.exit(1);
  }

  const project = client.project(projectId);

  console.log("— listing —");
  let listed = 0;
  for await (const entry of project.files.list()) {
    if (listed < 10) console.log(`  ${entry.path}  ${entry.size}b  ${entry.sha256 ?? "(no digest)"}`);
    listed += 1;
  }
  console.log(`  ${listed} entries`);

  console.log("— uploading this script into the Project —");
  const here = new URL(import.meta.url).pathname;
  for await (const line of project.files.upload({
    path: "sdk-example-upload.mjs",
    // A Node `Readable` is an async iterable of chunks, so a read stream is
    // accepted as-is. The file is never held whole in memory on either side.
    body: createReadStream(here),
    mode: 0o644,
  })) {
    if (line.type === "entry") console.log(`  ${line.result} ${line.path} (${line.size}b)`);
    else console.log(`  done: ${line.entries} entries, ${line.bytes} bytes`);
  }

  console.log("— downloading it back, straight to disk —");
  const { stream, size } = await project.files.download({ path: "sdk-example-upload.mjs" });
  const target = path.join(tmpdir(), "sdk-example-download.mjs");
  // Chunk by chunk. Nothing between the socket and the file holds more than one
  // chunk, whatever `size` says.
  await stream.pipeTo(Writable.toWeb(createWriteStream(target)));
  console.log(`  ${size} bytes → ${target}`);
} finally {
  client.close();
}
