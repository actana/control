import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  unique,
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
