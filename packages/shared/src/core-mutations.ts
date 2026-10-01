// Pure SQL helpers that mutate the Core's sessions table and read the derived
// sessions view for the write path (issue 04, ADR 0004).
//
// The Core process is the sole VM-side writer of the shared SQLite (ADR
// 0004); on remote Cores no sibling stateful server exists, so
// `PtyCoreLinkServer` dispatches `sessionsMutate` / `sessionsList`
// frames to a `CoreMutationPort` whose real implementation
// (packages/core/src/core-mutation-store.ts) opens `missioncontrol.db` read-write
// and calls these helpers.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It operates on a
// minimal `CoreMutationSqlite` interface so tests can pass an in-memory
// better-sqlite3 handle without the full db/client bootstrap — mirroring
// `core-query.ts`.

import { newClientId } from "./client-id";
import type { CoreSessionRow } from "./core-query";
import type {
  CoreLinkSessionMutation,
  CoreLinkSessionSnapshot,
  CoreLinkSessionStatus,
} from "./sdk-link-frames";

/**
 * A Session mutation as this Core takes it: the wire's, except that a `create`
 * names no grouping at all. A Session is created on the Core and starts in its
 * home (ADR 0041 D1, D2); there is nothing to create it under. `update` and
 * `delete` are the wire's own.
 */
export type CoreSessionMutation =
  | Exclude<CoreLinkSessionMutation, { op: "create" }>
  | {
      op: "create";
      sessionId?: string;
      title: string;
      agent: string;
      status?: CoreLinkSessionStatus;
      icon?: string | null;
    };

/**
 * Minimal slice of `better-sqlite3.Database` that the mutation helpers need.
 * Structural so a real `Database` and a test fake both satisfy it. `prepare`
 * returns a statement with both `run` (for writes) and `all`/`get` (for
 * read-back after write).
 */
