import { asc, eq } from "drizzle-orm";
import { getDb } from "~/db/client";
import { homeTerminals } from "~/db/schema";
import type { HomeTerminal } from "~/db/schema";

export function findHomeTerminals(): HomeTerminal[] {
  return getDb()
    .select()
    .from(homeTerminals)
    .orderBy(asc(homeTerminals.position), asc(homeTerminals.createdAt))
    .all();
}

export function findHomeTerminalById(id: string): HomeTerminal | null {
  return getDb().select().from(homeTerminals).where(eq(homeTerminals.id, id)).get() ?? null;
}

export function insertHomeTerminal(row: HomeTerminal): void {
  getDb().insert(homeTerminals).values(row).run();
}

export function updateHomeTerminalRow(id: string, patch: Partial<HomeTerminal>): void {
  getDb().update(homeTerminals).set(patch).where(eq(homeTerminals.id, id)).run();
}

export function deleteHomeTerminalRow(id: string): number {
  return getDb().delete(homeTerminals).where(eq(homeTerminals.id, id)).run().changes;
}
