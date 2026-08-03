import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getPanelDb } from "../panel-db";
import { OPERATOR_ID } from "./operator";

/**
 * Panel sessions are server-side records, not signed self-contained tokens:
 * that is what makes logout and a password change able to *revoke* rather than
 * merely ask the browser to forget (ADR 0011).
 */
export type PanelSession = {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only bump `last_seen_at`/expiry once an hour — one write per busy session. */
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createPanelSession(now = Date.now()): { token: string; session: PanelSession } {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const session: PanelSession = {
    id: randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  getPanelDb()
    .prepare(
      `INSERT INTO panel_sessions (id, operator_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(session.id, OPERATOR_ID, hashToken(token), now, now, session.expiresAt);
  pruneExpiredSessions(now);
  return { token, session };
}

/**
 * Resolve a cookie value to a live session, sliding its expiry. Returns null
 * for unknown, revoked, and expired tokens alike — the caller can't tell which,
 * and neither can an attacker.
 */
export function resolvePanelSession(token: string | null | undefined, now = Date.now()): PanelSession | null {
  if (!token) return null;
  const db = getPanelDb();
  const row = db
    .prepare("SELECT id, created_at, last_seen_at, expires_at FROM panel_sessions WHERE token_hash = ?")
    .get(hashToken(token)) as
    | { id: string; created_at: number; last_seen_at: number; expires_at: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare("DELETE FROM panel_sessions WHERE id = ?").run(row.id);
    return null;
  }
  let { last_seen_at: lastSeenAt, expires_at: expiresAt } = row;
  if (now - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    lastSeenAt = now;
    expiresAt = now + SESSION_TTL_MS;
    db.prepare("UPDATE panel_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
      lastSeenAt,
      expiresAt,
      row.id,
    );
  }
  return { id: row.id, createdAt: row.created_at, lastSeenAt, expiresAt };
}

export function revokePanelSession(token: string | null | undefined): void {
  if (!token) return;
  getPanelDb().prepare("DELETE FROM panel_sessions WHERE token_hash = ?").run(hashToken(token));
}

/** Log every browser out — a password change, or an explicit "sign out everywhere". */
export function revokeAllPanelSessions(): void {
  getPanelDb().prepare("DELETE FROM panel_sessions").run();
}

export function pruneExpiredSessions(now = Date.now()): void {
  getPanelDb().prepare("DELETE FROM panel_sessions WHERE expires_at <= ?").run(now);
}
