export const PROJECTS_DASHBOARD_VIEWS = ["cards", "table"] as const;
export type ProjectsDashboardView = (typeof PROJECTS_DASHBOARD_VIEWS)[number];

export const DEFAULT_PROJECTS_DASHBOARD_VIEW: ProjectsDashboardView = "cards";

/**
 * The globally active project group — a workspace-like context that scopes
 * the dashboard, the left project rail, and the project picker.
 * Either the sentinel "all" / "ungrouped" or a group id.
 */
export const ACTIVE_GROUP_ALL = "all" as const;
export const ACTIVE_GROUP_UNGROUPED = "ungrouped" as const;
export type ActiveProjectGroup = string;
export const DEFAULT_ACTIVE_PROJECT_GROUP: ActiveProjectGroup = ACTIVE_GROUP_ALL;
export const ACTIVE_PROJECT_GROUP_MAX_LENGTH = 200;

function normalizeEnumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

export function normalizeProjectsDashboardView(
  value: unknown,
): ProjectsDashboardView | null {
  return normalizeEnumValue(value, PROJECTS_DASHBOARD_VIEWS);
}

/** Collapsed dashboard section keys — group ids plus "pinned" / "ungrouped". */
export type CollapsedProjectGroups = string[];

export function normalizeCollapsedProjectGroups(value: unknown): CollapsedProjectGroups | null {
  if (!Array.isArray(value)) return null;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

export function normalizeActiveProjectGroup(value: unknown): ActiveProjectGroup | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ACTIVE_PROJECT_GROUP_MAX_LENGTH) return null;
  return trimmed;
}
