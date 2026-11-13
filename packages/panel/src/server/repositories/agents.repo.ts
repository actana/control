import { and, asc, eq, ne } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { agents, cores } from "~/db/pg-schema";

export type AgentRow = typeof agents.$inferSelect;

/**
 * Every query here filters on `owner_id` (ADR 0041 D15): one owner's Agents are
 * never another's. An Agent is only written after its Core was found under the
 * same owner, in the same transaction.
 */

export async function findAgents(ownerId: number, coreId?: string): Promise<AgentRow[]> {
  return panelDb()
    .select()
    .from(agents)
    .where(ownedBy(agents, ownerId, coreId ? eq(agents.coreId, coreId) : undefined))
    .orderBy(asc(agents.createdAt), asc(agents.id));
}

export async function findAgentById(ownerId: number, id: string): Promise<AgentRow | null> {
  const rows = await panelDb()
    .select()
    .from(agents)
    .where(ownedBy(agents, ownerId, eq(agents.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findDefaultAgent(ownerId: number, coreId: string, harness: string): Promise<AgentRow | null> {
  const rows = await panelDb()
    .select()
    .from(agents)
    .where(ownedBy(agents, ownerId, and(eq(agents.coreId, coreId), eq(agents.harness, harness), eq(agents.isDefault, true))))
    .limit(1);
  return rows[0] ?? null;
}

export type InsertAgentResult =
  /** The owner has no such Core. Nothing was written. */
  | { kind: "no-core" }
  /** The Core already has an Agent with this name, or a default for this harness. Nothing was written. */
  | { kind: "conflict" }
  | { kind: "ok"; agent: AgentRow };

export async function insertAgent(row: AgentRow): Promise<InsertAgentResult> {
  return panelDb().transaction(async (tx): Promise<InsertAgentResult> => {
    const core = await tx
      .select({ id: cores.id })
      .from(cores)
      .where(ownedBy(cores, row.ownerId, eq(cores.id, row.coreId)))
      .for("share");
    if (!core[0]) return { kind: "no-core" };
    const inserted = await tx.insert(agents).values({ ...row, ownerId: row.ownerId }).onConflictDoNothing().returning();
    return inserted[0] ? { kind: "ok", agent: inserted[0] } : { kind: "conflict" };
  });
}

export async function deleteAgent(ownerId: number, id: string): Promise<boolean> {
  const deleted = await panelDb()
    .delete(agents)
    .where(ownedBy(agents, ownerId, eq(agents.id, id)))
    .returning({ id: agents.id });
  return deleted.length > 0;
}

export type UpdateAgentResult =
  /** No such Agent for this owner (the service has already refused a default Agent). Nothing was written. */
  | { kind: "not-found" }
  /** Another Agent on the Core already has this name. Nothing was written. */
  | { kind: "conflict" }
  | { kind: "ok"; agent: AgentRow };

/** Change the name, model and flags of one non-default Agent. The id, owner, Core and harness are never written. */
export async function updateAgentRow(
  ownerId: number,
  id: string,
  fields: Pick<AgentRow, "name" | "model" | "flags">,
  now: number,
): Promise<UpdateAgentResult> {
  try {
    return await updateInTransaction(ownerId, id, fields, now);
  } catch (err) {
    // A concurrent rename or create won the name between the check and the write.
    if (isUniqueViolation(err)) return { kind: "conflict" };
    throw err;
  }
}

/** Postgres' unique violation (23505), straight from the driver or wrapped by drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function updateInTransaction(
  ownerId: number,
  id: string,
  fields: Pick<AgentRow, "name" | "model" | "flags">,
  now: number,
): Promise<UpdateAgentResult> {
  return panelDb().transaction(async (tx): Promise<UpdateAgentResult> => {
    const current = await tx
      .select()
      .from(agents)
      .where(ownedBy(agents, ownerId, and(eq(agents.id, id), eq(agents.isDefault, false))))
      .for("update");
    if (!current[0]) return { kind: "not-found" };
    const taken = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(ownedBy(agents, ownerId, and(eq(agents.coreId, current[0].coreId), eq(agents.name, fields.name), ne(agents.id, id))));
    if (taken[0]) return { kind: "conflict" };
    const updated = await tx
      .update(agents)
      .set({ name: fields.name, model: fields.model, flags: fields.flags, updatedAt: now })
      .where(ownedBy(agents, ownerId, eq(agents.id, id)))
      .returning();
    return { kind: "ok", agent: updated[0]! };
  });
}
