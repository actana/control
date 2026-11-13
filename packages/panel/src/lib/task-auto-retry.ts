import type { TaskAutoRetryView } from "~/shared/auto-retry";

/** The Task detail's auto-retry line (#958): what is allowed, what is used and, while one is pending, when it starts. */
export function formatAutoRetryLine(view: TaskAutoRetryView, now = Date.now()): string {
  const allowed = Math.max(0, view.maxAttempts - 1);
  const parts = [`Auto-retry: ${view.retries} of ${allowed} retries used (up to ${view.maxAttempts} attempts)`];
  if (view.pendingAt !== null) {
    const minutes = Math.max(1, Math.ceil((view.pendingAt - now) / 60_000));
    parts.push(`next attempt in ${minutes} min`);
  }
  return parts.join(", ");
}
