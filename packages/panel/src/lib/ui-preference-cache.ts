import {
  normalizeActiveProjectGroup,
  normalizeCollapsedProjectGroups,
  normalizeProjectsDashboardView,
  type ActiveProjectGroup,
  type CollapsedProjectGroups,
  type ProjectsDashboardView,
} from "~/shared/ui-preferences";

export const PROJECTS_DASHBOARD_VIEW_STORAGE_KEY = "mc:projectsDashboardView";
export const ACTIVE_PROJECT_GROUP_STORAGE_KEY = "mc:activeProjectGroup";
export const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "mc:collapsedProjectGroups";

/**
 * A string-valued UI preference persisted in localStorage, normalized on read.
 * SSR-safe: `read` returns null and `write` no-ops outside the browser, and
 * both swallow storage errors.
 */
function makeStringPreference<T extends string>(
  key: string,
  normalize: (raw: string | null) => T | null,
): { read: () => T | null; write: (view: T) => void } {
  return {
    read() {
      if (typeof window === "undefined") return null;
      try {
        return normalize(window.localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    write(view: T) {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(key, view);
      } catch {
        /* localStorage unavailable */
      }
    },
  };
}

const projectsDashboardView = makeStringPreference<ProjectsDashboardView>(
  PROJECTS_DASHBOARD_VIEW_STORAGE_KEY,
  normalizeProjectsDashboardView,
);
export const readCachedProjectsDashboardView = projectsDashboardView.read;
export const writeCachedProjectsDashboardView = projectsDashboardView.write;

const activeProjectGroup = makeStringPreference<ActiveProjectGroup>(
  ACTIVE_PROJECT_GROUP_STORAGE_KEY,
  normalizeActiveProjectGroup,
);
export const readCachedActiveProjectGroup = activeProjectGroup.read;
export const writeCachedActiveProjectGroup = activeProjectGroup.write;

export function readCachedCollapsedProjectGroups(): CollapsedProjectGroups | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY);
    return raw ? normalizeCollapsedProjectGroups(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCachedCollapsedProjectGroups(collapsed: CollapsedProjectGroups): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    /* localStorage unavailable */
  }
}
