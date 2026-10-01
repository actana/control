import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The Panel's Postgres schema (#567, ADR 0041 D14). Each pull request of #567
 * adds the tables it moves here and generates its migration with `db:generate`.
 *
 * PR 4 moves what the SQLite `panel.db` held: the Operator, the Panel's sessions, the
 * Core registry and its sealed secrets. Time columns are epoch milliseconds as
 * `bigint` read back as a JS number (D18); the sealed blob is `bytea`.
 *
 * Only `repositories/` may import this file (`__tests__/owner-guard.test.ts`
 * fails otherwise), so every query on an owner-scoped table is one the guard
 * scans.
 */

const epochMs = (name: string) => bigint(name, { mode: "number" });

/** The AES-GCM blob `secrets-at-rest.ts` seals. node-postgres reads it as a Buffer, PGlite as a Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * The one Operator (ADR 0011). Single-row on purpose, and the only table on the
 * ownership guard's allowlist: every `owner_id` points at it (D15, D23).
 */
export const operator = pgTable(
  "operator",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: epochMs("created_at").notNull(),
    passwordChangedAt: epochMs("password_changed_at").notNull(),
  },
  (t) => [check("operator_single_row", sql`${t.id} = 1`)],
);

/** Server-side sessions: only the token's hash is stored, so a dump holds no usable cookie. */
export const panelSessions = pgTable(
  "panel_sessions",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: epochMs("created_at").notNull(),
    lastSeenAt: epochMs("last_seen_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
  },
  (t) => [index("panel_sessions_expires_at_idx").on(t.expiresAt)],
);

/** The Core registry, with the Panel-owned replay cursor beside each row. */
export const cores = pgTable(
  "cores",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    label: text("label").notNull(),
    lastEventId: epochMs("last_event_id").notNull().default(0),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  // One registration per endpoint for an owner: pairing the same Core twice is
  // a mistake to report. Per owner, so one owner's endpoint is not another's.
  (t) => [unique("cores_owner_endpoint_unique").on(t.ownerId, t.endpoint)],
);

/** A registration's sealed secret half. `owner_id` repeats the Core's owner so the guard's rule holds here too. */
export const coreSecrets = pgTable("core_secrets", {
  coreId: text("core_id")
    .primaryKey()
    .references(() => cores.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => operator.id, { onDelete: "cascade" }),
  sealed: bytea("sealed").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

/**
 * A Task (#568): work for an agent on a Core. `status` is one of six values and
 * moves only along the edges in `shared/tasks.ts`, which the Task service
 * enforces. `agent` is a plain reference with no foreign key, because the
 * Agents tables (#569) are built in parallel. `core_id` is a Core of the same
 * owner; deleting the Core leaves the Task and clears the link.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("draft"),
    coreId: text("core_id").references(() => cores.id, { onDelete: "set null" }),
    agent: text("agent"),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchedAt: epochMs("dispatched_at"),
    lastError: text("last_error"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [
    check(
      "tasks_status_check",
      sql`${t.status} in ('draft', 'assigned', 'in_progress', 'done', 'failed', 'partial')`,
    ),
    index("tasks_owner_status_idx").on(t.ownerId, t.status),
  ],
);

/**
 * A comment on a Task, by a user, an agent or the system. An agent comment
 * names the file it came from, unique per Task; the others have none.
 * `owner_id` repeats the Task's owner so the guard's rule holds here too.
 */
export const taskComments = pgTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    /** Insert order, which the clock cannot give: two comments can share a millisecond. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    authorKind: text("author_kind").notNull(),
    authorName: text("author_name").notNull(),
    sourceFile: text("source_file"),
    body: text("body").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    check("task_comments_author_kind_check", sql`${t.authorKind} in ('user', 'agent', 'system')`),
    check(
      "task_comments_source_file_check",
      sql`${t.sourceFile} is null or ${t.authorKind} = 'agent'`,
    ),
    unique("task_comments_task_source_file_unique").on(t.taskId, t.sourceFile),
    index("task_comments_task_idx").on(t.taskId, t.seq),
  ],
);

/** Every status a Task has had, oldest first. `from_status` is null for the row that creates the Task. */
export const taskStatusHistory = pgTable(
  "task_status_history",
  {
    id: text("id").primaryKey(),
    /** Insert order, which the clock cannot give: two moves can share a millisecond. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    changedAt: epochMs("changed_at").notNull(),
  },
  (t) => [index("task_status_history_task_idx").on(t.taskId, t.seq)],
);

/**
 * An Agent (#569): a named harness plus its settings on one Core. The settings
 * are a model name and `flags`, ids from a closed set per harness that the
 * service checks (`shared/agents.ts`). There is no command, args, script or
 * environment column on purpose: a user-typed command would be a way into the
 * Core, and a platform key must never ride into an Agent. `tasks.agent` is a
 * plain reference to `id`, with no foreign key (#568). Deleting a Core deletes
 * its Agents.
 */
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    coreId: text("core_id")
      .notNull()
      .references(() => cores.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    harness: text("harness").notNull(),
    model: text("model"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [
    check("agents_harness_check", sql`${t.harness} in ('claude-code', 'codex', 'cursor-cli', 'opencode', 'pi')`),
    unique("agents_core_name_unique").on(t.coreId, t.name),
    uniqueIndex("agents_default_per_harness").on(t.coreId, t.harness).where(sql`${t.isDefault}`),
    index("agents_owner_core_idx").on(t.ownerId, t.coreId),
  ],
);

/**
 * An API key (#572): a credential a user creates for the public REST API. Only
 * the sha256 of the key and a short display `prefix` are stored; the plaintext
 * is shown once at creation and kept nowhere. `all_cores` is true for the
 * default, a key that reaches every Core of its owner; false means it reaches
 * only the Cores in `api_key_cores`, so a restricted key whose Cores were all
 * forgotten reaches none. `revoked_at` is set once and never cleared: a
 * trigger in the migration refuses to change or clear it.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    allCores: boolean("all_cores").notNull().default(true),
    createdAt: epochMs("created_at").notNull(),
    revokedAt: epochMs("revoked_at"),
  },
  (t) => [index("api_keys_owner_prefix_idx").on(t.ownerId, t.prefix)],
);

/** The Cores a restricted key reaches. `owner_id` repeats the key's owner so the guard's rule holds here too. */
export const apiKeyCores = pgTable(
  "api_key_cores",
  {
    keyId: text("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    coreId: text("core_id")
      .notNull()
      .references(() => cores.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.coreId] })],
);
