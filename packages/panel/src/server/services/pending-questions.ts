import { randomUUID } from "node:crypto";
import type { HarnessQuestion, PendingQuestion } from "~/shared/harness-questions";
import { events } from "../events";

// In-memory on purpose: a pending question is only meaningful while its PTY
// (and the TUI menu inside it) is alive, and both die with the app process.
const pending = new Map<string, PendingQuestion>();

export function setPendingQuestion(input: {
  sessionId: string;
  questions: HarnessQuestion[];
  id?: string;
}): PendingQuestion {
  const question: PendingQuestion = {
    id: input.id?.trim() || randomUUID(),
    sessionId: input.sessionId,
    questions: input.questions,
    createdAt: Date.now(),
  };
  pending.set(input.sessionId, question);
  events.emit("session:question", {
    sessionId: question.sessionId,
    questionId: question.id,
    questions: question.questions,
  });
  return question;
}

export function getPendingQuestion(sessionId: string): PendingQuestion | null {
  return pending.get(sessionId) ?? null;
}

export function clearPendingQuestion(sessionId: string): void {
  const existing = pending.get(sessionId);
  if (!existing) return;
  pending.delete(sessionId);
  events.emit("session:question-cleared", { sessionId });
}
