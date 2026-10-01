import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

/**
 * The checks behind `owner-guard.test.ts` (#567, ADR 0041 D15). They are plain
 * functions so the test can run them on the Panel's real schema and on planted
 * ones: a guard that has never failed has not been shown to guard anything.
 */

/** Tables that hold no owner's data, keyed `schema.table`, each with its reason. */
export const OWNERLESS_TABLES: Record<string, string> = {
  "public.operator": "the one Operator row every owner_id points at (ADR 0011, ADR 0041 D15)",
  "drizzle.__drizzle_migrations": "the migrator's own bookkeeping (pg-migrate.ts); it holds no user data",
};

/** Where the Panel's repositories live (`sessions.repo.ts` and the rest); #567 ports them in place. */
export const REPOSITORY_DIR = path.resolve(import.meta.dirname, "..", "..", "server", "repositories");
/** The Panel's source root: nothing outside the repository folder may import the pg schema. */
export const SOURCE_DIR = path.resolve(import.meta.dirname, "..", "..");

const OWNER_COLUMN = "owner_id";

/** What an owner-scoped table must look like, as a sentence per fault. */
export function checkSchemaTables(schema: Record<string, unknown>, allow = OWNERLESS_TABLES): string[] {
  const faults: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const key = `${config.schema ?? "public"}.${config.name}`;
    if (key in allow) continue;
    const owner = config.columns.find((c) => c.name === OWNER_COLUMN);
    if (!owner) {
      faults.push(`${key} has no ${OWNER_COLUMN} column`);
      continue;
    }
    if (!owner.notNull) faults.push(`${key}.${OWNER_COLUMN} is nullable`);
    const references = config.foreignKeys.some((fk) => {
      const ref = fk.reference();
      return (
        ref.columns.length === 1 &&
        ref.columns[0] === owner &&
        getTableConfig(ref.foreignTable).name === "operator" &&
        (getTableConfig(ref.foreignTable).schema ?? "public") === "public" &&
        ref.foreignColumns[0]?.name === "id"
      );
    });
    if (!references) faults.push(`${key}.${OWNER_COLUMN} does not reference operator.id`);
  }
  return faults;
}

/** The export names of the schema's owner-scoped tables, which repositories import. */
export function ownerScopedTables(schema: Record<string, unknown>, allow = OWNERLESS_TABLES) {
  const tables: { exportName: string; sqlName: string }[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (`${config.schema ?? "public"}.${config.name}` in allow) continue;
    tables.push({ exportName, sqlName: config.name });
  }
  return tables;
}

