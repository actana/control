import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "~/db/client";
import { userTerminals } from "~/db/schema";
import type { UserTerminal } from "~/db/schema";

export function findVisibleUserTerminalsByProject(projectId: string): UserTerminal[] {
  return getDb()
    .select()
    .from(userTerminals)
    .where(eq(userTerminals.projectId, projectId))
    .orderBy(asc(userTerminals.position), asc(userTerminals.createdAt))
    .all();
}

export function findUserTerminalById(id: string): UserTerminal | null {
  return getDb().select().from(userTerminals).where(eq(userTerminals.id, id)).get() ?? null;
}

export function insertUserTerminal(row: UserTerminal): void {
  getDb().insert(userTerminals).values(row).run();
}

export function updateUserTerminalRow(id: string, patch: Partial<UserTerminal>): void {
  getDb().update(userTerminals).set(patch).where(eq(userTerminals.id, id)).run();
}

export function deleteUserTerminalRow(id: string): number {
  const result = getDb().delete(userTerminals).where(eq(userTerminals.id, id)).run();
  return result.changes;
}
