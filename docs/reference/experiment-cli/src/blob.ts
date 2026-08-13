// Where the pairing credentials come from, and which Core they point at.
//
// The blob carries a client key and a bearer. It is real credentials — keep it
// out of version control.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { RegistrationBlob } from "./protocol.ts";

/** Where the Core keeps it inside the container. */
const CONTAINER_BLOB_PATH = "/home/core/.config/actana/registration-blob.txt";

const packageRoot = path.resolve(import.meta.dirname, "..");

/** The local copy. Saves a `docker exec` per invocation, and works even when
 *  the container is stopped or the Core lives on another machine. */
export const LOCAL_BLOB = path.join(packageRoot, "blob.txt");

/**
 * Named Cores.
 *
 * One blob per file, named by what the Core is *for* rather than by container
 * or port — `--core pr` survives a rebuild that moves the port, a hardcoded
 * `wss://127.0.0.1:9443` does not. The name is the file's basename, the way
 * kubectl names a context.
 */
export const BLOBS_DIR = path.join(packageRoot, "blobs");

export function blobPath(name: string): string {
  return path.join(BLOBS_DIR, `${name}.txt`);
}

/** The Cores that have a blob on disk, in listing order. */
export function listCores(): string[] {
  if (!fs.existsSync(BLOBS_DIR)) return [];
  return fs
    .readdirSync(BLOBS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.slice(0, -4))
    .sort();
}

function readNamedCore(name: string): string {
  // A name is a bare identifier, not a path: `--core ../../secrets` should fail
  // as an unknown Core rather than read an arbitrary file.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`"${name}" is not a valid Core name (letters, digits, dot, dash, underscore)`);
  }
  const file = blobPath(name);
  if (!fs.existsSync(file)) {
    const known = listCores();
    throw new Error(
      `no Core named "${name}" — ${
        known.length ? `known Cores: ${known.join(", ")}` : `${BLOBS_DIR} has no blobs in it`
      }`,
    );
  }
  return fs.readFileSync(file, "utf8").trim();
}

/**
 * Resolve the blob for this invocation.
 *
 * Order, most explicit first:
 *   1. `--core <name>`   blobs/<name>.txt
 *   2. `AC_BLOB`         the blob itself
 *   3. `AC_BLOB_FILE`    a file holding it
 *   4. `AC_CORE`         blobs/<name>.txt, the ambient default
 *   5. `./blob.txt`      the unnamed local copy, as before
 *   6. `docker exec`     against `$AC_CONTAINER`
 *
 * Steps 5 and 6 are what the CLI did before named Cores existed, kept so that
 * every command already written keeps working untouched.
 */
export function loadBlob(core?: string): RegistrationBlob {
  let raw: string | undefined;
  let source: string;

  if (core) {
    raw = readNamedCore(core);
    source = `--core ${core}`;
  } else if (process.env.AC_BLOB?.trim()) {
    raw = process.env.AC_BLOB.trim();
    source = "AC_BLOB";
  } else if (process.env.AC_BLOB_FILE) {
    raw = fs.readFileSync(process.env.AC_BLOB_FILE, "utf8").trim();
    source = `AC_BLOB_FILE=${process.env.AC_BLOB_FILE}`;
  } else if (process.env.AC_CORE?.trim()) {
    raw = readNamedCore(process.env.AC_CORE.trim());
    source = `AC_CORE=${process.env.AC_CORE.trim()}`;
  } else if (fs.existsSync(LOCAL_BLOB)) {
    raw = fs.readFileSync(LOCAL_BLOB, "utf8").trim();
    source = "blob.txt";
  } else {
    const container = process.env.AC_CONTAINER ?? "rest-test";
    try {
      raw = execFileSync("docker", ["exec", container, "cat", CONTAINER_BLOB_PATH], {
        encoding: "utf8",
      }).trim();
      source = `docker exec ${container}`;
    } catch {
      const known = listCores();
      throw new Error(
        `could not read the pairing blob from container "${container}". ` +
          (known.length ? `Try --core <${known.join("|")}>, or set ` : `Set `) +
          `AC_CONTAINER, or pass the blob via AC_BLOB / AC_BLOB_FILE, ` +
          `or save it to ${LOCAL_BLOB}.`,
      );
    }
  }

  let blob: RegistrationBlob;
  try {
    // Standard base64 of the JSON — not base64url.
    blob = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as RegistrationBlob;
  } catch {
    throw new Error(`the blob from ${source} is not valid base64 JSON`);
  }
  if (!blob.endpoint?.startsWith("wss://")) {
    throw new Error(`blob endpoint from ${source} is not wss://: ${blob.endpoint}`);
  }
  return blob;
}
