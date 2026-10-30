import { useSyncExternalStore } from "react";

export type Breakpoint = "phone" | "tablet" | "desktop";

export const PHONE_MAX_WIDTH = 767;
export const DESKTOP_MIN_WIDTH = 1024;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
export const COMPACT_QUERY = `(max-width: ${DESKTOP_MIN_WIDTH - 1}px)`;

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function getSnapshot(): Breakpoint {
  if (!hasMatchMedia()) return "desktop";
  if (window.matchMedia(PHONE_QUERY).matches) return "phone";
  if (window.matchMedia(COMPACT_QUERY).matches) return "tablet";
  return "desktop";
}

function getServerSnapshot(): Breakpoint {
  return "desktop";
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const lists = [PHONE_QUERY, COMPACT_QUERY].map((q) => window.matchMedia(q));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIsPhone(): boolean {
  return useBreakpoint() === "phone";
}

/** Phone or tablet: the viewports that get the compact shell. */
export function useIsCompact(): boolean {
  return useBreakpoint() !== "desktop";
}
