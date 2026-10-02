import { differenceInSeconds, formatDistance } from "date-fns";

/**
 * Relative time like "3 minutes ago". Pass `baseDate` when labels must stay
 * stable across re-renders (e.g. search result timestamps).
 */
export function formatRelativeTime(
  timestampMs: number,
  baseDate: number | Date = Date.now(),
): string {
  const date = new Date(timestampMs);
  const base = typeof baseDate === "number" ? new Date(baseDate) : baseDate;

  // Only treat the past as "just now". A future time (e.g. webhook retry due in
  // 5m) used to hit this branch because differenceInSeconds(base, future) is
  // negative and therefore < 60 — Settings › API then showed "retry just now".
  const secondsAgo = differenceInSeconds(base, date);
  if (secondsAgo >= 0 && secondsAgo < 60) return "just now";

  const text = formatDistance(date, base, { addSuffix: true });
  if (text === "less than a minute ago") return "just now";

  return text;
}
