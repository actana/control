/**
 * Which project+core the operator is actually looking at right now, and how
 * many times they have walked away from it.
 *
 * A project's rows are read per `(projectId, coreId)` bucket, and a read of an
 * uncached pin is slow enough to outlive the click that started it. Clicking
 * A then B then A leaves B's `useProject` / `useTasks` fetches in flight
 * against a URL that has already gone back to A: whatever they were going to
 * materialize — sessions, the archived count, the focus that follows them —
 * arrives for a project nobody is on any more (issue 381).
 *
 * So the query layer keeps two things per scope:
 *
 *  - **a count of its live views.** A scope with at least one viewer is on
 *    screen; a scope whose last viewer has gone is one the operator has left,
 *    and the fetches that were feeding it are cancelled on the spot.
 *  - **a visit generation**, bumped every time the count falls to zero. This is
 *    what tells *left* from *left and came back*: a read stamped with an older
 *    generation belongs to a visit that is over, however many times the
 *    operator has since returned. A "is it visible now?" snapshot cannot say
 *    that — during A → B → A → B, B's first read lands while B is on screen
 *    again and looks perfectly current, which is how a cancelled read's
 *    archived count came to overwrite the count of the read that replaced it.
 *
 * Neither says anything about freshness: the 30s `staleTime` is untouched, and
 * a cold pin still loads — it just cannot win after you have left it.
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

type ScopeViews = {
  viewers: number;
  /** Bumped when `viewers` falls to zero — see the module docstring. */
  generation: number;
  /**
   * What to abandon when this scope loses its last viewer, keyed by the query
   * key each reader reads, so a pane mounting and unmounting through a single
   * visit replaces its entry instead of piling up another closure over the
   * same key. Entries are held until zero rather than dropped as each reader
   * releases: a project is read by two queries whose cleanups run one after
   * the other inside one commit, and dropping the first reader's entry as it
   * goes would leave its fetch uncancelled when the second reader takes the
   * scope to zero a moment later.
   */
  onLeft: Map<string, () => void>;
};

/**
 * Entries are never removed, only emptied: the generation is the whole point
 * and it has to survive the scope being left, or a read stamped during visit 2
 * would compare against a freshly minted zero. Bounded by the number of
 * distinct projects one tab visits.
 */
const scopes = new Map<string, ScopeViews>();

function scopeFor(token: string): ScopeViews {
  let scope = scopes.get(token);
  if (!scope) {
    scope = { viewers: 0, generation: 0, onLeft: new Map() };
    scopes.set(token, scope);
  }
  return scope;
}

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
 * zero, and then all of them run together, once per distinct `readerKey`.
 */
export function retainProjectScope(
  projectId: string,
  coreId: string | null,
  reader?: { readerKey: string; onLeft: () => void },
): () => void {
  const token = projectScopeToken(projectId, coreId);
  const scope = scopeFor(token);
  scope.viewers += 1;
  if (reader) scope.onLeft.set(reader.readerKey, reader.onLeft);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = scopes.get(token);
    if (!current) return;
    current.viewers -= 1;
    if (current.viewers > 0) return;
    current.viewers = 0;
    // The visit is over. Bumping first means a fetch that a callback below
    // cannot cancel — one whose promise is already past the point of no
    // return — is stamped stale for good, even if the operator comes back.
    current.generation += 1;
    const leaving = [...current.onLeft.values()];
    current.onLeft.clear();
    for (const left of leaving) left();
  };
}

/** Is anything on screen still showing this project+core? */
export function isProjectScopeVisible(projectId: string, coreId: string | null): boolean {
  return (scopes.get(projectScopeToken(projectId, coreId))?.viewers ?? 0) > 0;
}

/** How many times this project+core has been left. Exposed for tests and for
 *  reasoning about {@link watchProjectScope}; callers should prefer that. */
export function projectScopeGeneration(projectId: string, coreId: string | null): number {
  return scopes.get(projectScopeToken(projectId, coreId))?.generation ?? 0;
}

/**
 * Stamp this project+core's visit for a read that is about to start. The
 * returned predicate answers one question at the moment the read lands: *does
 * this answer still belong to the visit that asked for it?*
 *
 * It is a generation compare, not a visibility check, and the difference is
 * the whole point. During A → B → A → B, B's first read is cancelled on the
 * way out and its replacement is what fills the screen — but the first read's
 * promise still resolves, and by then B is visible again. Asking "is B on
 * screen?" says yes and lets the abandoned answer overwrite the live one;
 * asking "is this still visit N?" says no.
 *
 * A read nobody was watching to begin with — an imperative `fetchQuery`, a
 * prefetch, a server-side render — spans no visit and so ends none: its
 * generation cannot move under it, and it keeps its side effects.
 */
export function watchProjectScope(projectId: string, coreId: string | null): () => boolean {
  const token = projectScopeToken(projectId, coreId);
  const startedAt = scopes.get(token)?.generation ?? 0;
  return () => (scopes.get(token)?.generation ?? 0) !== startedAt;
}

/** Test-only: forget every registered view and every visit counted. */
export function __resetProjectScopesForTests(): void {
  scopes.clear();
}
