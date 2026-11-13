// Paged Session listing for the Core (#960): keyset cursor, filters, total.
//
// Shared by the `sessionsList` and `sessionRowsList` core-link frames. Pure SQL
// over a minimal sqlite handle, so the Core's read-only store and the mutation
// store both call it. Order is "running and waiting first, then newest activity",
// made total by the id, so a cursor never repeats or skips a row while new
// Sessions start between pages.

import type { CoreQuerySqlite, CoreSessionRow } from "./core-query";

/** The most rows a page may ask for. */
export const SESSION_PAGE_MAX = 100;

export const SESSION_STATUS_FILTERS = ["running", "waiting", "finished"] as const;
export type SessionStatusFilter = (typeof SESSION_STATUS_FILTERS)[number];

export type SessionPageQuery = {
  limit: number;
  cursor?: string | null;
  status?: SessionStatusFilter;
  archived: boolean;
  harness?: string;
  q?: string;
  /** Only these Sessions (up to a page): how a client fetches the one row it needs beyond the loaded pages. */
  ids?: string[];
};

export type SessionPage = {
  rows: CoreSessionRow[];
  nextCursor: string | null;
  total: number;
};

/** A request the caller got wrong (bad limit, status or cursor). Maps to a 400. */
export class InvalidSessionPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionPageError";
  }
}

type Cursor = { rank: 0 | 1; updatedAt: number; id: string };

export function encodeSessionCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.rank, cursor.updatedAt, cursor.id])).toString("base64url");
}

export function decodeSessionCursor(raw: string): Cursor {
  const bad = () => new InvalidSessionPageError("invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw bad();
  const [rank, updatedAt, id] = parsed;
  if ((rank !== 0 && rank !== 1) || typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || typeof id !== "string") {
    throw bad();
  }
  return { rank, updatedAt, id };
}

/**
 * Read the paging fields off a frame. `null` when there is no `limit`: the
 * frame then answers exactly as it did before paging, so an older Panel keeps
 * working. Throws {@link InvalidSessionPageError} for a bad value.
 */
export function readSessionPageRequest(frame: {
  limit?: unknown;
  cursor?: unknown;
  status?: unknown;
  archived?: unknown;
  harness?: unknown;
  q?: unknown;
  ids?: unknown;
}): SessionPageQuery | null {
  if (frame.limit === undefined) return null;
  const { limit } = frame;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SESSION_PAGE_MAX) {
    throw new InvalidSessionPageError(`limit must be an integer from 1 to ${SESSION_PAGE_MAX}`);
  }
  const query: SessionPageQuery = { limit, archived: frame.archived === true };
  if (frame.cursor !== undefined && frame.cursor !== null) {
    if (typeof frame.cursor !== "string") throw new InvalidSessionPageError("invalid cursor");
    query.cursor = frame.cursor;
  }
  if (frame.status !== undefined) {
    if (!(SESSION_STATUS_FILTERS as readonly unknown[]).includes(frame.status)) {
      throw new InvalidSessionPageError(`status must be one of ${SESSION_STATUS_FILTERS.join(", ")}`);
    }
    query.status = frame.status as SessionStatusFilter;
  }
  if (typeof frame.harness === "string" && frame.harness.trim()) query.harness = frame.harness.trim();
  if (typeof frame.q === "string" && frame.q.trim()) query.q = frame.q.trim();
  if (frame.ids !== undefined) {
    if (
      !Array.isArray(frame.ids) ||
      frame.ids.length > SESSION_PAGE_MAX ||
      !frame.ids.every((id) => typeof id === "string" && id.length > 0)
    ) {
      throw new InvalidSessionPageError(`ids must be up to ${SESSION_PAGE_MAX} Session ids`);
    }
    query.ids = frame.ids as string[];
  }
  return query;
}

const RANK = `CASE WHEN status IN ('running', 'needs-input') THEN 0 ELSE 1 END`;

type PageRow = {
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
  rank: number;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One page of Sessions plus the total the filters match. An absent table
 * answers an empty page, like the other readers here.
 */
export function querySessionPage(sqlite: CoreQuerySqlite, query: SessionPageQuery): SessionPage {
  const where: string[] = ["archived = ?"];
  const params: unknown[] = [query.archived ? 1 : 0];
  if (query.status === "running") where.push(`status = 'running'`);
  else if (query.status === "waiting") where.push(`status = 'needs-input'`);
  else if (query.status === "finished") where.push(`status NOT IN ('running', 'needs-input', 'ready')`);
  if (query.harness) {
    where.push(`agent = ?`);
    params.push(query.harness);
  }
  if (query.q) {
    where.push(`title LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(query.q)}%`);
  }
  if (query.ids) {
    where.push(`id IN (${query.ids.map(() => "?").join(", ")})`);
    params.push(...query.ids);
  }
  const filters = where.join(" AND ");

  const keyset: string[] = [];
  const keysetParams: unknown[] = [];
  if (query.cursor) {
    const c = decodeSessionCursor(query.cursor);
    keyset.push(`(rank > ? OR (rank = ? AND updated_at < ?) OR (rank = ? AND updated_at = ? AND id < ?))`);
    keysetParams.push(c.rank, c.rank, c.updatedAt, c.rank, c.updatedAt, c.id);
  }

  let rows: PageRow[];
  let total: number;
  try {
    total = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${filters}`).all(...params)[0] as { n: number }
    ).n;
    rows = sqlite
      .prepare(
        `SELECT * FROM (
           SELECT id, title, title_manually_set, claude_session_id, agent, status,
                  pinned, archived, icon, updated_at, ${RANK} AS rank
           FROM sessions WHERE ${filters}
         ) ${keyset.length ? `WHERE ${keyset.join(" AND ")}` : ""}
         ORDER BY rank ASC, updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, ...keysetParams, query.limit + 1) as PageRow[];
  } catch {
    return { rows: [], nextCursor: null, total: 0 };
  }

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => ({
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
    })),
    nextCursor:
      hasMore && last ? encodeSessionCursor({ rank: last.rank === 0 ? 0 : 1, updatedAt: last.updated_at, id: last.id }) : null,
    total,
  };
}
