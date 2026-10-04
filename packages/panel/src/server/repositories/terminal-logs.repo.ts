import { asc, eq } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { terminalLogs } from "~/db/pg-schema";

export type TerminalLogRow = typeof terminalLogs.$inferSelect;
export type NewTerminalLogRow = typeof terminalLogs.$inferInsert;

/** Every query here filters on `owner_id` (ADR 0041 D15). */

export async function insertTerminalLog(row: NewTerminalLogRow): Promise<void> {
  await panelDb().insert(terminalLogs).values({ ...row, ownerId: row.ownerId });
}

export async function findTerminalLogsBySessionId(
  ownerId: number,
  sessionId: string,
): Promise<TerminalLogRow[]> {
  return panelDb()
    .select()
    .from(terminalLogs)
    .where(ownedBy(terminalLogs, ownerId, eq(terminalLogs.sessionId, sessionId)))
    .orderBy(asc(terminalLogs.createdAt));
}

export async function deleteTerminalLogById(ownerId: number, id: string): Promise<void> {
  await panelDb()
    .delete(terminalLogs)
    .where(ownedBy(terminalLogs, ownerId, eq(terminalLogs.id, id)));
}
