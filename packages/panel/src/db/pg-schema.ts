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
 * Core registry and its sealed secrets. PR 5 moves the seven `missioncontrol.db`
 * tables (sessions, terminal_logs, home_terminals, app_settings, token_usage,
 * token_usage_session_offsets, event_log) plus their rollup companion. Time
 * columns are epoch milliseconds as `bigint` read back as a JS number (D18); the
 * sealed blob is `bytea`.
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
 * A signed webhook endpoint (#574): an https URL the Panel POSTs Task events to.
 * The signing secret is sealed at rest (same envelope as Core secrets). `events`
 * is the subset of Task events this hook wants; `all_cores` is true for every
 * Core of the owner, false for only the Cores in `webhook_cores`.
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretSealed: bytea("secret_sealed").notNull(),
    events: text("events").array().notNull(),
    allCores: boolean("all_cores").notNull().default(true),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [index("webhooks_owner_idx").on(t.ownerId)],
);

/** The Cores a restricted webhook reaches. `owner_id` repeats the webhook's owner so the guard's rule holds here too. */
export const webhookCores = pgTable(
  "webhook_cores",
  {
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    coreId: text("core_id")
      .notNull()
      .references(() => cores.id, { onDelete: "cascade" }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.webhookId, t.coreId], name: "webhook_cores_webhook_id_core_id_pk" })],
);

/**
 * One row per Task or comment change (#574), written in the same transaction as
 * the change so a rolled-back change never emits. The delivery worker fans each
 * row out to matching webhooks, then stamps `processed_at`.
 */
export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    /** JSON body the receiver gets (minus transport headers). */
    payload: text("payload").notNull(),
    /** The Task's Core, for webhook Core-scope matching; null when the Task has none. */
    coreId: text("core_id"),
    createdAt: epochMs("created_at").notNull(),
    processedAt: epochMs("processed_at"),
  },
  (t) => [
    check(
      "webhook_outbox_event_type_check",
      sql`${t.eventType} in ('task.created', 'task.updated', 'task.status_changed', 'task.deleted', 'comment.created', 'ping')`,
    ),
    index("webhook_outbox_pending_idx").on(t.ownerId, t.processedAt, t.createdAt),
  ],
);

/**
 * One signed delivery of an outbox event to one webhook. Claimed with a lease
 * so a crash between send and mark cannot silently double-deliver under a new
 * id; the receiver de-duplicates on the delivery id header. Kept 14 days.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    outboxId: text("outbox_id")
      .notNull()
      .references(() => webhookOutbox.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: epochMs("next_attempt_at").notNull(),
    /** Exclusive lease end; a worker that holds the row until this time. */
    claimedUntil: epochMs("claimed_until"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    deliveredAt: epochMs("delivered_at"),
  },
  (t) => [
    check(
      "webhook_deliveries_status_check",
      sql`${t.status} in ('pending', 'delivered', 'failed')`,
    ),
    // One delivery per (outbox, webhook): a crash mid-fan-out must not mint a second id.
    unique("webhook_deliveries_outbox_webhook_unique").on(t.outboxId, t.webhookId),
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt, t.claimedUntil),
    index("webhook_deliveries_created_idx").on(t.createdAt),
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

/**
 * Where the Shared folders live (#564, ADR 0041 D5, D33): one row per owner. `master_key_sealed` is
 * the controller's signing key for the SDK key issuer, sealed with `secrets-at-rest.ts` like
 * `core_secrets.sealed`. It is written by one write-only route and read by the issuer alone: no
 * query that feeds a response or a frame selects it.
 */
export const storageConfig = pgTable("storage_config", {
  ownerId: integer("owner_id")
    .primaryKey()
    .references(() => operator.id, { onDelete: "cascade" }),
  backend: text("backend").notNull(),
  endpoint: text("endpoint").notNull(),
  bucket: text("bucket").notNull(),
  prefix: text("prefix").notNull(),
  region: text("region").notNull(),
  oidcIssuer: text("oidc_issuer").notNull(),
  oidcAudience: text("oidc_audience").notNull(),
  keyId: text("key_id").notNull(),
  /** STS AssumeRole ARN when backend is `sts`; empty otherwise. */
  roleArn: text("role_arn").notNull().default(""),
  /** Cloudflare account id when backend is `r2`; empty otherwise. */
  accountId: text("account_id").notNull().default(""),
  /** Parent R2 S3 access key id when backend is `r2`; empty otherwise. */
  parentAccessKeyId: text("parent_access_key_id").notNull().default(""),
  /** Supabase anon key when backend is `supabase`; empty otherwise. Public, not sealed. */
  anonKey: text("anon_key").notNull().default(""),
  masterKeySealed: bytea("master_key_sealed"),
  /** When the sealed master key was last written (rotate or first set). */
  masterKeyRotatedAt: epochMs("master_key_rotated_at"),
  /** Max upload bytes from the Panel Files tab and the SDK (#565 Storage settings). */
  uploadSizeLimitBytes: bigint("upload_size_limit_bytes", { mode: "number" }).notNull().default(536870912),
  updatedAt: epochMs("updated_at").notNull(),
});

