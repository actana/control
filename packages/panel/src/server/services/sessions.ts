import { DEFAULT_BRANCH, DEFAULT_SESSION_STATUS, isHarness, isSessionStatus } from "@actana/shared/domain";
import type { Harness, SessionStatus } from "@actana/shared/domain";
import type { Session } from "~/db/schema";
import { events } from "../events";
import { clearPendingQuestion } from "./pending-questions";
import { clearSubagentActivity } from "./subagent-activity";
import {
  deleteSessionRow,
  findActiveLocalSessions,
  findSessionById,
  insertSession,
  updateSessionRow,
  type SessionRow,
} from "../repositories/sessions.repo";
import {
  deleteTerminalLogById,
  findTerminalLogsBySessionId,
  insertTerminalLog,
} from "../repositories/terminal-logs.repo";
import { newId } from "./_ids";
import { isClientDomainId } from "@actana/shared/client-id";
import { OPERATOR_ID } from "./operator";

export type { Session };

export async function getSession(id: string, ownerId = OPERATOR_ID): Promise<Session | null> {
  return (await findSessionById(ownerId, id)) as Session | null;
}

export async function createSession(
  input: {
    id?: string;
    title: string;
    agent: Harness;
    status?: SessionStatus;
    preview?: string;
    claudeSessionId?: string | null;
    claudeSkipPermissions?: boolean;
    claudeBareSession?: boolean;
  },
  ownerId = OPERATOR_ID,
): Promise<Session> {
  if (!input.title?.trim()) throw new Error("title required");
  if (!isHarness(input.agent)) throw new Error("invalid agent");

  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid session id");
  if (requestedId && (await findSessionById(ownerId, requestedId))) {
    throw new Error("session id already exists");
  }
  const row: SessionRow = {
    id: requestedId || newId("t"),
    ownerId,
    title: input.title.trim(),
    titleManuallySet: false,
    icon: null,
    agent: input.agent,
    status: input.status ?? DEFAULT_SESSION_STATUS,
    branch: DEFAULT_BRANCH,
    preview: input.preview ?? "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: input.claudeSessionId ?? null,
    claudeSkipPermissions: input.claudeSkipPermissions ?? false,
    claudeBareSession: input.claudeBareSession ?? false,
    createdAt: now,
    updatedAt: now,
  };
  await insertSession(row);
  events.emit("session:created", { id: row.id });
  return row as Session;
}

export async function updateStatus(
  id: string,
  patch: { status?: SessionStatus; preview?: string; lines?: number },
  ownerId = OPERATOR_ID,
): Promise<Session | null> {
  if (patch.status && !isSessionStatus(patch.status)) throw new Error("invalid status");
  const existing = await findSessionById(ownerId, id);
  if (!existing) return null;
  const next = {
    ...existing,
    status: patch.status ?? existing.status,
    preview: patch.preview ?? existing.preview,
    lines: patch.lines ?? existing.lines,
    updatedAt: Date.now(),
  };
  await updateSessionRow(ownerId, id, {
    status: next.status,
    preview: next.preview,
    lines: next.lines,
    updatedAt: next.updatedAt,
  });
  events.emit("session:updated", { id });
  if (patch.status && patch.status !== "needs-input") {
    clearPendingQuestion(id);
  }
  if (patch.status === "terminated" || patch.status === "disconnected") {
    clearSubagentActivity(id);
  }
  if (patch.status === "finished" && existing.status !== "finished") {
    events.emit("session:finished", {
      id,
      sessionTitle: existing.title,
    });
  }
  return next as Session;
}

/**
 * Startup sweep: mark every session still claiming a live agent process as
 * disconnected. Goes through updateStatus so events fire.
 */
export async function sweepOrphanedActiveSessions(ownerId = OPERATOR_ID): Promise<number> {
  const orphans = await findActiveLocalSessions(ownerId);
  for (const t of orphans) {
    await updateStatus(t.id, { status: "disconnected" }, ownerId);
  }
  return orphans.length;
}

export async function updateSession(
  id: string,
  patch: Partial<
    Pick<
      Session,
      | "title"
      | "titleManuallySet"
      | "icon"
      | "pinned"
      | "claudeSessionId"
      | "claudeSkipPermissions"
      | "claudeBareSession"
    >
  >,
  ownerId = OPERATOR_ID,
): Promise<Session | null> {
  const existing = await findSessionById(ownerId, id);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  await updateSessionRow(ownerId, id, next);
  events.emit("session:updated", { id });
  return next as Session;
}

export async function archiveSession(id: string, ownerId = OPERATOR_ID): Promise<Session | null> {
  const existing = await findSessionById(ownerId, id);
  if (!existing) return null;
  await updateSessionRow(ownerId, id, { archived: true, updatedAt: Date.now() });
  const next = { ...existing, archived: true };
  clearPendingQuestion(id);
  events.emit("session:archived", { id });
  return next as Session;
}

export async function restoreSession(id: string, ownerId = OPERATOR_ID): Promise<Session | null> {
  const existing = await findSessionById(ownerId, id);
  if (!existing) return null;
  await updateSessionRow(ownerId, id, { archived: false, updatedAt: Date.now() });
  const next = { ...existing, archived: false };
  events.emit("session:restored", { id });
  return next as Session;
}

export async function deleteSession(id: string, ownerId = OPERATOR_ID): Promise<boolean> {
  const existing = await findSessionById(ownerId, id);
  if (!existing) return false;
  const changes = await deleteSessionRow(ownerId, id);
  if (changes > 0) {
    clearPendingQuestion(id);
    events.emit("session:deleted", { id });
    return true;
  }
  return false;
}

const RING_LIMIT_BYTES = 1_000_000;

export async function appendTerminalLog(
  sessionId: string,
  chunk: string,
  ownerId = OPERATOR_ID,
): Promise<void> {
  const id = newId("tl");
  await insertTerminalLog({ id, ownerId, sessionId, chunk, createdAt: Date.now() });
  const all = await findTerminalLogsBySessionId(ownerId, sessionId);
  let total = all.reduce((a, r) => a + r.chunk.length, 0);
  for (const r of all) {
    if (total <= RING_LIMIT_BYTES) break;
    await deleteTerminalLogById(ownerId, r.id);
    total -= r.chunk.length;
  }
}

export async function readTerminalLog(sessionId: string, ownerId = OPERATOR_ID): Promise<string> {
  return (await findTerminalLogsBySessionId(ownerId, sessionId)).map((r) => r.chunk).join("");
}
