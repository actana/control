// Throttle a high-cardinality error log so a persistent failure (e.g. a boot
// blocker that misfires on every 500 ms poll tick) collapses to one line per
// window instead of filling the log.
//
// Behavior: first call in a window emits the tag verbatim with the caller's
// fields; subsequent calls within the window are silently counted; the next
// call after the window elapses first flushes a `${tag}.summary` line with
// `{ count, error }` for the suppressed span, then emits the caller's fields
// verbatim and starts a new window.

import log from "@actana/shared/log";

type Fields = Record<string, unknown>;

type Level = "info" | "warn" | "error";

export interface OpenFailedThrottle {
  (fields: Fields): void;
}

export function makeOpenFailedThrottle(
  tag: string,
  windowMs = 60_000,
  level: Level = "error",
  now: () => number = Date.now,
): OpenFailedThrottle {
  let windowStart = 0;
  let suppressed = 0;
  let lastError: unknown = null;
  const emit = (fields: Fields) => log[level](tag, fields);
  return (fields: Fields) => {
    const t = now();
    if (windowStart === 0 || t - windowStart > windowMs) {
      if (suppressed > 0) {
        log[level](`${tag}.summary`, { count: suppressed, error: String(lastError) });
      }
      emit(fields);
      windowStart = t;
      suppressed = 0;
      lastError = null;
      return;
    }
    suppressed += 1;
    lastError = fields.error ?? lastError;
  };
}
