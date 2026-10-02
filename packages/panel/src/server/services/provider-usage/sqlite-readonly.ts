/**
 * Read-only access to OTHER tools' local SQLite files (Cursor and Windsurf
 * `state.vscdb`, OpenCode's `opencode.db`) for the provider-usage readers. These
 * are not Panel state — the Panel's own state lives in Postgres (ADR 0041 D14) —
 * so this is the one place the Panel opens a SQLite file, through Node's built-in
 * `node:sqlite` (D20), never a compiled module.
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const BUSY_TIMEOUT_MS = 250;

const nodeRequire = createRequire(import.meta.url);

/**
 * Run `load` with Node's "SQLite is an experimental feature" warning dropped.
 * Node versions that still print it would otherwise write it to the Panel's
 * stderr on the first provider-usage read. Every other warning passes through.
 */
export function withoutSqliteExperimentalWarning<T>(load: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]) {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const text = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = original;
  }
}

let driver: typeof import("node:sqlite") | null = null;

/**
 * Open an existing SQLite file read-only. Throws when the file is missing,
 * locked past the busy timeout, or not a database — callers already treat any
 * throw as "no usable local data".
 */
export function openReadOnlySqlite(dbPath: string): DatabaseSync {
  driver ??= withoutSqliteExperimentalWarning(() => nodeRequire("node:sqlite") as typeof import("node:sqlite"));
  return new driver.DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

/** A TEXT or BLOB cell as a string; null for any other shape. */
export function cellText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}
