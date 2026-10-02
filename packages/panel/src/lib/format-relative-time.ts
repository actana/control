import { differenceInSeconds, formatDistance } from "date-fns";

/**
 * Relative time like "3 minutes ago". Pass `baseDate` when labels must stay
 * stable across re-renders (e.g. search result timestamps).
 *
 * Future timestamps (clock skew of a few seconds) read as "just now". Callers
 * that need a real future label (e.g. webhook retry due) must format that
 * themselves — see ApiSettingsPage's retry branch.
 */
export function formatRelativeTime(
  timestampMs: number,
  baseDate: number | Date = Date.now(),
): string {
  const date = new Date(timestampMs);
  const base = typeof baseDate === "number" ? new Date(baseDate) : baseDate;

  if (differenceInSeconds(base, date) < 60) return "just now";

  const text = formatDistance(date, base, { addSuffix: true });
  if (text === "less than a minute ago") return "just now";

  return text;
}
