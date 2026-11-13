import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { formatTaskStopComment, isTaskSessionState, type TaskSessionState, type TaskStatus } from "~/shared/tasks";
import { findTaskWatchRow } from "../repositories/task-watch.repo";
import { deriveSubkey } from "./secrets-at-rest";

/**
 * The status URL of a Task attempt (#950): `GET /api/watch/<token>`, readable with no cookie and no key, so a
 * small looping command on a Core can wait for a Task without an API key or MCP.
 *
 * The token is `base64url("<taskId>.<attempt>.<expiresAt>") . base64url(HMAC-SHA256)`, keyed by a subkey of the
 * Panel's secrets key (HKDF info `task-watch`). There is no table: it is computed from the Task on demand.
 */

/** How long after an attempt's time limit, or after it ended, its status can still be read. */
export const WATCH_GRACE_MS = 10 * 60_000;
/** A Task with No time limit gets a token that lasts this long from minting; every read of the Task mints a fresh one. */
export const NO_LIMIT_WATCH_TTL_MS = 24 * 60 * 60_000;
/** Within this long of a Session state change the poll interval is short. */
const RECENT_CHANGE_MS = 30_000;

export const WATCH_PATH_PREFIX = "/api/watch/";

/** The watch payload. Shared word for word with the Studio twin and with #949: do not change it on one side only. */
export type TaskWatchPayload = {
  taskId: string;
  attempt: number;
  status: TaskStatus;
  sessionState: TaskSessionState | null;
  sessionStateAt: number | null;
  result: "done" | "failed" | "partial" | null;
  updatedAt: number;
  pollAfterSeconds: number;
};

export type WatchRead =
  | { kind: "ok"; payload: TaskWatchPayload }
  /** The token was good once and is not now: a new attempt, a stop, a delete, or past its time. */
  | { kind: "gone" }
  /** No such token: the signature does not match, or the text is not a token. */
  | { kind: "not-found" };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const b64u = (b: Buffer): string => b.toString("base64url");

function sign(payload: string): Buffer {
  return createHmac("sha256", deriveSubkey("task-watch")).update(payload).digest();
}

export function mintWatchToken(taskId: string, attempt: number, expiresAt: number): string {
  const payload = b64u(Buffer.from(`${taskId}.${attempt}.${expiresAt}`, "utf8"));
  return `${payload}.${b64u(sign(payload))}`;
}

export function verifyWatchToken(token: string): { taskId: string; attempt: number; expiresAt: number } | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  // One spelling per token: Node's decoder ignores padding and stray characters, which would give one token
  // many strings, each with its own rate-limit bucket.
  if (!BASE64URL.test(parts[0]) || !BASE64URL.test(parts[1])) return null;
  const given = Buffer.from(parts[1], "base64url");
  const expected = sign(parts[0]);
  if (b64u(given) !== parts[1] || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const body = Buffer.from(parts[0], "base64url");
  if (b64u(body) !== parts[0]) return null;
  const m = /^(.+)\.(\d+)\.(\d+)$/.exec(body.toString("utf8"));
  if (!m) return null;
  return { taskId: m[1]!, attempt: Number(m[2]), expiresAt: Number(m[3]) };
}

/** A token's own expiry: the attempt's time limit plus 10 minutes, or 24 hours from `now` for No limit. */
export function watchExpiresAt(task: { timeoutMinutes: number | null; dispatchedAt: number | null }, now: number): number {
  if (task.timeoutMinutes === null) return now + NO_LIMIT_WATCH_TTL_MS;
  return (task.dispatchedAt ?? now) + task.timeoutMinutes * 60_000 + WATCH_GRACE_MS;
}

/** The token for a Task's current attempt. Computed, never stored. */
export function taskWatchToken(
  task: { id: string; attemptCount: number; timeoutMinutes: number | null; dispatchedAt: number | null },
  now: number = Date.now(),
): string {
  return mintWatchToken(task.id, task.attemptCount, watchExpiresAt(task, now));
}

/** The absolute URL: `AC_PANEL_PUBLIC_URL` when set, else the request's origin. */
export function taskWatchUrl(token: string, requestOrigin: string): string {
  const configured = process.env.AC_PANEL_PUBLIC_URL?.trim();
  const base = (configured || requestOrigin).replace(/\/+$/, "");
  return `${base}${WATCH_PATH_PREFIX}${token}`;
}

/** A short stable id for a token, for the rate-limit key: the token itself never sits in a bucket name or a log. */
export function watchTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** How soon the caller should ask again: 0 finished, 2 for 30 s after a state change, 15 when waiting on a person or a result, else 5. */
export function pollAfterSeconds(
  task: { status: string; sessionState: string | null; sessionStateAt: number | null },
  now: number,
): number {
  if (isFinished(task.status)) return 0;
  if (task.sessionStateAt !== null && now - task.sessionStateAt < RECENT_CHANGE_MS) return 2;
  if (task.sessionState === "needs-input" || task.sessionState === "idle-no-result") return 15;
  return 5;
}

function isFinished(status: string): status is "done" | "failed" | "partial" {
  return status === "done" || status === "failed" || status === "partial";
}

// `formatTaskStopComment` writes `Stopped by X…`; the prefix is derived from it so the two cannot drift.
const STOP_COMMENT_PREFIX = formatTaskStopComment({ stoppedBy: "\u0000" }).split("\u0000")[0]!;

/** A Task stopped by an operator is `failed` with the stop comment as its last error (`markTaskStopped`). */
function wasStopped(lastError: string | null): boolean {
  return lastError !== null && lastError.startsWith(STOP_COMMENT_PREFIX);
}

export async function readWatch(token: string, now: number = Date.now()): Promise<WatchRead> {
  const claim = verifyWatchToken(token);
  if (!claim) return { kind: "not-found" };
  if (now >= claim.expiresAt) return { kind: "gone" };
  const task = await findTaskWatchRow(claim.taskId);
  if (!task || task.attemptCount !== claim.attempt) return { kind: "gone" };
  const status = task.status;
  if (status === "in_progress") {
    // running: readable
  } else if (isFinished(status)) {
    if (wasStopped(task.lastError)) return { kind: "gone" };
    if (task.endedAt === null || now > task.endedAt + WATCH_GRACE_MS) return { kind: "gone" };
  } else {
    return { kind: "gone" };
  }
  return {
    kind: "ok",
    payload: {
      taskId: task.id,
      attempt: task.attemptCount,
      status: status as TaskStatus,
      sessionState: isTaskSessionState(task.sessionState) ? task.sessionState : null,
      sessionStateAt: task.sessionStateAt,
      result: isFinished(status) ? status : null,
      updatedAt: task.updatedAt,
      pollAfterSeconds: pollAfterSeconds(task, now),
    },
  };
}
