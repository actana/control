import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// Escape LIKE wildcards so a user typing `%`, `_`, or `\` searches
// literally. Paired with `likeEscaped`, which emits the matching `ESCAPE '\'`.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `column LIKE pattern ESCAPE '\'` — pair the pattern with `escapeLike`. */
export function likeEscaped(column: AnyPgColumn, pattern: string): SQL {
  // `'\\'` in this template literal is a single literal backslash in the SQL.
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
