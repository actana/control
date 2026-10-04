import type { Session } from "~/db/schema";

/** The slice of the terminal store a session card click needs. */
type SessionOpener = {
  openSession: (
    coreId: string,
    session: Session,
    opts?: { ptyId?: string | null },
  ) => void;
  focusGridSession: (sessionId: string, opts?: { flash?: boolean }) => void;
};

type OpenClickedSessionDeps = {
  /** The Core's active session list. */
  sessions: readonly Session[];
  /** The rows the Archived view is showing. They are absent from `sessions` (ADR 0019). */
  archivedSessions: readonly Session[];
  coreId: string | null;
  terminals: SessionOpener;
};

/**
 * Open (or reattach) the session behind a card click, from either list.
 *
 * A Core keeps its archived rows in their own list (ADR 0019), so a click on an
 * archived card resolved against `sessions` alone finds nothing and the card — and
 * its Reply button, which routes here too — does nothing at all (issue 397).
 * Falling back to the archived rows resolves those the same way active ones are
 * resolved. Active rows still resolve out of `sessions` first, so their behaviour
 * is untouched.
 *
 * Returns whether a session was opened.
 */
export function openClickedSession(sessionId: string, deps: OpenClickedSessionDeps): boolean {
  const { sessions, archivedSessions, coreId, terminals } = deps;
  const session = sessions.find((t) => t.id === sessionId) ?? archivedSessions.find((t) => t.id === sessionId);
  if (!session || !coreId) return false;
  terminals.openSession(coreId, session);
  // Move the caret into the session's terminal so the user can type right
  // away. Switching to an already-built (cached) surface reattaches without
  // focusing, so without this the card click selects the session but leaves
  // the terminal blurred until a second manual click. TerminalPanel consumes
  // this request and re-asserts focus across the pane remount.
  terminals.focusGridSession(sessionId);
  return true;
}
