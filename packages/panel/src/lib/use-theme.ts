import { useCallback, useEffect, useState } from "react";

/** Operator preference: follow the OS, or pin light/dark. */
export type Theme = "system" | "light" | "dark";
/** What actually renders — the resolved end of the `system` preference. */
export type ResolvedTheme = "light" | "dark";

const KEY = "mc:theme";
// Pre-spec-12 key (dot, not colon). Read once as a fallback so an operator's
// pinned dark/light choice survives the upgrade, then rewritten under KEY.
const LEGACY_KEY = "mc.theme";

/** localStorage key for the system/light/dark preference. Shared with the
 *  pre-hydration script in __root.tsx. */
export const THEME_CACHE_KEY = KEY;

/**
 * The cached theme preference. Defaults to `system` — the Panel follows the
 * OS unless the operator pins a choice. Shared with the pre-hydration script
 * so the choice survives reloads with no flash.
 */
export function readCachedTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const value = window.localStorage.getItem(KEY);
    if (value === "light" || value === "dark") return value;
    if (value === null) {
      // One-time migration of the pre-spec-12 pinned choice.
      const legacy = window.localStorage.getItem(LEGACY_KEY);
      if (legacy === "light" || legacy === "dark") {
        window.localStorage.setItem(KEY, legacy);
        window.localStorage.removeItem(LEGACY_KEY);
        return legacy;
      }
    }
    return "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Collapse a preference to what should render right now. */
export function resolveTheme(preference: Theme): ResolvedTheme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

/** Reconcile the DOM with a preference: the `.dark` class on `<html>` is the
 *  single theme axis (light is the default `:root` palette). */
export function applyTheme(preference: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(preference) === "dark",
  );
}

function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Theme hook (system/light/dark). Avoids React 19 hydration mismatches by
 * NEVER rendering the `.dark` class via JSX on `<html>`; instead it seeds from
 * the cached preference and mutates `document.documentElement`
 * post-hydration. While the preference is `system`, a `prefers-color-scheme`
 * listener keeps the class in step with the OS.
 */
export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>("system");

  // Restore the cached preference on mount and reconcile the DOM.
  useEffect(() => {
    const cached = readCachedTheme();
    setThemeState(cached);
    applyTheme(cached);
  }, []);

  // Follow the OS while the preference is `system`.
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, [theme]);

  const set = useCallback((next: Theme) => {
    setThemeState(next);
    persistTheme(next);
    applyTheme(next);
  }, []);

  // Pin the opposite of what currently renders (system resolves first).
  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = resolveTheme(prev) === "dark" ? "light" : "dark";
      persistTheme(next);
      applyTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle, set };
}
