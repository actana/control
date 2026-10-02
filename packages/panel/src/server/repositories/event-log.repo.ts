import { desc } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { eventLog } from "~/db/pg-schema";

export type EventLogRow = typeof eventLog.$inferSelect;

/**
 * Append one event to the Panel's monotonic event log (#567 PR 5).
 * Every insert carries `owner_id` (ADR 0041 D15). Returns the new `event_id`.
 */
export async function appendEventLogRow(
  ownerId: number,
  kind: string,
  payload: string,
  opts: { ptyId?: string | null; sessionId?: string | null; ts?: number } = {},
): Promise<number> {
  const rows = await panelDb()
    .insert(eventLog)
    .values({
      ownerId,
      ts: opts.ts ?? Date.now(),
      kind,
      ptyId: opts.ptyId ?? null,
      sessionId: opts.sessionId ?? null,
      payload,
    })
    .returning({ eventId: eventLog.eventId });
  return rows[0]!.eventId;
}

/** Highest event id for this owner, or 0 when the log is empty. */
export async function getLastEventLogId(ownerId: number): Promise<number> {
  const top = await panelDb()
    .select({ eventId: eventLog.eventId })
    .from(eventLog)
    .where(ownedBy(eventLog, ownerId))
    .orderBy(desc(eventLog.eventId))
    .limit(1);
  return top[0]?.eventId ?? 0;
}
