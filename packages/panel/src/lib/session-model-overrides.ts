// Consume-once registry of per-session model overrides for sessions started with an
// explicit model (e.g. Ship). createSession stashes the model here; commandForSession
// peeks it so the agent launch command gets `--model`. Cleared on create failure
// so a stranded entry can't leak into a later session with a recycled client id.

import type { AiModelId } from "@actana/shared/ai-runtime-defaults";

const pending = new Map<string, AiModelId>();
const MAX_PENDING = 16;

export function setPendingSessionModel(sessionId: string, model: AiModelId | null | undefined): void {
  if (!model) return;
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(sessionId, model);
}

export function peekPendingSessionModel(sessionId: string): AiModelId | null {
  return pending.get(sessionId) ?? null;
}

export function clearPendingSessionModel(sessionId: string): void {
  pending.delete(sessionId);
}
