import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import {
  DEFAULT_BRANCH,
  DEFAULT_TASK_STATUS,
  HARNESSES,
  TASK_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  type Harness,
  type TaskStatus,
} from "@actana/shared/domain";

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  // Manual display order (0-based). Null on legacy rows created before
  // reordering existed; those sort last by createdAt until the user reorders,
  // which assigns every group a concrete index. See groups.repo findAllGroups.
  sortOrder: integer("sort_order"),
  createdAt: integer("created_at").notNull(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    icon: text("icon").notNull(),
    iconColor: text("icon_color").notNull(),
    imagePath: text("image_path"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    pinnedOrder: integer("pinned_order"),
    launchUrl: text("launch_url"),
    rememberHarnessSettings: integer("remember_agent_settings", { mode: "boolean" })
      .notNull()
      .default(false),
    savedHarness: text("saved_agent").$type<Harness>(),
    savedSkipPermissions: integer("saved_skip_permissions", { mode: "boolean" })
      .notNull()
      .default(false),
    savedBareSession: integer("saved_bare_session", { mode: "boolean" })
      .notNull()
      .default(false),
    // Which layout this project opens in: true = grid (all sessions tiled),
    // false = list (sessions stacked in a column). Chosen at create time; the
    // in-session toggle still lets the user switch on the fly.
    defaultGridView: integer("default_grid_view", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    groupIdx: index("projects_group_idx").on(t.groupId),
    pinnedIdx: index("projects_pinned_idx").on(t.pinned),
  })
);

/**
 * Panel-local presentation for a project the Panel does not own (issue 98).
 *
 * A Core-owned Project's row lives on its Core, and the core-link carries only
 * Core facts (name, path, icon, pin, remembered settings). Group membership,
 * the card image and the launch URL are the Panel operator's own filing — they
 * mean nothing on the Core and have no frame to travel in — so they are kept
 * here, keyed to the Core's project id, and joined onto the Core's snapshot on
 * read. Without this table those three fields PATCHed a `projects` row that
 * does not exist and 404'd.
 *
 * Keyed by `projectId` alone: ids are minted `p-<base36 ms>-<6 hex>`
 * (shared/client-id), so two Cores colliding is not a case worth a composite
 * key. `coreId` rides along anyway — it is what an orphan sweep needs to ask
 * the right Core whether the project is still there.
 *
 * No foreign key to `projects`: the whole point is a row with no project row.
 */
export const projectPresentation = sqliteTable(
  "project_presentation",
  {
    projectId: text("project_id").primaryKey(),
    coreId: text("core_id").notNull(),
    imagePath: text("image_path"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    launchUrl: text("launch_url"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    coreIdx: index("project_presentation_core_idx").on(t.coreId),
    groupIdx: index("project_presentation_group_idx").on(t.groupId),
  })
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    titleManuallySet: integer("title_manually_set", { mode: "boolean" }).notNull().default(false),
    icon: text("icon"),
    agent: text("agent").$type<Harness>().notNull(),
    status: text("status").$type<TaskStatus>().notNull().default(DEFAULT_TASK_STATUS),
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
    projectIdx: index("tasks_project_idx").on(t.projectId),
    statusIdx: index("tasks_status_idx").on(t.status),
    archivedIdx: index("tasks_archived_idx").on(t.archived),
    pinnedIdx: index("tasks_pinned_idx").on(t.pinned),
  })
);

export const terminalLogs = sqliteTable(
  "terminal_logs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    chunk: text("chunk").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("terminal_logs_task_idx").on(t.taskId),
  })
);

// The Panel's only terminal table (issue 266). It was introduced as the
// project-less "home" half beside `user_terminals`, deliberately separate so
// the FK-heavy project table never needed a destructive rebuild — and it is
// what is left now that the project-root terminal path is gone: every terminal
// the Panel opens is a VM Shell Session on a Core and persists here. Rows are
// surfaced to the renderer shaped as UserTerminal (with a sentinel projectId)
// so the existing terminal store/panel/pane can render them.
//
// `user_terminals` itself is **dropped**, not orphaned: `ensureSchema` no
// longer creates it and `dropLegacyUserTerminals` removes it from a DB that
// already has one (packages/shared/src/schema-bootstrap.ts). A terminal is
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
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
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
    taskIdx: index("token_usage_task_idx").on(t.taskId),
    projectIdx: index("token_usage_project_idx").on(t.projectId),
    tsIdx: index("token_usage_ts_idx").on(t.ts),
  })
);

export const tokenUsageSessionOffsets = sqliteTable(
  "token_usage_session_offsets",
  {
    claudeSessionId: text("claude_session_id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    byteOffset: integer("byte_offset").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  }
);


// Monotonic per-Core event log. Every domain event — task status change,
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
    taskId: text("task_id"),
    payload: text("payload").notNull(),
  },
  (t) => ({
    // The replay path reads events strictly after a cursor; a covering index on
    // (event_id) is the clustered PK, but a kind-scoped index keeps per-category
    // queries (e.g. all task events) cheap.
    kindIdx: index("event_log_kind_idx").on(t.kind),
    taskIdx: index("event_log_task_idx").on(t.taskId),
    ptyIdx: index("event_log_pty_idx").on(t.ptyId),
  }),
);

export const groupsRelations = relations(groups, ({ many }) => ({
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  group: one(groups, { fields: [projects.groupId], references: [groups.id] }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  logs: many(terminalLogs),
}));


export const terminalLogsRelations = relations(terminalLogs, ({ one }) => ({
  task: one(tasks, { fields: [terminalLogs.taskId], references: [tasks.id] }),
}));

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectPresentation = typeof projectPresentation.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
/**
 * A terminal as the renderer sees one.
 *
 * A `home_terminals` row plus the sentinel `projectId` the store, panel and
 * pane already key on ({@link HOME_TERMINAL_PROJECT_ID}). It used to be
 * `user_terminals.$inferSelect` widened with a runtime-only `startCommand`
 * hint for launch/ephemeral shells; both the table and that hint went with the
 * project-root path (issue 266), so this is now stated directly rather than
 * inferred from a table that no longer exists.
 */
export type UserTerminal = HomeTerminal & { projectId: string };
export type HomeTerminal = typeof homeTerminals.$inferSelect;
export type NewHomeTerminal = typeof homeTerminals.$inferInsert;
export type EventLogRow = typeof eventLog.$inferSelect;
export type NewEventLogRow = typeof eventLog.$inferInsert;
export {
  DEFAULT_BRANCH,
  DEFAULT_TASK_STATUS,
  HARNESSES,
  TASK_STATUSES,
  isActiveStatus,
  isTerminalStatus,
};
export type { Harness, TaskStatus };
