import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  deleteAllPanelSessions,
  deleteExpiredPanelSessions,
  deletePanelSessionById,
  deletePanelSessionByTokenHash,
  findPanelSessionByTokenHash,
  insertPanelSession,
  touchPanelSession,
} from "../repositories/panel-sessions.repo";
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

/**
 * Every function takes the owner whose sessions it touches, defaulting to the
 * one Operator (ADR 0011). A session of another owner is never found, revoked
 * or pruned by this one's calls (ADR 0041 D15).
 */
export async function createPanelSession(
  now = Date.now(),
  ownerId = OPERATOR_ID,
): Promise<{ token: string; session: PanelSession }> {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const session: PanelSession = {
    id: randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  await insertPanelSession({
    id: session.id,
    ownerId,
    tokenHash: hashToken(token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: session.expiresAt,
  });
  await pruneExpiredSessions(now, ownerId);
  return { token, session };
}

/**
 * Resolve a cookie value to a live session, sliding its expiry. Returns null
 * for unknown, revoked, and expired tokens alike — the caller can't tell which,
 * and neither can an attacker.
 */
export async function resolvePanelSession(
  token: string | null | undefined,
  now = Date.now(),
  ownerId = OPERATOR_ID,
): Promise<PanelSession | null> {
  if (!token) return null;
  const row = await findPanelSessionByTokenHash(ownerId, hashToken(token));
  if (!row) return null;
  if (row.expiresAt <= now) {
    await deletePanelSessionById(ownerId, row.id);
    return null;
  }
  let { lastSeenAt, expiresAt } = row;
  if (now - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    lastSeenAt = now;
    expiresAt = now + SESSION_TTL_MS;
    await touchPanelSession(ownerId, row.id, lastSeenAt, expiresAt);
  }
  return { id: row.id, createdAt: row.createdAt, lastSeenAt, expiresAt };
}

export async function revokePanelSession(
  token: string | null | undefined,
  ownerId = OPERATOR_ID,
): Promise<void> {
  if (!token) return;
  await deletePanelSessionByTokenHash(ownerId, hashToken(token));
}

/** Log every browser out — a password change, or an explicit "sign out everywhere". */
export async function revokeAllPanelSessions(ownerId = OPERATOR_ID): Promise<void> {
  await deleteAllPanelSessions(ownerId);
}

export async function pruneExpiredSessions(now = Date.now(), ownerId = OPERATOR_ID): Promise<void> {
  await deleteExpiredPanelSessions(ownerId, now);
}
