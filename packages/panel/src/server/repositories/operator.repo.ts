import { eq } from "drizzle-orm";
import { panelDb } from "~/db/panel-db-handle";
import { operator } from "~/db/pg-schema";

export type OperatorRow = typeof operator.$inferSelect;

/**
 * The one Operator row (ADR 0011). `operator` is the single table on the
 * ownership guard's allowlist: it is what every `owner_id` points at, so it has
 * no owner of its own to filter on.
 */
export async function findOperator(id: number): Promise<OperatorRow | null> {
  const rows = await panelDb().select().from(operator).where(eq(operator.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Insert the Operator unless one exists. True when this call created it. */
export async function insertOperatorIfAbsent(row: OperatorRow): Promise<boolean> {
  const inserted = await panelDb()
    .insert(operator)
    .values(row)
    .onConflictDoNothing({ target: operator.id })
    .returning({ id: operator.id });
  return inserted.length > 0;
}

export async function updateOperatorPassword(id: number, passwordHash: string, now: number): Promise<void> {
  await panelDb()
    .update(operator)
    .set({ passwordHash, passwordChangedAt: now })
    .where(eq(operator.id, id));
}
