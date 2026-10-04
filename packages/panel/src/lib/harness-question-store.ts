import { useSyncExternalStore } from "react";
import { api } from "~/lib/api";
import type { ServerEvent } from "~/lib/use-events";
import { parseAskUserQuestionInput, type PendingQuestion } from "~/shared/harness-questions";
import { createListenerSet } from "./listener-set";

/**
 * Renderer-side cache of pending AskUserQuestion payloads, keyed by session.
 * Populated from `session:question` SSE events (which carry the full payload, so
 * no query round-trip) and hydrated on demand for panes that mount after the
 * event fired. `undefined` = not hydrated yet, `null` = known to have none.
 */
type Entry = PendingQuestion | null;

const entries = new Map<string, Entry>();
// Questions the user hid locally (esc) — keyed by question id so a NEW
// question on the same session still shows its overlay.
const dismissed = new Set<string>();
const hydrating = new Set<string>();

const { subscribe, notify } = createListenerSet();

export function getSessionQuestion(sessionId: string): Entry | undefined {
  return entries.get(sessionId);
}

export function getCurrentQuestionId(sessionId: string): string | null {
  return entries.get(sessionId)?.id ?? null;
}

export function useSessionQuestion(sessionId: string): PendingQuestion | null | undefined {
  return useSyncExternalStore(subscribe, () => entries.get(sessionId));
}

export function dismissQuestionLocally(questionId: string): void {
  dismissed.add(questionId);
  notify();
}

export function isQuestionDismissed(questionId: string): boolean {
  return dismissed.has(questionId);
}

export function useQuestionDismissed(questionId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () =>
    questionId ? dismissed.has(questionId) : false,
  );
}

// Questions the user started answering directly in the terminal. Once the TUI
// highlight has moved under our feet, injected key sequences would target the
// wrong row, so the overlay degrades to a passive banner.
const desynced = new Set<string>();

export function markQuestionDesynced(sessionId: string): void {
  const questionId = entries.get(sessionId)?.id;
  if (!questionId || desynced.has(questionId)) return;
  desynced.add(questionId);
  notify();
}

export function isQuestionDesynced(questionId: string): boolean {
  return desynced.has(questionId);
}

/**
 * The question whose TUI menu should be suppressed in the terminal because
 * the popup overlay is answering it. Dismissing the overlay or typing in the
 * terminal (desync) hands the menu back to the terminal — returns null then.
 */
export function getHoldQuestion(sessionId: string): PendingQuestion | null {
  const question = entries.get(sessionId);
  if (!question) return null;
  return dismissed.has(question.id) || desynced.has(question.id) ? null : question;
}

/** Subscribe to any store change (non-React consumers, e.g. the menu hold). */
export function subscribeQuestionStore(listener: () => void): () => void {
  return subscribe(listener);
}

export function useQuestionDesynced(questionId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () =>
    questionId ? desynced.has(questionId) : false,
  );
}

function setEntry(sessionId: string, entry: Entry): void {
  const prev = entries.get(sessionId);
  if (prev === entry || (prev && entry && prev.id === entry.id)) return;
  if (prev) {
    dismissed.delete(prev.id);
    desynced.delete(prev.id);
  }
  entries.set(sessionId, entry);
  notify();
}

function parseQuestionEvent(event: ServerEvent): PendingQuestion | null {
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const questionId = typeof event.questionId === "string" ? event.questionId : "";
  // The SSE payload is our own emit, but it crosses a JSON boundary — reuse
  // the defensive parser rather than trusting the shape.
  const questions = parseAskUserQuestionInput({ questions: event.questions });
  if (!sessionId || !questionId || !questions) return null;
  return { id: questionId, sessionId, questions, createdAt: Date.now() };
}

export function applyQuestionServerEvent(event: ServerEvent): void {
  if (event.type === "session:question") {
    const question = parseQuestionEvent(event);
    if (question) setEntry(question.sessionId, question);
    return;
  }
  if (event.type === "session:question-cleared") {
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (sessionId) setEntry(sessionId, null);
    return;
  }
  if (event.type === "session:deleted") {
    const sessionId = typeof event.id === "string" ? event.id : "";
    if (sessionId && entries.has(sessionId)) {
      entries.delete(sessionId);
      notify();
    }
  }
}

export async function hydrateSessionQuestion(sessionId: string): Promise<void> {
  if (entries.has(sessionId) || hydrating.has(sessionId)) return;
  hydrating.add(sessionId);
  try {
    const { question } = await api.getSessionQuestion(sessionId);
    // An SSE event may have landed while the fetch was in flight; it wins.
    if (!entries.has(sessionId)) setEntry(sessionId, question);
  } catch {
    /* pane falls back to the plain badge */
  } finally {
    hydrating.delete(sessionId);
  }
}
