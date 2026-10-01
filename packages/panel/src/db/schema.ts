import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import {
  DEFAULT_BRANCH,
  DEFAULT_SESSION_STATUS,
  HARNESSES,
  SESSION_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  type Harness,
  type SessionStatus,
} from "@actana/shared/domain";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    titleManuallySet: integer("title_manually_set", { mode: "boolean" }).notNull().default(false),
    icon: text("icon"),
    agent: text("agent").$type<Harness>().notNull(),
    status: text("status").$type<SessionStatus>().notNull().default(DEFAULT_SESSION_STATUS),
    branch: text("branch").notNull().default(DEFAULT_BRANCH),
    preview: text("preview").notNull().default(""),
    lines: integer("lines").notNull().default(0),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    claudeSessionId: text("claude_session_id"),
    claudeSkipPermissions: integer("claude_skip_permissions", { mode: "boolean" }).notNull().default(false),
    claudeBareSession: integer("claude_bare_session", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    statusIdx: index("sessions_status_idx").on(t.status),
    archivedIdx: index("sessions_archived_idx").on(t.archived),
    pinnedIdx: index("sessions_pinned_idx").on(t.pinned),
  })
);

export const terminalLogs = sqliteTable(
  "terminal_logs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    chunk: text("chunk").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    sessionIdx: index("terminal_logs_session_idx").on(t.sessionId),
  })
);

// The Panel's only terminal table (issue 266): every terminal the Panel opens
// is a VM Shell Session on a Core and persists here.
//
// `user_terminals` itself is **dropped**, not orphaned: `ensureSchema` no
// longer creates it and `dropLegacyUserTerminals` removes it from a DB that
// already has one (packages/panel/src/db/schema-bootstrap.ts). A terminal is
// ephemeral, so there was nothing in those rows to migrate.
export const homeTerminals = sqliteTable(
  "home_terminals",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    cwd: text("cwd"),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const tokenUsage = sqliteTable(
  "token_usage",
  {
    id: text("id").primaryKey(),
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
    ts: integer("ts").notNull(),
  },
  (t) => ({
    sessionIdx: index("token_usage_session_idx").on(t.sessionId),
    tsIdx: index("token_usage_ts_idx").on(t.ts),
  })
);

export const tokenUsageSessionOffsets = sqliteTable(
  "token_usage_session_offsets",
  {
    claudeSessionId: text("claude_session_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    byteOffset: integer("byte_offset").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  }
);


// Monotonic per-Core event log. Every domain event — session status change,
// hook fire, question menu, run finish, PTY spawn/exit — is appended here with
// a sequential `eventId`. On Panel reconnect the server streams the tail past
// the Panel's `lastEventId`; live push resumes once caught up. PTY byte-stream
// replay stays in the in-memory ring buffer (one category of replay); this
// table holds the structured lifecycle/timeline events. See issue 02 and
// CONTEXT.md "Event" / "Event cursor".
export const eventLog = sqliteTable(
  "event_log",
  {
    eventId: integer("event_id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    kind: text("kind").notNull(),
    ptyId: text("pty_id"),
    sessionId: text("session_id"),
    payload: text("payload").notNull(),
  },
  (t) => ({
    // The replay path reads events strictly after a cursor; a covering index on
    // (event_id) is the clustered PK, but a kind-scoped index keeps per-category
    // queries (e.g. all session events) cheap.
    kindIdx: index("event_log_kind_idx").on(t.kind),
    sessionIdx: index("event_log_session_idx").on(t.sessionId),
    ptyIdx: index("event_log_pty_idx").on(t.ptyId),
  }),
);

export const sessionsRelations = relations(sessions, ({ many }) => ({
  logs: many(terminalLogs),
}));


export const terminalLogsRelations = relations(terminalLogs, ({ one }) => ({
  session: one(sessions, { fields: [terminalLogs.sessionId], references: [sessions.id] }),
}));

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
/** A terminal as the renderer sees one: a `home_terminals` row. */
export type UserTerminal = HomeTerminal;
export type HomeTerminal = typeof homeTerminals.$inferSelect;
export type NewHomeTerminal = typeof homeTerminals.$inferInsert;
export type EventLogRow = typeof eventLog.$inferSelect;
export type NewEventLogRow = typeof eventLog.$inferInsert;
export {
  DEFAULT_BRANCH,
  DEFAULT_SESSION_STATUS,
  HARNESSES,
  SESSION_STATUSES,
  isActiveStatus,
  isTerminalStatus,
};
export type { Harness, SessionStatus };
