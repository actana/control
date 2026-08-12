// Which Core does this command mean? (#129 D9.)
//
// Three sources, tried in this order and no other:
//
//   1. `--core <name>`      an explicit name, for a machine with several Cores
//   2. `ACTANA_CORE_BLOB`   single-Core mode: the blob itself, or a path to it
//   3. the `current` pointer  what `actana core use` last selected
//
// The order is the point, and it reads from most specific to least. A flag on
// the command line beats an environment variable because it was typed for this
// invocation; the environment beats the pointer because a CI job, a container
// or a `direnv` that exports a blob is describing the whole session, and it
// should not have to also mutate a file in `$HOME` to be believed. The pointer
// is last because it is the only one of the three that persists — the
// convenience for the interactive case, not an override of anything.
//
// **Nothing here dials.** Resolution answers "which credential" and hands back
// a blob object; connecting is `core-command.ts`'s business, and the SDK's.

import * as fs from "node:fs";
import * as path from "node:path";
import { decodeRegistrationBlobText } from "./registration-blob-file.ts";
import { loadCoreBlob, readCurrentCore, type RegistryPaths } from "./blob-registry.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";

/** The environment variable that puts the CLI in single-Core mode. */
export const CORE_BLOB_ENV = "ACTANA_CORE_BLOB";

/** Which of the three sources answered. */
export type CoreSource = "flag" | "env" | "current";

/** A Core to talk to, and the provenance of the credential that reaches it. */
export type ResolvedCore = {
  /**
   * The registry name, or null when the blob came from the environment — a
   * blob in `ACTANA_CORE_BLOB` has no name, because naming is what the registry
   * is for. Output says so rather than inventing one.
   */
  name: string | null;
  source: CoreSource;
  /** The blob *object*, which is all the SDK ever takes (#129 D9). */
  blob: CoreRegistrationBlob;
};

export type ResolveResult =
  | { ok: true; core: ResolvedCore }
  | { ok: false; error: string };

/**
 * Read `ACTANA_CORE_BLOB`: the base64 paste itself, or a path to a file holding
 * one.
 *
 * Both, because both are how people actually set it. A CI secret is pasted
 * straight into the variable; an operator on a machine that ran `actana setup`
 * points it at the file setup wrote. The discriminator is the shape of the
 * string — a leading `/` or `~` is a path, anything else is a paste — which is
 * unambiguous in practice because base64 has no `/` in the first character
 * position of a JSON-shaped payload and `~` is not in the alphabet at all.
 */
function blobFromEnv(raw: string, home: string): { ok: true; text: string } | { ok: false; error: string } {
  const value = raw.trim();
  const isPath = value.startsWith("/") || value.startsWith("~");
  if (!isPath) return { ok: true, text: value };
  const file = value.startsWith("~") ? path.join(home, value.slice(1)) : value;
  try {
    return { ok: true, text: fs.readFileSync(file, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // The path is the operator's own string and is safe to echo; the file's
    // contents never are, and nothing below reads them on this branch.
    return { ok: false, error: `${CORE_BLOB_ENV} points at ${file}, which could not be read (${code ?? "unknown error"})` };
  }
}

/**
 * Resolve the Core this command is about.
 *
 * Every failure names the source that failed rather than the general shape of
 * the problem: an operator who set `ACTANA_CORE_BLOB` to something malformed
 * and an operator who has never run `actana core add` are one message apart in
 * the code and a long way apart in what they should do next.
 */
export function resolveCore(opts: {
  paths: RegistryPaths;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The `--core <name>` value, or null when the flag was not given. */
  coreFlag: string | null;
}): ResolveResult {
  const { paths, env, home, coreFlag } = opts;

  // 1. --core <name>
  if (coreFlag !== null) {
    const loaded = loadCoreBlob(paths, coreFlag);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, core: { name: coreFlag, source: "flag", blob: loaded.blob } };
  }

  // 2. ACTANA_CORE_BLOB — single-Core mode.
  const fromEnv = env[CORE_BLOB_ENV]?.trim();
  if (fromEnv) {
    const text = blobFromEnv(fromEnv, home);
    if (!text.ok) return { ok: false, error: text.error };
    const decoded = decodeRegistrationBlobText(text.text);
    if (!decoded.ok) {
      return { ok: false, error: `${CORE_BLOB_ENV} is not a usable blob: ${decoded.error}` };
    }
    return { ok: true, core: { name: null, source: "env", blob: decoded.blob } };
  }

  // 3. the current pointer.
  const current = readCurrentCore(paths);
  if (current) {
    const loaded = loadCoreBlob(paths, current);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, core: { name: current, source: "current", blob: loaded.blob } };
  }

  return {
    ok: false,
    error:
      "no Core selected. Pass --core <name>, set " +
      CORE_BLOB_ENV +
      ", or run `actana core use <name>`. `actana core add <name>` registers one.",
  };
}

/** How a resolved Core is named in output. Never the blob, ever. */
export function describeResolvedCore(core: ResolvedCore): string {
  const where =
    core.source === "flag" ? "--core" : core.source === "env" ? CORE_BLOB_ENV : "current";
  return `${core.name ?? "(unnamed)"} [${where}] ${core.blob.endpoint}`;
}
