import type { Session } from "~/db/schema";
import type { ScopedProject } from "~/lib/scoped-project";

export type RequestedSessionTerminals = {
  activeFor: (scopeKey: string) => { sessionId: string } | null | undefined;
  activeSessionIdFor: (scopeKey: string) => string | null | undefined;
  rehydrate: (project: ScopedProject, session: Session, opts: { coreId: string | null }) => void;
  toggle: (project: ScopedProject, session: Session, opts: { coreId: string | null }) => void;
};

/**
 * Show the Session an open request names. The terminal must be created with the
 * Core that owns the Session: a pane with no Core id has no transport, so it
 * renders but never spawns (and the staged prompt is never delivered).
 */
export function showRequestedSession(deps: {
  terminals: RequestedSessionTerminals;
  scopeKey: string;
  project: ScopedProject;
  session: Session;
  coreId: string | null;
}): void {
  const { terminals, scopeKey, project, session, coreId } = deps;
  if (terminals.activeFor(scopeKey)?.sessionId === session.id) return;
  if (terminals.activeSessionIdFor(scopeKey) === session.id) {
    terminals.rehydrate(project, session, { coreId });
  } else {
    terminals.toggle(project, session, { coreId });
  }
}