interface Queryable {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The same rule on the migrated database itself, which a hand-written migration can break. */
export async function checkDatabaseTables(db: Queryable, allow = OWNERLESS_TABLES): Promise<string[]> {
  const { rows } = await db.query(`
    SELECT n.nspname AS schema, c.relname AS name,
      o.attnum IS NOT NULL AS has_owner,
      COALESCE(o.attnotnull, false) AS owner_not_null,
      EXISTS (
        SELECT 1 FROM pg_constraint k
          JOIN pg_class r ON r.oid = k.confrelid
          JOIN pg_namespace rn ON rn.oid = r.relnamespace
          JOIN pg_attribute ra ON ra.attrelid = r.oid AND ra.attname = 'id'
        WHERE k.conrelid = c.oid AND k.contype = 'f' AND rn.nspname = 'public' AND r.relname = 'operator'
          AND k.conkey = ARRAY[o.attnum] AND k.confkey = ARRAY[ra.attnum]
      ) AS owner_references_operator
    FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute o ON o.attrelid = c.oid AND o.attname = '${OWNER_COLUMN}' AND NOT o.attisdropped
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2`);
  const faults: string[] = [];
  for (const row of rows) {
    const key = `${row.schema}.${row.name}`;
    if (key in allow) continue;
    if (!row.has_owner) faults.push(`${key} has no ${OWNER_COLUMN} column`);
    else {
      if (!row.owner_not_null) faults.push(`${key}.${OWNER_COLUMN} is nullable`);
      if (!row.owner_references_operator) faults.push(`${key}.${OWNER_COLUMN} does not reference operator.id`);
    }
  }
  return faults;
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/**
 * Queries in one repository file that name an owner-scoped table without the
 * owner. A drizzle query (`.from`, `.update`, `.delete`, a join) needs one
 * `ownedBy(` per table it names, an `.insert` needs `ownerId`, and a literal of
 * raw SQL that names the table needs `owner_id`. A text scan, so it reads
 * conventions, not types: it is the floor, and review is the rest.
 */
export function findUnscopedQueries(
  source: string,
  tables: { exportName: string; sqlName: string }[],
  file = "<source>",
): string[] {
  const text = stripComments(source);
  const byExport = new Map(tables.map((t) => [t.exportName, t]));
  const faults: string[] = [];

  // Builder calls, grouped by the statement (up to the next `;`) they sit in.
  const call = /\.(from|update|delete|insert|innerJoin|leftJoin|rightJoin|fullJoin|\$count)\(\s*(?:\w+\.)*(\w+)\s*[,)]/g;
  const statements = new Map<number, { text: string; refs: { verb: string; table: string; at: number }[] }>();
  for (const m of text.matchAll(call)) {
    const table = byExport.get(m[2]);
    if (!table) continue;
    const end = text.indexOf(";", m.index);
    const stop = end === -1 ? text.length : end;
    const entry = statements.get(stop) ?? { text: "", refs: [] };
    entry.refs.push({ verb: m[1], table: table.exportName, at: m.index });
    statements.set(stop, entry);
  }
  for (const [stop, entry] of statements) {
    const from = Math.min(...entry.refs.map((r) => r.at));
    const body = text.slice(from, stop);
    const scoped = (body.match(/\bownedBy\(/g) ?? []).length;
    const reads = entry.refs.filter((r) => r.verb !== "insert");
    if (scoped < reads.length) {
      faults.push(`${file}:${lineOf(text, from)} queries ${reads.map((r) => r.table).join(", ")} without ownedBy()`);
    }
    for (const r of entry.refs.filter((x) => x.verb === "insert")) {
      if (!/\bownerId\b/.test(body)) faults.push(`${file}:${lineOf(text, r.at)} inserts into ${r.table} without ownerId`);
    }
  }

  // The relational API: `db.query.sessions.findMany({ where })` needs `ownedBy(` in its call.
  for (const m of text.matchAll(/\.query\.(\w+)\.(?:findMany|findFirst)\(/g)) {
    const table = byExport.get(m[1]);
    if (!table) continue;
    const end = text.indexOf(";", m.index);
    const body = text.slice(m.index, end === -1 ? text.length : end);
    if (!/\bownedBy\(/.test(body)) faults.push(`${file}:${lineOf(text, m.index)} queries ${table.exportName} without ownedBy()`);
  }

  // A `sql` template that interpolates an owner-scoped table needs the owner in it.
  for (const m of text.matchAll(/\bsql`((?:\\.|[^`\\])*)`/g)) {
    for (const t of tables) {
      const over = new RegExp(`\\$\\{\\s*(?:\\w+\\.)*${t.exportName}\\s*\\}`);
      if (over.test(m[1]) && !/\bowner_id\b|\bownerId\b|\bownedBy\(/.test(m[1])) {
        faults.push(`${file}:${lineOf(text, m.index)} sql template over ${t.exportName} without the owner`);
      }
    }
  }

  // Raw SQL in a string or template literal.
  for (const m of text.matchAll(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g)) {
    for (const t of tables) {
      const names = new RegExp(`\\b(?:from|join|update|into)\\s+(?:"?\\w+"?\\.)?"?${t.sqlName}"?\\b`, "i");
      if (names.test(m[0]) && !/\bowner_id\b/i.test(m[0])) {
        faults.push(`${file}:${lineOf(text, m.index)} raw SQL on ${t.sqlName} without owner_id`);
      }
    }
  }
  return faults;
}

export function repositoryFiles(dir = REPOSITORY_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : repositoryFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

export function scanRepositories(
  tables: { exportName: string; sqlName: string }[],
  dir = REPOSITORY_DIR,
): string[] {
  // A scan that read nothing proves nothing: with owner-scoped tables and no file, fail.
  if (tables.length > 0 && repositoryFiles(dir).length === 0) {
    return [`no repository file found under ${path.relative(SOURCE_DIR, dir) || dir}, but ${tables.length} owner-scoped table(s) exist`];
  }
  return repositoryFiles(dir).flatMap((file) =>
    findUnscopedQueries(readFileSync(file, "utf8"), tables, path.relative(dir, file)),
  );
}

/** Non-test source files outside the repository folder that import the pg schema: a query written there skips the scan. */
export function pgSchemaImportsOutsideRepositories(
  root = SOURCE_DIR,
  repositories = REPOSITORY_DIR,
  schemaFile = path.join(SOURCE_DIR, "db", "pg-schema.ts"),
): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : walk(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  return walk(root)
    .filter((file) => file !== schemaFile && !file.startsWith(repositories + path.sep))
    .filter((file) => /\b(?:from|import)\s*\(?\s*["'][^"']*pg-schema["']/.test(stripComments(readFileSync(file, "utf8"))))
    .map((file) => `${path.relative(root, file)} imports pg-schema outside the repository folder`);
}