/**
 * Where one Core's Shared folder stands (#564). A row exists from the moment a Core is paired from the
 * Panel; a Core without a row was registered before 0.5.0 and is not asked for storage. `pending` is a
 * Core whose pairing is not finished: its Shared folder is not attached. `s3_prefix` is kept so that
 * deleting the Core can still name, and then empty, exactly its folder.
 */
export const coreSharedFolders = pgTable("core_shared_folders", {
  coreId: text("core_id")
    .primaryKey()
    .references(() => cores.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => operator.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  s3Prefix: text("s3_prefix").notNull(),
  keyExpiresAt: epochMs("key_expires_at"),
  lastError: text("last_error"),
  updatedAt: epochMs("updated_at").notNull(),
});

/**
 * A Panel-side Session row (#567 PR 5): the seven tables that lived in
 * `missioncontrol.db`. Time columns stay epoch ms as `bigint` (D18); SQLite
 * integer-booleans become `boolean`. Every table is owner-scoped (D15, D23).
 * A Session belongs to a Core and nothing narrower (ADR 0041 D1); there is no
 * `project_id`.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    titleManuallySet: boolean("title_manually_set").notNull().default(false),
    icon: text("icon"),
    agent: text("agent").notNull(),
    status: text("status").notNull().default("ready"),
    branch: text("branch").notNull().default("main"),
    preview: text("preview").notNull().default(""),
    lines: integer("lines").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    claudeSessionId: text("claude_session_id"),
    claudeSkipPermissions: boolean("claude_skip_permissions").notNull().default(false),
    claudeBareSession: boolean("claude_bare_session").notNull().default(false),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [
    index("sessions_status_idx").on(t.status),
    index("sessions_archived_idx").on(t.archived),
    index("sessions_pinned_idx").on(t.pinned),
    index("sessions_owner_idx").on(t.ownerId),
  ],
);

/** Terminal output chunks for a Session; `owner_id` repeats the Session's owner so the guard's rule holds here too. */
export const terminalLogs = pgTable(
  "terminal_logs",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    chunk: text("chunk").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("terminal_logs_session_idx").on(t.sessionId)],
);

/** A VM Shell Session the Panel opened on a Core (issue 266). */
export const homeTerminals = pgTable(
  "home_terminals",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cwd: text("cwd"),
    position: integer("position").notNull().default(0),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [index("home_terminals_owner_idx").on(t.ownerId)],
);

/**
 * Operator key/value settings. The primary key is `(owner_id, key)` so one
 * owner's `api_token` is never another's.
 */
export const appSettings = pgTable(
  "app_settings",
  {
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.key], name: "app_settings_owner_id_key_pk" })],
);

/** Raw per-message token usage; `message_uuid` is unique so a re-sync cannot double-count. */
export const tokenUsage = pgTable(
  "token_usage",
  {
    id: text("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    claudeSessionId: text("claude_session_id").notNull(),
    messageUuid: text("message_uuid").notNull().unique(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    ts: epochMs("ts").notNull(),
  },
  (t) => [
    index("token_usage_session_idx").on(t.sessionId),
    index("token_usage_ts_idx").on(t.ts),
    index("token_usage_ts_cover_idx").on(
      t.ts,
      t.inputTokens,
      t.outputTokens,
      t.cacheCreationTokens,
      t.cacheReadTokens,
    ),
    index("token_usage_session_ts_cover_idx").on(
      t.sessionId,
      t.ts,
      t.inputTokens,
      t.outputTokens,
      t.cacheCreationTokens,
      t.cacheReadTokens,
    ),
  ],
);

/**
 * Pre-aggregated token usage per (session, local day). Summary reads sum this
 * instead of scanning `token_usage`. Kept in lockstep by the ingest transaction.
 * `owner_id` repeats the Session's owner so the guard's rule holds here too.
 */
export const tokenUsageRollup = pgTable(
  "token_usage_rollup",
  {
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    lastTs: epochMs("last_ts").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.day], name: "token_usage_rollup_session_id_day_pk" }),
    index("token_usage_rollup_session_idx").on(t.sessionId),
    index("token_usage_rollup_day_idx").on(t.day),
  ],
);

/** Byte offset into a Claude JSONL file for incremental token-usage sync. */
export const tokenUsageSessionOffsets = pgTable(
  "token_usage_session_offsets",
  {
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    claudeSessionId: text("claude_session_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    byteOffset: integer("byte_offset").notNull().default(0),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.ownerId, t.claudeSessionId],
      name: "token_usage_session_offsets_owner_claude_pk",
    }),
  ],
);

/**
 * Monotonic event log the Panel appends session/hook events to. SQLite's
 * `AUTOINCREMENT` becomes `GENERATED ALWAYS AS IDENTITY`. `owner_id` scopes
 * replay to one Operator.
 */
export const eventLog = pgTable(
  "event_log",
  {
    eventId: bigint("event_id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    ts: epochMs("ts").notNull(),
    kind: text("kind").notNull(),
    ptyId: text("pty_id"),
    sessionId: text("session_id"),
    payload: text("payload").notNull(),
  },
  (t) => [
    index("event_log_kind_idx").on(t.kind),
    index("event_log_session_idx").on(t.sessionId),
    index("event_log_pty_idx").on(t.ptyId),
    index("event_log_owner_idx").on(t.ownerId),
  ],
);
