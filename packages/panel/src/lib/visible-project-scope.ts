/**
 * Which project+core the operator is actually looking at right now.
 *
 * A project's rows are read per `(projectId, coreId)` bucket, and a read of an
 * uncached pin is slow enough to outlive the click that started it. Clicking
 * A then B then A leaves B's `useProject` / `useTasks` fetches in flight
 * against a URL that has already gone back to A: whatever they were going to
 * materialize — sessions, the archived count, the focus that follows them —
 * arrives for a project nobody is on any more (issue 381).
 *
 * So the query layer keeps a count of the live views of each project+core.
 * A scope with at least one viewer is on screen; a scope whose last viewer has
 * gone is one the operator has left, and an answer that lands after that must
 * not win. The counter is the whole mechanism: it says nothing about freshness
 * (the 30s `staleTime` is untouched — a cold pin still loads, it just cannot
 * win after you have left it) and nothing about who fetched.
 *
 * Deliberately module state rather than context: the queries this guards are
 * read from several components at once (the board, the grid's hidden-session
 * bar, a pane's per-row subscription), and they have to agree on one answer to
 * "is anyone still watching B?" without a shared parent.
 */

export type ProjectScope = { projectId: string; coreId: string | null };

/** The Panel's own rows have no Core behind them, so `null` is a scope of its
 *  own — never the same bucket as a Core's project of the same id. The
 *  separator is a character no id can carry, so no two scopes can collide. */
export function projectScopeToken(projectId: string, coreId: string | null): string {
  return `${coreId ?? ""}\u0000${projectId}`;
}

type ScopeViews = { viewers: number; onLeft: Set<() => void> };

const scopes = new Map<string, ScopeViews>();

/**
 * Register a live view of this project+core. Call it while a component that
 * shows the scope is mounted; the returned release is idempotent, so a double
 * cleanup (StrictMode) cannot drive the count negative.
 *
 * `onLeft` runs when the *scope* loses its last viewer — not when this
 * particular view does. A project is read by more than one query at a time
 * (its row, its task list), each unmounting in its own cleanup, and the first
 * of them to go must not conclude the operator has left while the others are
 * still on screen. So every reader's `onLeft` is held until the count reaches
 * zero, and then all of them run together.
 */
export function retainProjectScope(
  projectId: string,
  coreId: string | null,
  onLeft?: () => void,
): () => void {
  const token = projectScopeToken(projectId, coreId);
  let scope = scopes.get(token);
  if (!scope) {
    scope = { viewers: 0, onLeft: new Set() };
    scopes.set(token, scope);
  }
  scope.viewers += 1;
  if (onLeft) scope.onLeft.add(onLeft);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = scopes.get(token);
    if (!current) return;
    current.viewers -= 1;
    if (current.viewers > 0) return;
    // Dropped before the callbacks run, so they see a scope nobody is on.
    scopes.delete(token);
    for (const left of current.onLeft) left();
  };
}

/** Is anything on screen still showing this project+core? */
export function isProjectScopeVisible(projectId: string, coreId: string | null): boolean {
  return (scopes.get(projectScopeToken(projectId, coreId))?.viewers ?? 0) > 0;
}

/**
 * Stamp this project+core's visibility now, for a read that is about to start.
 * The returned predicate answers one question at the moment the read lands:
 * *has the operator left this scope since?*
 *
 * A read nobody was watching to begin with — an imperative `fetchQuery`, a
 * prefetch, a server-side render — was never on screen and so can never have
 * been left. Those keep their side effects; only a read that belonged to a
 * view the operator has since walked away from is treated as late.
 */
export function watchProjectScope(projectId: string, coreId: string | null): () => boolean {
  const wasVisible = isProjectScopeVisible(projectId, coreId);
  return () => wasVisible && !isProjectScopeVisible(projectId, coreId);
}

/** Test-only: forget every registered view. */
export function __resetProjectScopesForTests(): void {
  scopes.clear();
}
