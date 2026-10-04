/** Frozen storage-key suffix. Per-scope UI state (grid layouts, active-session
 * keys) was persisted under `${scopeId}:main` when worktree scoping existed —
 * keep the literal so that state survives the removal. */
const SCOPE_KEY_SUFFIX = "main";

/** Stable key identifying a Core's terminal bucket. A Core is the one scope a
 * Session belongs to (ADR 0041 D1). */
export function coreScopeKey(coreId: string): string {
  return `${coreId}:${SCOPE_KEY_SUFFIX}`;
}
