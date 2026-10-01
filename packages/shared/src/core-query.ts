// Pure SQL helpers that read the Core's sessions table and map it to core-link
// snapshots for the Fleet view (issue 07, ADR 0001).
//
// The Core is the single source of truth for its Sessions; the Panel holds
// none. The `sessionRowsList` core-link frame delegates to a
// `CoreQueryPort` whose real implementation (packages/core/src/core-query-store.ts)
// opens the shared SQLite read-only and calls these helpers.
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser/server) and the Core's CommonJS tsconfigs. It operates on a
// minimal `CoreQuerySqlite` interface so tests can pass an in-memory
// better-sqlite3 handle without the full db/client bootstrap — mirroring
// `event-log.ts`.

import type { CoreLinkSessionRow as WireSessionRow } from "./sdk-link-frames";

/**
 * A Session row as this Core knows it, which is the wire's row: a Session belongs
 * to the Core, to nothing narrower (ADR 0041 D1), and the SDK no longer types
 * anything else.
 */
export type CoreSessionRow = WireSessionRow;

/**
 * Minimal slice of `better-sqlite3.Database` that the query helpers need.
 * Structural so a real `Database` and a test fake both satisfy it.
 */
export interface CoreQuerySqlite {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

type SessionRow = {
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
};

/**
 * Read every active (non-archived) session on this Core. Archived sessions are omitted — the Fleet view is for active
 * work, and the Panel caches nothing, so archived rows never cross the
 * core-link. Ordered by `updated_at` descending (most recent first) so live
 * work is at the top. Returns an empty array when
 * the table is absent or no rows match.
 */
export function querySessionRows(sqlite: CoreQuerySqlite): CoreSessionRow[] {
  return listSessionsWhereArchived(sqlite, 0);
}

/**
 * Read every archived session on this Core.
 * The exact mirror of {@link querySessionRows} — same columns, same ordering, the
 * opposite side of the `archived` flag.
 *
 * This is the Archived view's own read path (ADR 0019). It exists as a
 * separate helper rather than a parameter on {@link querySessionRows} so the
 * active/Fleet path cannot return an archived row by any argument a caller
 * passes: the two lists are different queries, answered by different frames.
 * Returns an empty array when the table is absent or no rows match.
 */
export function queryArchivedSessions(sqlite: CoreQuerySqlite): CoreSessionRow[] {
  return listSessionsWhereArchived(sqlite, 1);
}

/**
 * The one session-listing query both sides share, differing only in which side of
 * the `archived` flag it selects. `archived` is a literal in the SQL, not a
 * bound parameter, and the two public helpers are the only callers — so
 * neither list can be talked into returning the other's rows.
 */
function listSessionsWhereArchived(sqlite: CoreQuerySqlite, archived: 0 | 1): CoreSessionRow[] {
  const columns =
    `id, title, title_manually_set, claude_session_id, agent, status, ` +
    `pinned, archived, icon, updated_at`;
  let rows: SessionRow[];
  try {
    rows = sqlite
      .prepare(
        `SELECT ${columns}
         FROM sessions
         WHERE archived = ${archived}
         ORDER BY updated_at DESC`,
      )
      .all() as SessionRow[];
  } catch {
    return [];
  }
  return rows.map(sessionRowToSnapshot);
}

/**
 * Every session on this Core whose status still claims a live harness process —
 * `running` or `needs-input` (issue 243).
 *
 * The Core's boot sweep is the only caller, and the query is shaped for it in
 * two ways the listing helpers are not:
 *
 *  - **Archived rows are included.** The other listings answer a browse, where
 *    an archived row is out of scope by definition. This one answers "what
 *    does this database still claim is running?", and an archived Session that
 *    claims to be working is exactly as wrong as an active one — it is the same
 *    stale row, one tab further away from the operator who could notice it.
 *  - **No filter.** A process that did not survive the Core's restart did not
 *    survive it for one group of Sessions only.
 *
 * Returns an empty array when the table is absent, like every helper here.
 */
export function queryActiveSessions(sqlite: CoreQuerySqlite): CoreSessionRow[] {
  let rows: SessionRow[];
  try {
    rows = sqlite
      .prepare(
        `SELECT id, title, title_manually_set, claude_session_id, agent, status,
                pinned, archived, icon, updated_at
         FROM sessions
         WHERE status IN ('running', 'needs-input')
         ORDER BY updated_at DESC`,
      )
      .all() as SessionRow[];
  } catch {
    return [];
  }
  return rows.map(sessionRowToSnapshot);
}

/**
 * Every `ready` session on this Core that a PTY was once spawned for (issue 387).
 *
 * `ready` is the status a Session is born in, so it cannot be swept on the
 * strength of the status alone: a Session the operator created and has not
 * started yet is `ready`, has no process, and is correctly `ready` — flipping
 * it to `disconnected` on every Core restart would make a whole queue of
 * unstarted work look like it had died.
 *
 * What separates the two is whether this Core ever spawned a PTY for the row.
 * A bare Session — one started with no prompt, sitting on "Waiting for initial
 * prompt…" — spawns its harness immediately and stays `ready` until the first
 * `UserPromptSubmit`, so no hook ever fires for it and no status writer ever
 * touches it. Kill the Core under it and nothing comes back: the boot sweep's
 * `running` / `needs-input` filter never saw it, and the row outlived a
 * container recreate still claiming to be waiting for a prompt that nothing
 * was left to read. That is the zombie this query finds.
 *
 * The evidence is the `pty:spawn` the Core appended when it started the
 * harness. It is read from the event log rather than the session row because the
 * row records no such thing — there is no "was started" column, and the
 * harness session id stays `null` precisely in the bare case, where no hook
 * ever arrives to set it.
 *
 * Only an agent spawn is evidence. A `pty:spawn` is recorded for the `shell`
 * and `shellSession` variants too, which carry a `sessionId` for routing but are
 * not harness work. The VM-shell variant is excluded here by the payload's
 * `shellSession` flag. The plain `shell: true` variant is not distinguishable
 * in the payload — it records `shellSession: false`, the same as an agent —
 * and is separated by its session id instead: those spawns are addressed with a
 * synthetic id (`cli_shell_<uuid>`, or a user-terminal id) that matches no
 * `sessions` row, so the join drops them. The test pins that shape.
 *
 * Archived rows are included and no filter applies, for the same
 * reasons as {@link queryActiveSessions}.
 *
 * **The evidence is permanent.** Nothing in this repo prunes `event_log` —
 * there is no `DELETE FROM event_log` anywhere — so a `pty:spawn` recorded a
 * year ago still answers for its row. The consequence is a one-time batch: on
 * the first Core boot after this ships, EVERY historical `ready` row that ever
 * had a harness spawned settles to `disconnected` at once, each appending its
 * own `session:updated`. That is the backlog of zombies this query exists to
 * find, arriving in one go because nothing was looking for them before; every
 * later boot sees only what the run before it stranded. That batch also
 * REORDERS the operator's lists: a status patch stamps `updated_at`, and this
 * query, `querySessionRows` and `queryArchivedSessions` all order by it, so every row
 * it settles — archived ones included, since it spans them — floats to the top
 * of Fleet and Archived at the boot time, above recent work, and there is no
 * undoing it. If `event_log` ever grows a retention window, a row whose spawn
 * has aged out stops being swept — it would read as never-started, which is
 * the safe direction to fail in.
 *
 * Returns an empty array when either table is absent.
 */
export function queryStrandedReadySessions(sqlite: CoreQuerySqlite): CoreSessionRow[] {
  let rows: SessionRow[];
  try {
    rows = sqlite
      .prepare(
        `SELECT t.id AS id, t.title AS title,
                t.title_manually_set AS title_manually_set,
                t.claude_session_id AS claude_session_id, t.agent AS agent,
                t.status AS status, t.pinned AS pinned, t.archived AS archived,
                t.icon AS icon, t.updated_at AS updated_at
         FROM sessions t
         WHERE t.status = 'ready'
           AND EXISTS (
             SELECT 1 FROM event_log e
             WHERE e.session_id = t.id
               AND e.kind = 'pty:spawn'
               AND e.payload NOT LIKE '%"shellSession":true%'
           )
         ORDER BY t.updated_at DESC`,
      )
      .all() as SessionRow[];
  } catch {
    return [];
  }
  return rows.map(sessionRowToSnapshot);
}

/**
 * Positive proof that no status change on this Session's row has ever
 * described a turn (issue 387, review findings 2 and, for the shape of the
 * answer, round 2).
 *
 * The question a relaunch has to answer. Issue 387 moves a stranded `ready`
 * row to `disconnected`, and nothing writes `ready` back, so a bare Session
 * the operator reopens would sit at `disconnected` while its harness waits at
 * the prompt. Resetting the row on spawn is only right for a Session that
 * never worked: a genuinely finished one is being resumed, and its card must
 * keep saying so.
 *
 * The row cannot answer it. `claude_session_id` is captured on `SessionStart`
 * for Claude Code — the Core installs that hook — so a bare Session that has
 * never run a turn can still carry an id. What can answer it, for logs written
 * by this version, is the event log: every status change on a Core-owned row
 * is a `session:updated` carrying the status that was PATCHED
 * (`core-session-writer.ts` records the patch rather than the resulting row, for
 * exactly this kind of reader). A turn is any patched status other than the
 * two a Session reaches without working — `ready` (its birth, and this reset)
 * and `disconnected` (the sweep and the PTY-exit settle). `running`,
 * `needs-input`, `interrupted`, `finished` and `terminated` each say a turn
 * happened, including on a harness that goes straight from `ready` to
 * `finished` without ever reporting `running`.
 *
 * **"For logs written by this version" is the whole of the difficulty.**
 * `session:updated` only began carrying `status` in `2dd34a8` ("feat: await a
 * session turn"), shipped in v0.4.0; before it the payload was
 * `{sessionId}` and a grouping id, and nothing more. `event_log` is created
 * `IF NOT EXISTS` and — as {@link queryStrandedReadySessions} establishes — is
 * never pruned, so a Core upgraded from 0.3.x still holds every one of those
 * status-less rows, for Sessions that worked for hours.
 *
 * Read as "did any turn happen", their absence is indistinguishable from a
 * Session that never ran one, and the answer comes out backwards in the
 * destructive direction: a real `finished` card overwritten with `ready`. So
 * the read demands **positive evidence** instead. A row this PR settled always
 * carries a `"status":"disconnected"` `session:updated`, so a row with no
 * status-bearing `session:updated` at all is a legacy log, not a bare Session,
 * and answers `false` — "cannot tell, do not reset". `false` here therefore
 * means "worked, OR unknowable", and the caller wants the same thing of both.
 *
 * Matched with `LIKE` against the payload because the status rides in the JSON
 * body rather than a column; `status` is the last key the writer emits, and the
 * `"status":"…"` shape is fully quoted, so the patterns cannot straddle fields.
 * Both reads are bounded by `event_log_session_idx`. Answers `false` when the log
 * is unreadable, which is the same conservative direction.
 */
export function querySessionProvenNeverWorked(
  sqlite: CoreQuerySqlite,
  sessionId: string,
): boolean {
  try {
    // Positive evidence first: at least one status-bearing `session:updated`, or
    // this log predates v0.4.0 and cannot be read as proof of anything.
    const statusBearing = sqlite
      .prepare(
        `SELECT 1 AS hit FROM event_log
         WHERE session_id = ?
           AND kind = 'session:updated'
           AND payload LIKE '%"status":"%'
         LIMIT 1`,
      )
      .all(sessionId);
    if (statusBearing.length === 0) return false;

    const worked = sqlite
      .prepare(
        `SELECT 1 AS hit FROM event_log
         WHERE session_id = ?
           AND kind = 'session:updated'
           AND payload LIKE '%"status":"%'
           AND payload NOT LIKE '%"status":"ready"%'
           AND payload NOT LIKE '%"status":"disconnected"%'
         LIMIT 1`,
      )
      .all(sessionId);
    return worked.length === 0;
  } catch {
    return false;
  }
}

/**
 * How many archived sessions this Core holds.
 *
 * The Panel needs this number continuously — it gates the Archived tab, labels
 * it, and drives the auto-exit when the list empties — while the rows
 * themselves are wanted only when that view is open. So the count rides the
 * `sessionRowsList` answer as a scalar and {@link queryArchivedSessions} stays lazy
 * (ADR 0019). Returns 0 when the table is absent.
 */
export function countArchivedSessions(sqlite: CoreQuerySqlite): number {
  let rows: Array<{ n: number }>;
  try {
    rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE archived = 1`).all() as Array<{
      n: number;
    }>;
  } catch {
    return 0;
  }
  return rows[0]?.n ?? 0;
}

/**
 * Read one session by id, or `null` when this Core has no such row. Unlike
 * {@link querySessionRows} an archived row still answers: a caller asking by id
 * wants that row's facts (its status, its title), not a browse of active work.
 * Returns `null` when the table is absent, same as the listing helpers.
 */
export function querySession(
  sqlite: CoreQuerySqlite,
  sessionId: string,
): CoreSessionRow | null {
  let rows: SessionRow[];
  try {
    rows = sqlite
      .prepare(
        `SELECT id, title, title_manually_set, claude_session_id, agent, status,
                  pinned, archived, icon, updated_at
         FROM sessions
         WHERE id = ?`,
      )
      .all(sessionId) as SessionRow[];
  } catch {
    return null;
  }
  const row = rows[0];
  return row ? sessionRowToSnapshot(row) : null;
}

function sessionRowToSnapshot(row: SessionRow): CoreSessionRow {
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
