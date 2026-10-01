import type { Session } from "~/db/schema";

export type RequestedSessionTerminals = {
  activeFor: (coreId: string) => { sessionId: string } | null | undefined;
  activeSessionIdFor: (coreId: string) => string | null | undefined;
  rehydrate: (coreId: string, session: Session) => void;
  toggle: (coreId: string, session: Session) => void;
};

/**
 * Show the Session an open request names. The terminal must be created with the
 * Core that owns the Session: a pane with no Core id has no transport, so it
 * renders but never spawns (and the staged prompt is never delivered).
 */
export function showRequestedSession(deps: {
  terminals: RequestedSessionTerminals;
  session: Session;
  coreId: string;
}): void {
  const { terminals, session, coreId } = deps;
  if (terminals.activeFor(coreId)?.sessionId === session.id) return;
  if (terminals.activeSessionIdFor(coreId) === session.id) {
    terminals.rehydrate(coreId, session);
  } else {
    terminals.toggle(coreId, session);
  }
}
