import { eq, inArray, isNotNull } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { sessions } from "~/db/pg-schema";

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

/** Every query here filters on `owner_id` (ADR 0041 D15). */

export async function findAllSessions(ownerId: number): Promise<SessionRow[]> {
  return panelDb().select().from(sessions).where(ownedBy(sessions, ownerId));
}

/** Sessions whose status claims a live agent process — orphans at Panel boot. */
export async function findActiveLocalSessions(ownerId: number): Promise<SessionRow[]> {
  return panelDb()
    .select()
    .from(sessions)
    .where(ownedBy(sessions, ownerId, inArray(sessions.status, ["running", "needs-input"])));
}

export async function findSessionById(ownerId: number, id: string): Promise<SessionRow | null> {
  const rows = await panelDb()
    .select()
    .from(sessions)
    .where(ownedBy(sessions, ownerId, eq(sessions.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSession(row: NewSessionRow): Promise<void> {
  await panelDb().insert(sessions).values({ ...row, ownerId: row.ownerId });
}

export async function updateSessionRow(
  ownerId: number,
  id: string,
  patch: Partial<SessionRow>,
): Promise<void> {
  await panelDb()
    .update(sessions)
    .set(patch)
    .where(ownedBy(sessions, ownerId, eq(sessions.id, id)));
}

export async function deleteSessionRow(ownerId: number, id: string): Promise<number> {
  const removed = await panelDb()
    .delete(sessions)
    .where(ownedBy(sessions, ownerId, eq(sessions.id, id)))
    .returning({ id: sessions.id });
  return removed.length;
}

export type SessionSessionRef = {
  sessionId: string;
  claudeSessionId: string;
};

export async function findSessionsWithClaudeSessionId(ownerId: number): Promise<SessionSessionRef[]> {
  const rows = await panelDb()
    .select({
      sessionId: sessions.id,
      claudeSessionId: sessions.claudeSessionId,
    })
    .from(sessions)
    .where(ownedBy(sessions, ownerId, isNotNull(sessions.claudeSessionId)));
  return rows.map((r) => ({
    sessionId: r.sessionId,
    claudeSessionId: r.claudeSessionId!,
  }));
}
