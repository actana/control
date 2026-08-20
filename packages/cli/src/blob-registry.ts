// The blob registry, as the client half reads it (#129 D9).
//
//   $XDG_CONFIG_HOME/actana/cores/<name>.txt   the blob, mode 0600
//   $XDG_CONFIG_HOME/actana/current.txt        the `current` pointer, a name
//
// **The on-disk half of this module now lives in `@actana/shared/blob-registry`
// and is re-exported below unchanged**, so every caller here keeps importing
// one name from one place. It moved because a second program writes this
// registry: a containerised Core has no `actana setup` to wire it to the CLI on
// its own machine, so the daemon does it for itself at boot (#288 D9), and two
// implementations of where a credential lives on one machine is exactly the
// disagreement this registry exists to prevent. The import is inlined into the
// published bundle rather than depended on (#288 D5) — the argument is in
// `__tests__/no-local-escape.test.ts`.
//
// What stays here is the part that cannot move: reading an entry back as a
// `core ls` *row*, which decodes the blob and therefore needs the SDK's blob
// type and this package's own decoder (`registration-blob-file.ts`, itself a
// deliberate copy — ADR 0025 D3).

import * as fs from "node:fs";
import { decodeRegistrationBlobText, summarizeBlob, type BlobSummary } from "./registration-blob-file.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";
import {
  coreBlobPath,
  coreNameError,
  listCoreNames,
  readCoreBlobText,
  readCurrentCore,
  type RegistryPaths,
} from "@actana/shared/blob-registry";

export {
  BLOB_FILE_MODE,
  REGISTRY_DIR_MODE,
  clearCurrentCore,
  coreBlobPath,
  coreExists,
  coreNameError,
  listCoreNames,
  listUsableCoreNames,
  readCoreBlobText,
  readCurrentCore,
  registryPaths,
  removeCoreBlob,
  writeCoreBlob,
  writeCurrentCore,
} from "@actana/shared/blob-registry";
export type { RegistryPaths } from "@actana/shared/blob-registry";

/** One row of `actana core ls`: what is known about a Core without dialling it. */
export type RegisteredCore = {
  name: string;
  /** True for the Core the `current` pointer names. */
  current: boolean;
  /** The endpoint and label off the stored blob, or null when it will not decode. */
  summary: BlobSummary | null;
  /**
   * Why the stored blob will not decode, when it will not. A registry entry
   * that is corrupt is a thing an operator has to be told about — silently
   * omitting the row would leave `core ls` disagreeing with `ls ~/.config`.
   */
  error: string | null;
  /**
   * True when the stored file is readable by somebody other than its owner.
   *
   * Reported rather than repaired: this package wrote it 0600, so a loose mode
   * means something else touched the file — a restore from a backup, a `cp -r`
   * of a home directory, a synced dotfiles repository — and the operator wants
   * to know which of those happened, not have the evidence quietly chmodded
   * away underneath them.
   */
  insecureMode: boolean;
};

/** Read one registry entry, without dialling anything. */
export function readRegisteredCore(paths: RegistryPaths, name: string, current: string | null): RegisteredCore {
  const text = readCoreBlobText(paths, name);
  const row: RegisteredCore = {
    name,
    current: current === name,
    summary: null,
    error: null,
    insecureMode: false,
  };
  try {
    const mode = fs.statSync(coreBlobPath(paths, name)).mode & 0o777;
    row.insecureMode = (mode & 0o077) !== 0;
  } catch {
    // A file that vanished between the listing and the stat is not a mode
    // problem, and the decode below reports it as the missing entry it is.
  }
  // A name no verb will accept is the row's headline, ahead of whatever is in
  // the file: the operator cannot `use`, `status` or `rm` this entry whatever it
  // decodes to, and renaming the file is the one action that changes that.
  const nameError = coreNameError(name);
  if (nameError !== null) {
    row.error = `not a usable Core name (${nameError}) — rename ${name}.txt to reach it`;
    return row;
  }
  if (text === null) {
    row.error = "no blob stored for this Core";
    return row;
  }
  const decoded = decodeRegistrationBlobText(text);
  if (!decoded.ok) {
    row.error = decoded.error;
    return row;
  }
  row.summary = summarizeBlob(decoded.blob);
  return row;
}

/** Every registry entry, in `listCoreNames` order. */
export function readRegistry(paths: RegistryPaths): RegisteredCore[] {
  const current = readCurrentCore(paths);
  return listCoreNames(paths).map((name) => readRegisteredCore(paths, name, current));
}

/**
 * The blob for a named Core, decoded — or the one line saying why not.
 *
 * The returned object is what the SDK takes (#129 D9): a blob *object*, with
 * no path, no encoding and no notion of a registry anywhere on it.
 */
export function loadCoreBlob(
  paths: RegistryPaths,
  name: string,
): { ok: true; blob: CoreRegistrationBlob } | { ok: false; error: string } {
  const text = readCoreBlobText(paths, name);
  if (text === null) {
    return { ok: false, error: `no Core named ${name} — \`actana core ls\` lists what this machine knows` };
  }
  const decoded = decodeRegistrationBlobText(text);
  if (!decoded.ok) {
    return { ok: false, error: `the stored blob for ${name} is unusable: ${decoded.error}` };
  }
  return { ok: true, blob: decoded.blob };
}
