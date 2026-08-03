// Harness-side mutation store — a read-write handle to the shared SQLite's
// projects + tasks tables, owned by the Harness (PTY-manager) process.
//
// Backs the `HarnessMutationPort` consumed by `PtyCoreLinkServer` for the
// `projectsMutate` / `tasksMutate` / `sessionsList` core-link frames (issue
// 04, ADR 0004). On a remote Core no sibling stateful server runs, so the
// Harness itself owns writes against `missioncontrol.db` — schema bootstrap
// (issue 02), read snapshots (issue 07), and now mutations (this file) all
// live in the same process. Pure SQL helpers in `src/shared/harness-mutations.ts`
// are the shape; this file just owns the RW connection lifecycle and threads
// the Node-side path probe through path validation.
//
// Mirrors the connection pattern in event-log-store.ts and harness-query-store.ts:
// lazy open, degrade gracefully when the DB is missing (the bootstrap step must
// have created it — if it didn't, the mutation port errors rather than silently
// writing nothing), `busy_timeout` absorbs brief write contention with the
// event-log writer.

import Database from "better-sqlite3";
import log from "./log";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  archiveProject as archiveProjectSql,
  createProject as createProjectSql,
  createTask as createTaskSql,
  pinProject as pinProjectSql,
  querySessions as querySessionsSql,
  renameProject as renameProjectSql,
  updateTask as updateTaskSql,
  validateProjectPath,
  type HarnessMutationSqlite,
  type LivePtyProbe,
  type ProjectPathProbe,
} from "../../shared/src/harness-mutations";
import type {
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
  CoreLinkSessionSnapshot,
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "../../shared/src/core-link-frames";
import type { HarnessMutationPort } from "./pty-core-link-server";

export type { HarnessMutationPort };

let db: Database.Database | null = null;
let dbPath: string | null = null;
let livePtyProbe: LivePtyProbe = () => null;

const NODE_PATH_PROBE: ProjectPathProbe = {
  isAbsolute: (p) => path.isAbsolute(p),
  statSync: (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  },
};

/**
 * Configure the mutation store to point at the shared SQLite file. Must be
 * called before any {@link harnessMutationStore} use. The connection is opened
 * lazily on first mutation so a mis-configured path doesn't crash boot — it
 * throws on the first frame instead.
 */
export function configureHarnessMutationStore(userDataDir: string): void {
  disposeHarnessMutationStore();
  dbPath = path.join(userDataDir, "missioncontrol.db");
}

/**
 * Register the live-PTY probe used by `listSessions` to enrich task rows with
 * their currently-running `ptyId`. Called from the Harness entry after
 * `PtyHarnessCore` is constructed — kept as a setter so this module has no
 * import-time dependency on `PtyHarnessCore`.
 */
export function setLivePtyProbe(probe: LivePtyProbe): void {
  livePtyProbe = probe;
}

function ensureConnection(): Database.Database {
  if (!dbPath) {
    throw new Error("harness-mutation.unconfigured");
  }
  if (db) return db;
  const conn = new Database(dbPath);
  try {
    conn.pragma("journal_mode = WAL");
    conn.pragma("busy_timeout = 5000");
    conn.pragma("foreign_keys = ON");
  } catch (pragmaErr) {
    log.info("harness-mutation.pragma-skipped", { error: String(pragmaErr) });
  }
  db = conn;
  return db;
}

/**
 * The read-write `HarnessMutationPort` backed by the shared SQLite. Throws on
 * a missing/invalid DB rather than silently returning `null` — the caller
 * (`PtyCoreLinkServer`) translates thrown errors into `error` frames so the
 * Panel sees "project path missing" instead of "nothing happened".
 *
 * The Harness passes this to `PtyCoreLinkServer` so the Panel's
 * `projectsMutate` / `tasksMutate` / `sessionsList` frames resolve against
 * the same DB the read-only query port serves — one shared SQLite, WAL keeps
 * a reader coexisting with two writers (event log + row mutations).
 */
export const harnessMutationStore: HarnessMutationPort = {
  mutateProject(mutation: CoreLinkProjectMutation): CoreLinkProjectSnapshot | null {
    const conn = ensureConnection() as unknown as HarnessMutationSqlite;
    const now = Date.now();
    switch (mutation.op) {
      case "create": {
        const validatedPath = validateProjectPath(mutation.path, NODE_PATH_PROBE);
        return createProjectSql(conn, mutation, validatedPath, now);
      }
      case "rename":
        return renameProjectSql(conn, mutation.projectId, mutation.name, now);
      case "archive":
        return archiveProjectSql(conn, mutation.projectId);
      case "pin":
        return pinProjectSql(conn, mutation.projectId, mutation.pinned, now);
    }
    // Runtime guard for a stale-shape frame that parsed as `projectsMutate`
    // but carried an unknown `op`. `parseCoreLinkRequestFrame` only checks
    // the outer `type`, so a Panel sending an older or malformed mutation
    // payload lands here — throw so the server sends an actionable `error`
    // frame instead of silently no-op'ing.
    throw new Error(`unknown project mutation op: ${(mutation as { op?: string }).op}`);
  },
  mutateTask(mutation: CoreLinkTaskMutation): CoreLinkTaskSnapshot | null {
    const conn = ensureConnection() as unknown as HarnessMutationSqlite;
    const now = Date.now();
    switch (mutation.op) {
      case "create":
        return createTaskSql(conn, mutation, now);
      case "update":
        return updateTaskSql(conn, mutation, now);
    }
    throw new Error(`unknown task mutation op: ${(mutation as { op?: string }).op}`);
  },
  listSessions(projectId?: string): CoreLinkSessionSnapshot[] {
    const conn = ensureConnection() as unknown as HarnessMutationSqlite;
    return querySessionsSql(conn, livePtyProbe, projectId);
  },
};

/** Close the connection. Called on Harness shutdown. */
export function disposeHarnessMutationStore(): void {
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
