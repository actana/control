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
  findSessionsByProjectId,
  insertSession,
  updateSessionRow,
} from "../repositories/sessions.repo";
import { findProjectNameById } from "../repositories/projects.repo";
import {
  deleteTerminalLogById,
  findTerminalLogsBySessionId,
  insertTerminalLog,
} from "../repositories/terminal-logs.repo";
import { newId } from "./_ids";
import { isClientDomainId } from "@actana/shared/client-id";

export function listSessionsForProject(projectId: string): Session[] {
  return findSessionsByProjectId(projectId);
}

export function getSession(id: string): Session | null {
  return findSessionById(id);
}

export function createSession(input: {
  id?: string;
  projectId: string;
  title: string;
  agent: Harness;
  status?: SessionStatus;
  preview?: string;
  claudeSessionId?: string | null;
  claudeSkipPermissions?: boolean;
  claudeBareSession?: boolean;
}): Session {
  if (!input.projectId) throw new Error("projectId required");
  if (!input.title?.trim()) throw new Error("title required");
  if (!isHarness(input.agent)) throw new Error("invalid agent");

  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid session id");
  if (requestedId && findSessionById(requestedId)) throw new Error("session id already exists");
  const row: Session = {
    id: requestedId || newId("t"),
    projectId: input.projectId,
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
  insertSession(row);
  events.emit("session:created", { id: row.id, projectId: row.projectId });
  return row;
}

export function updateStatus(
  id: string,
  patch: { status?: SessionStatus; preview?: string; lines?: number }
): Session | null {
  if (patch.status && !isSessionStatus(patch.status)) throw new Error("invalid status");
  const existing = findSessionById(id);
  if (!existing) return null;
  const next = {
    ...existing,
    status: patch.status ?? existing.status,
    preview: patch.preview ?? existing.preview,
    lines: patch.lines ?? existing.lines,
    updatedAt: Date.now(),
  };
  updateSessionRow(id, {
    status: next.status,
    preview: next.preview,
    lines: next.lines,
    updatedAt: next.updatedAt,
  });
  events.emit("session:updated", { id, projectId: existing.projectId });
  // Any status transition away from needs-input means the agent moved on, so
  // whatever question was pending is stale (answered, cancelled, interrupted).
  if (patch.status && patch.status !== "needs-input") {
    clearPendingQuestion(id);
  }
  // A dead or detached terminal takes its session's subagents with it; their
  // tracked entries must not hold a future session of this session on "running".
  if (patch.status === "terminated" || patch.status === "disconnected") {
    clearSubagentActivity(id);
  }
  if (
    patch.status === "finished" &&
    existing.status !== "finished"
  ) {
    const projectName = findProjectNameById(existing.projectId);
    events.emit("session:finished", {
      id,
      projectId: existing.projectId,
      projectName: projectName ?? "Project",
      sessionTitle: existing.title,
    });
  }
  return next;
}

/**
 * Startup sweep: mark every local-scope session still claiming a live agent
 * process (running / needs-input) as disconnected. Called by the Panel
 * once per app boot, before the first window loads — at that point no local
 * PTYs exist, so any such status is an orphan of a previous run (app quit or
 * crash killed the process before any hook could report). Goes through
 * updateStatus so events fire and stale subagent tracking is dropped.
 */
export function sweepOrphanedActiveSessions(): number {
  const orphans = findActiveLocalSessions();
  for (const t of orphans) {
    updateStatus(t.id, { status: "disconnected" });
  }
  return orphans.length;
}

export function updateSession(
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
  >
): Session | null {
  const existing = findSessionById(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  updateSessionRow(id, next);
  events.emit("session:updated", { id, projectId: existing.projectId });
  return next;
}

export function archiveSession(id: string): Session | null {
  const existing = findSessionById(id);
  if (!existing) return null;
  updateSessionRow(id, { archived: true, updatedAt: Date.now() });
  const next = { ...existing, archived: true } as Session;
  clearPendingQuestion(id);
  events.emit("session:archived", { id, projectId: existing.projectId });
  return next;
}

export function restoreSession(id: string): Session | null {
  const existing = findSessionById(id);
  if (!existing) return null;
  updateSessionRow(id, { archived: false, updatedAt: Date.now() });
  const next = { ...existing, archived: false } as Session;
  events.emit("session:restored", { id, projectId: existing.projectId });
  return next;
}

export function deleteSession(id: string): boolean {
  const existing = findSessionById(id);
  if (!existing) return false;
  const changes = deleteSessionRow(id);
  if (changes > 0) {
    clearPendingQuestion(id);
    events.emit("session:deleted", { id, projectId: existing.projectId });
    return true;
  }
  return false;
}

const RING_LIMIT_BYTES = 1_000_000;

export function appendTerminalLog(sessionId: string, chunk: string) {
  const id = newId("tl");
  insertTerminalLog({ id, sessionId, chunk, createdAt: Date.now() });
  // rough FIFO eviction by total length per session
  const all = findTerminalLogsBySessionId(sessionId);
  let total = all.reduce((a, r) => a + r.chunk.length, 0);
  for (const r of all) {
    if (total <= RING_LIMIT_BYTES) break;
    deleteTerminalLogById(r.id);
    total -= r.chunk.length;
  }
}

export function readTerminalLog(sessionId: string): string {
  return findTerminalLogsBySessionId(sessionId)
    .map((r) => r.chunk)
    .join("");
}
