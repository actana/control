import {
  normalizeActiveProjectGroup,
  
  
  type ActiveProjectGroup,
  
  
} from "~/shared/ui-preferences";

export const ACTIVE_PROJECT_GROUP_STORAGE_KEY = "mc:activeProjectGroup";

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

const activeProjectGroup = makeStringPreference<ActiveProjectGroup>(
  ACTIVE_PROJECT_GROUP_STORAGE_KEY,
  normalizeActiveProjectGroup,
);
export const readCachedActiveProjectGroup = activeProjectGroup.read;
export const writeCachedActiveProjectGroup = activeProjectGroup.write;