export interface CoreMutationSqlite {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * A liveness probe: given a `sessionId`, return the live `ptyId` if one is
 * currently running for that session, else `null`. `sessionsList` uses this to
 * enrich session rows with their optional live PTY so a reconnecting Panel knows
 * which sessions it can reattach to. Passed in from the caller so this module
 * stays SQL-only (no dependency on `PtyCore`).
 */
export type LivePtyProbe = (sessionId: string) => string | null;

// ─── Session mutations ─────────────────────────────────────────────────────────

type SessionInsert = Extract<CoreSessionMutation, { op: "create" }>;
type SessionUpdate = Extract<CoreSessionMutation, { op: "update" }>;

const DEFAULT_SESSION_STATUS = "ready";
const DEFAULT_SESSION_BRANCH = "main";

/**
 * Insert a new session row and return its snapshot. `title` and
 * `agent` are required (validated here). `sessionId` is caller-supplied when the
 * Panel wants optimistic-UI parity, else generated on the Core.
 */
export function createSession(
  sqlite: CoreMutationSqlite,
  input: SessionInsert,
  now: number,
): CoreSessionRow {
  const title = input.title?.trim();
  const agent = input.agent?.trim();
  if (!title) throw new Error("session title is required");
  if (!agent) throw new Error("session agent is required");
  const id = input.sessionId?.trim() || newClientId("t");
  const status = input.status?.trim() || DEFAULT_SESSION_STATUS;
  const icon = normalizeIconInput(input.icon);
  sqlite
    .prepare(
      `INSERT INTO sessions (
         id, title, agent, status, icon, branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, agent, status, icon, DEFAULT_SESSION_BRANCH, now, now);
  return {
    sessionId: id,
    title,
    // A fresh row's title is whatever the create frame carried — the sentinel
    // for a Session the Core is about to name, or a title typed into the
    // new-session dialog. Neither is a rename of an existing name, so the
    // column keeps its `0` default and the snapshot says so.
    titleManuallySet: false,
    claudeSessionId: null,
    agent,
    status,
    pinned: false,
    archived: false,
    icon,
    updatedAt: now,
  };
}

/**
 * Record the standard prompt block version a Session's starting prompt carried
 * (ADR 0026, issue 563). Not a wire mutation: only the Core delivers prompts,
 * so no client has a say in it.
 */
export function recordPromptBlockVersion(sqlite: CoreMutationSqlite, sessionId: string, version: number): void {
  sqlite.prepare("UPDATE sessions SET prompt_block_version = ? WHERE id = ?").run(version, sessionId);
}

/**
 * Normalize a caller-supplied icon value into what the SQL column stores.
 * `undefined` → `null` (create); trimmed empty string → `null`; else the trimmed
 * string. The Core does not validate against `SESSION_ICON_OPTIONS` — the
 * Panel-side `isSessionIcon` guard falls back to `DEFAULT_SESSION_ICON` when a
 * row carries an unknown id, so a Core on a newer version can hand a Panel
 * on an older version an icon it doesn't render without breaking the cell.
 */
function normalizeIconInput(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Patch an existing session row. Fields omitted from `input` are left untouched
 * (partial update). Returns the updated snapshot, or `null` when the row is
 * missing.
 */
export function updateSession(
  sqlite: CoreMutationSqlite,
  input: SessionUpdate,
  now: number,
): CoreSessionRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.title !== undefined) {
    const trimmed = input.title.trim();
    if (!trimmed) throw new Error("session title cannot be empty");
    sets.push("title = ?");
    params.push(trimmed);
    // Mirror the local server controller (sessions.controller.ts): a title on an
    // update is a manual rename unless the caller says otherwise, so pin the
    // flag that stops the auto title-generator from clobbering it. The Core's
    // own generator is the one caller that says otherwise (issue 84) — its
    // write must leave the row nameable again by an operator, and must not
    // make the NEXT generated title look like a rename to protect.
    sets.push("title_manually_set = ?");
    params.push(input.titleManuallySet === false ? 0 : 1);
  }
  if (input.claudeSessionId !== undefined) {
    // The harness's own session id is Core state like every other column on
    // the row (issue 84) — a Panel that wrote it to its own database left the
    // Core's row blank and the reattach guessed.
    const trimmed = input.claudeSessionId?.trim();
    sets.push("claude_session_id = ?");
    params.push(trimmed ? trimmed : null);
  }
  if (input.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(input.pinned ? 1 : 0);
  }
  if (input.archived !== undefined) {
    sets.push("archived = ?");
    params.push(input.archived ? 1 : 0);
  }
  if (input.icon !== undefined) {
    sets.push("icon = ?");
    params.push(normalizeIconInput(input.icon));
  }
  if (sets.length === 0) {
    // No-op patch: still bump updated_at so the Panel's live snapshot moves.
    // Return the existing row unchanged.
    return readSessionSnapshot(sqlite, input.sessionId);
  }
  // Strictly increasing per row, never just the wall clock: `updated_at` is
  // also the row's revision — the session backstop records it after its own
  // write and treats any other value as somebody else's (issue 588). Two writes
  // in one millisecond would otherwise carry one value and be indistinguishable.
  sets.push("updated_at = MAX(?, updated_at + 1)");
  params.push(now);
  params.push(input.sessionId);
  const result = sqlite
    .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  if (result.changes === 0) return null;
  return readSessionSnapshot(sqlite, input.sessionId);
}

/**
 * Delete a session row and return the snapshot of what was removed. SQLite's
 * ON DELETE CASCADE takes the rows hanging off it (terminal_logs, prompts,
 * token_usage, …) — the same hard delete the Panel server's `deleteSession`
 * performs for a Panel-owned row. Returns `null` when nothing matched, the way
 * {@link updateSession} reports a missing row, so the server answers
 * `sessionsMutateResult` with a null session rather than an `error` frame.
 *
 * The pre-delete snapshot is what comes back so
 * `sessionsMutateResult.session` carries the same shape for every op and the
 * caller doesn't branch on `op` to read the answer.
 *
 * No pending-question clear rides along, unlike the Panel server's delete.
 * A pending question is an in-memory map on the *Panel* server, filled by the
 * hooks route, which resolves the session against the Panel's own database — so a
 * Core-owned session never gets an entry to clear. Nothing on the Core tracks one.
 * The Panel-side state that does follow a Core-owned session (its stored
 * session-finish notifications) is pruned off the `session:deleted` event this
 * delete appends.
 */
export function deleteSession(
  sqlite: CoreMutationSqlite,
  sessionId: string,
): CoreSessionRow | null {
  const before = readSessionSnapshot(sqlite, sessionId);
  if (!before) return null;
  sqlite.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  return before;
}

function readSessionSnapshot(
  sqlite: CoreMutationSqlite,
  sessionId: string,
): CoreSessionRow | null {
  const row = sqlite
    .prepare(
      `SELECT id, title, title_manually_set, claude_session_id, agent, status,
              pinned, archived, icon, updated_at
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | {
        id: string;
        title: string;
        title_manually_set: number;
        claude_session_id: string | null;
        agent: string;
        status: string;
        pinned: number;
        archived: number;
        icon: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    sessionId: row.id,
    title: row.title,
    titleManuallySet: row.title_manually_set === 1,
    claudeSessionId: row.claude_session_id,
    agent: row.agent,
    status: row.status,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    icon: row.icon,
    updatedAt: row.updated_at,
  };
}

// ─── Sessions view ──────────────────────────────────────────────────────────

/**
 * Read every active (non-archived) session as a session snapshot. `probe` enriches each row with its live `ptyId`
 * (if the Core's PTY core currently has one for that session), so a
 * reconnecting Panel knows which sessions it can reattach to. Rows are
 * ordered `updated_at` DESC — same as `querySessionRows`.
 */
export function querySessions(
  sqlite: CoreMutationSqlite,
  probe: LivePtyProbe,
): CoreLinkSessionSnapshot[] {
  let rows: { id: string; status: string; updated_at: number }[];
  try {
    rows = sqlite
      .prepare(
        `SELECT id, status, updated_at FROM sessions
         WHERE archived = 0 ORDER BY updated_at DESC`,
      )
      .all() as typeof rows;
  } catch {
    return [];
  }
  return rows.map((row) => ({
    sessionId: row.id,
    ptyId: probe(row.id),
    status: row.status,
    updatedAt: row.updated_at,
  }));
}
