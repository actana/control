// core — which Cores this client knows about.
//
// Purely local: it reads the blobs on disk and decodes them. Nothing here opens
// a connection, which is the point — it answers "what can I talk to" when the
// answer might be "nothing reachable".

import * as fs from "node:fs";

import { UsageError } from "../args.ts";
import { BLOBS_DIR, blobPath, listCores } from "../blob.ts";
import type { RegistrationBlob } from "../protocol.ts";

function peek(name: string): { endpoint: string; label: string } {
  try {
    const raw = fs.readFileSync(blobPath(name), "utf8").trim();
    const blob = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as RegistrationBlob;
    return { endpoint: blob.endpoint ?? "?", label: blob.label ?? "" };
  } catch {
    return { endpoint: "(unreadable)", label: "" };
  }
}

/** The Core that would be used if no --core were given. */
function ambient(): string | undefined {
  if (process.env.AC_BLOB?.trim()) return undefined;
  if (process.env.AC_BLOB_FILE) return undefined;
  return process.env.AC_CORE?.trim() || undefined;
}

export function list(selected?: string): void {
  const names = listCores();
  if (!names.length) {
    console.log(`(no Cores — put a blob in ${BLOBS_DIR} as <name>.txt)`);
    return;
  }
  const active = selected ?? ambient();
  console.log(`${"".padEnd(2)}${"NAME".padEnd(16)} ${"ENDPOINT".padEnd(24)} LABEL`);
  for (const name of names) {
    const { endpoint, label } = peek(name);
    const mark = name === active ? "* " : "  ";
    console.log(`${mark}${name.padEnd(16)} ${endpoint.padEnd(24)} ${label}`);
  }
  if (!active) {
    console.log(`\n(none selected — blob.txt is the fallback; pass --core <name> or set AC_CORE)`);
  }
}

/** No client: `core` is answered before any connection is opened. */
export function run(argv: string[], selected?: string): void {
  const verb = argv[0];
  switch (verb) {
    case "ls":
    case undefined:
      list(selected);
      return;
    default:
      throw new UsageError(`unknown verb: core ${verb}`, "core");
  }
}
