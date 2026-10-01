// Core-side mutation store — a read-write handle to the shared SQLite's
// sessions table, owned by the Core (PTY-manager) process.
//
// Backs the `CoreMutationPort` consumed by `PtyCoreLinkServer` for the
// `sessionsMutate` / `sessionsList` core-link frames (issue
// 04, ADR 0004). On a remote Core no sibling stateful server runs, so the
// Core itself owns writes against `missioncontrol.db` — schema bootstrap
// (issue 02), read snapshots (issue 07), and now mutations (this file) all
// live in the same process. Pure SQL helpers in `src/shared/core-mutations.ts`
// are the shape; this file just owns the RW connection lifecycle.
//
// Mirrors the connection pattern in event-log-store.ts and core-query-store.ts:
// lazy open, degrade gracefully when the DB is missing (the bootstrap step must
// have created it — if it didn't, the mutation port errors rather than silently
// writing nothing), `busy_timeout` absorbs brief write contention with the
// event-log writer.

import Database from "better-sqlite3";
import log from "@actana/shared/log";
import * as path from "node:path";
import {
  createSession as createSessionSql,
  deleteSession as deleteSessionSql,
  querySessions as querySessionsSql,
  updateSession as updateSessionSql,
  type CoreMutationSqlite,
  type CoreSessionMutation,
  type LivePtyProbe,
} from "@actana/shared/core-mutations";
import type { CoreSessionRow } from "@actana/shared/core-query";
import type { CoreLinkSessionSnapshot } from "@actana/sdk/core";
import type { CoreMutationPort } from "./pty-core-link-server";

export type { CoreMutationPort };

let db: Database.Database | null = null;
let dbPath: string | null = null;
let livePtyProbe: LivePtyProbe = () => null;

/**
 * Configure the mutation store to point at the shared SQLite file. Must be
 * called before any {@link coreMutationStore} use. The connection is opened
 * lazily on first mutation so a mis-configured path doesn't crash boot — it
 * throws on the first frame instead.
 */
export function configureCoreMutationStore(userDataDir: string): void {
  disposeCoreMutationStore();
  dbPath = path.join(userDataDir, "missioncontrol.db");
}

/**
 * Register the live-PTY probe used by `listSessions` to enrich session rows with
 * their currently-running `ptyId`. Called from the Core entry after
 * `PtyCore` is constructed — kept as a setter so this module has no
 * import-time dependency on `PtyCore`.
 */
export function setLivePtyProbe(probe: LivePtyProbe): void {
  livePtyProbe = probe;
}

function ensureConnection(): Database.Database {
  if (!dbPath) {
    throw new Error("core-mutation.unconfigured");
  }
  if (db) return db;
  const conn = new Database(dbPath);
  try {
    conn.pragma("journal_mode = WAL");
    conn.pragma("busy_timeout = 5000");
    conn.pragma("foreign_keys = ON");
  } catch (pragmaErr) {
    log.info("core-mutation.pragma-skipped", { error: String(pragmaErr) });
  }
  db = conn;
  return db;
}

/**
 * The read-write `CoreMutationPort` backed by the shared SQLite. Throws on
 * a missing/invalid DB rather than silently returning `null` — the caller
 * (`PtyCoreLinkServer`) translates thrown errors into `error` frames so the
 * Panel sees the reason instead of "nothing happened".
 *
 * The Core passes this to `PtyCoreLinkServer` so the Panel's
 * `sessionsMutate` / `sessionsList` frames resolve against
 * the same DB the read-only query port serves — one shared SQLite, WAL keeps
 * a reader coexisting with two writers (event log + row mutations).
 */
export const coreMutationStore: CoreMutationPort = {
  mutateSession(mutation: CoreSessionMutation): CoreSessionRow | null {
    const conn = ensureConnection() as unknown as CoreMutationSqlite;
    const now = Date.now();
    switch (mutation.op) {
      case "create":
        return createSessionSql(conn, mutation, now);
      case "update":
        return updateSessionSql(conn, mutation, now);
      case "delete":
        return deleteSessionSql(conn, mutation.sessionId);
    }
    throw new Error(`unknown session mutation op: ${(mutation as { op?: string }).op}`);
  },
  listSessions(): CoreLinkSessionSnapshot[] {
    const conn = ensureConnection() as unknown as CoreMutationSqlite;
    return querySessionsSql(conn, livePtyProbe);
  },
};

/** Close the connection. Called on Core shutdown. */
export function disposeCoreMutationStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
  livePtyProbe = () => null;
}
