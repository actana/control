import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * The owner predicate of every query on an owner-scoped table (#567, ADR 0041
 * D15): `owner_id` references `operator.id`, and Panel code, not the UI and not
 * row-level security, is what keeps one owner's rows from another's.
 *
 * A repository's `select`, `update` and `delete` on such a table passes this to
 * `.where(...)`, with any further conditions after the table. A repository
 * that names an owner-scoped table without calling it fails
 * `__tests__/owner-guard.test.ts`, which scans `db/repositories/`. An insert
 * sets `ownerId` in `.values(...)` instead.
 */
export function ownedBy(
  table: { ownerId: AnyPgColumn },
  ownerId: number,
  ...also: (SQL | undefined)[]
): SQL {
  return and(eq(table.ownerId, ownerId), ...also) as SQL;
}
