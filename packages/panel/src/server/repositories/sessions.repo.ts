import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "~/db/client";
import { sessions } from "~/db/schema";
import type { Session } from "~/db/schema";

export function findAllSessions(): Session[] {
  return getDb().select().from(sessions).all();
}

// Sessions whose status claims a live agent process. Used by the startup sweep:
// at Panel boot no PTYs exist yet, so any such session is an orphan of a
// previous run.
export function findActiveLocalSessions(): Session[] {
  return getDb()
    .select()
    .from(sessions)
    .where(inArray(sessions.status, ["running", "needs-input"]))
    .all();
}

// Hot path (every session read + status poll). Hoist the prepared statement once
// so drizzle/better-sqlite3 skips re-parsing and re-planning the query on each
// call. Lazily built on first use because getDb() must open the connection
// first. `sql.placeholder` binds the id per call.
function buildFindSessionByIdStmt() {
  return getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.id, sql.placeholder("id")))
    .prepare();
}
let findSessionByIdStmt: ReturnType<typeof buildFindSessionByIdStmt> | null = null;

export function findSessionById(id: string): Session | null {
  if (!findSessionByIdStmt) findSessionByIdStmt = buildFindSessionByIdStmt();
  return (findSessionByIdStmt.get({ id }) as Session | undefined) ?? null;
}

export function insertSession(row: Session): void {
  getDb().insert(sessions).values(row).run();
}

export function updateSessionRow(id: string, patch: Partial<Session>): void {
  getDb().update(sessions).set(patch).where(eq(sessions.id, id)).run();
}

export function deleteSessionRow(id: string): number {
  const result = getDb().delete(sessions).where(eq(sessions.id, id)).run();
  return result.changes;
}

export type SessionSessionRef = {
  sessionId: string;
  claudeSessionId: string;
};

export function findSessionsWithClaudeSessionId(): SessionSessionRef[] {
  const rows = getDb()
    .select({
      sessionId: sessions.id,
      claudeSessionId: sessions.claudeSessionId,
    })
    .from(sessions)
    .where(sql`${sessions.claudeSessionId} IS NOT NULL`)
    .all();
  return rows.map((r) => ({
    sessionId: r.sessionId,
    claudeSessionId: r.claudeSessionId!,
  }));
}
