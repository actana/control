// Opt-in auto-retry of a Task whose Session died without a result (#958).
//
// Everything here is pure: no clock, no database. The server passes the facts in (`now` included) and acts on the
// answer. Every guard of the issue is one line of `decideAutoRetry`, so the table in the test is the whole policy.

/** The most attempts a Task may ask for. The instance ceiling (`tasks.autoRetry.maxAttemptsCeiling`) can only lower it. */
export const AUTO_RETRY_MAX_ATTEMPTS = 3;
/** Wait before the 1st, 2nd and 3rd auto-retry of one Task (1, 5, 15 minutes). */
export const AUTO_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;
/** An attempt that exits sooner than this does not count: a broken harness must not burn every attempt (guard 5 of the card). */
export const AUTO_RETRY_MIN_RUN_MS = 120_000;
/** A Session that ran this long made progress by itself (guard 2). */
export const AUTO_RETRY_PROGRESS_RUN_MS = 600_000;
/** Circuit breaker per Core (guard 5): this many auto-retries within the window pause auto-retry on that Core. */
export const AUTO_RETRY_BREAKER_COUNT = 3;
export const AUTO_RETRY_BREAKER_WINDOW_MS = 3_600_000;

/** The instance settings (app_settings keys); never env-only. */
export const AUTO_RETRY_ENABLED_KEY = "tasks.autoRetry.enabled";
export const AUTO_RETRY_CEILING_KEY = "tasks.autoRetry.maxAttemptsCeiling";
export const AUTO_RETRY_CORE_RETRIES_KEY = "tasks.autoRetry.coreRetries";
export const AUTO_RETRY_PAUSED_CORES_KEY = "tasks.autoRetry.pausedCores";

export type AutoRetryNoticeKind = "retry" | "gave-up" | "paused";

/** The latest operator-facing auto-retry event of a Task; `id` changes with every new one, so a client can tell. */
export type TaskAutoRetryNotice = { id: number; kind: AutoRetryNoticeKind; text: string };

/** What the Task row stores in `tasks.auto_retry`. */
export type TaskAutoRetry = {
  /** Requested, already clamped to the ceiling when it was written. */
  maxAttempts: number;
  /** Auto-retries this Task has used. */
  retries: number;
  /** Auto-retries the lineage used before this Task (guard 4). */
  inherited: number;
  /** Epoch ms: a retry is pending, the Task is `assigned` and must not be claimed earlier. */
  notBefore: number | null;
  /** Signature of the last attempt's failure, `code|last line` (guard 3). */
  lastCause: string | null;
  notice: TaskAutoRetryNotice | null;
  /**
   * `false`: a lineage-only record. The Task did not opt in; it only carries the retries its lineage used (guard 4), so a Task
   * made from it later starts with the count. Absent (older rows) or `true`: opted in.
   */
  optedIn?: boolean;
};

/** Whether a Task opted in to auto-retry: it has a record and the record is not lineage-only. */
export function isAutoRetryOptedIn(autoRetry: TaskAutoRetry | null | undefined): autoRetry is TaskAutoRetry {
  return !!autoRetry && autoRetry.optedIn !== false;
}

/** What a Task shows the outside (DTOs, MCP): the lineage and the cause stay inside. */
export type TaskAutoRetryView = {
  maxAttempts: number;
  retries: number;
  pendingAt: number | null;
  notice: TaskAutoRetryNotice | null;
};

export function taskAutoRetryView(autoRetry: TaskAutoRetry | null | undefined): TaskAutoRetryView | null {
  if (!isAutoRetryOptedIn(autoRetry)) return null;
  return {
    maxAttempts: autoRetry.maxAttempts,
    retries: autoRetry.retries,
    pendingAt: autoRetry.notBefore,
    notice: autoRetry.notice,
  };
}

/** The `autoRetry` a Task starts with: nothing used yet. */
export function newTaskAutoRetry(maxAttempts: number, inherited = 0): TaskAutoRetry {
  return { maxAttempts, retries: 0, inherited, notBefore: null, lastCause: null, notice: null };
}

/** The record of a Task that did not opt in but whose lineage used `used` retries: one attempt, so no retry ever fits. */
export function lineageOnlyAutoRetry(used: number): TaskAutoRetry {
  return { ...newTaskAutoRetry(1, used), optedIn: false };
}

export function isValidAutoRetryMaxAttempts(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= AUTO_RETRY_MAX_ATTEMPTS;
}

/** A ceiling as the instance setting holds it: a whole number from 1 to 3. */
export function isValidAutoRetryCeiling(v: unknown): v is number {
  return isValidAutoRetryMaxAttempts(v);
}

/**
 * The attempts a Task gets: what it asked for, at most the instance ceiling (guard 1). `clamped` says the request was lowered,
 * so the response can tell the caller.
 */
export function clampAutoRetryMaxAttempts(requested: number, ceiling: number): { maxAttempts: number; clamped: boolean } {
  const cap = Math.min(ceiling, AUTO_RETRY_MAX_ATTEMPTS);
  return requested > cap ? { maxAttempts: cap, clamped: true } : { maxAttempts: requested, clamped: false };
}

/** The failure signature of an attempt (guard 3): the exit code and the last line it wrote. */
export function autoRetryCauseSignature(exitCode: number | null, lastLine: string | null | undefined): string {
  return `${exitCode ?? "unknown"}|${(lastLine ?? "").trim()}`;
}

/** Whether an attempt showed progress (guard 2): a new comment, a new result-folder file, or a long run. */
export function attemptShowedProgress(f: { newComments: number; newFiles: number; runMs: number }): boolean {
  return f.newComments > 0 || f.newFiles > 0 || f.runMs >= AUTO_RETRY_PROGRESS_RUN_MS;
}

export type AutoRetryDecisionInput = {
  /** The instance kill switch (guard 7). */
  enabled: boolean;
  /** The instance ceiling, 1 to 3 (guard 1). */
  ceiling: number;
  /** The circuit breaker tripped for the Task's Core (guard 5). */
  corePaused: boolean;
  /** The Task's `autoRetry`; null = not opted in. */
  autoRetry: TaskAutoRetry | null;
  /** The Task's attempt count, the attempt that just ended included. */
  attemptCount: number;
  /** How long the ended attempt's Session ran. */
  runMs: number;
  /** The attempt showed progress ({@link attemptShowedProgress}). */
  progress: boolean;
  /** The ended attempt's failure signature ({@link autoRetryCauseSignature}). */
  cause: string;
  /** Its exit code, for the messages. */
  exitCode: number | null;
};

export type AutoRetryStopReason =
  | "disabled"
  | "core-paused"
  | "not-opted-in"
  | "too-short"
  | "cap"
  | "no-progress"
  | "same-cause";

export type AutoRetryDecision =
  /** `n` is the attempt that starts, `max` the attempts the Task may have, `delayMs` the back-off before it. */
  | { kind: "retry"; n: number; max: number; delayMs: number }
  /** `message`: what the Task's give-up says (null = a plain failure, nothing to add). */
  | { kind: "stop"; reason: AutoRetryStopReason; message: string | null };

/** The attempts a Task may have in all: its request, at most the ceiling. */
export function effectiveMaxAttempts(autoRetry: Pick<TaskAutoRetry, "maxAttempts">, ceiling: number): number {
  return Math.min(autoRetry.maxAttempts, ceiling, AUTO_RETRY_MAX_ATTEMPTS);
}

/** The back-off before an auto-retry, by the retries the Task already used: 1, 5, then 15 minutes. */
export function autoRetryBackoffMs(retriesUsed: number): number {
  const i = Math.max(0, Math.min(retriesUsed, AUTO_RETRY_BACKOFF_MS.length - 1));
  return AUTO_RETRY_BACKOFF_MS[i]!;
}

/**
 * Whether the attempt that ended without a result is tried again. The checks run in this order and the first that
 * fails stops it: kill switch, paused Core, no opt-in, shorter than 2 minutes, attempt cap and lineage cap, no progress,
 * the same cause twice. Only the stops of a Task that opted in carry a message.
 */
export function decideAutoRetry(input: AutoRetryDecisionInput): AutoRetryDecision {
  const { autoRetry } = input;
  const silent = (reason: AutoRetryStopReason): AutoRetryDecision => ({ kind: "stop", reason, message: null });
  if (!input.enabled) return silent("disabled");
  if (input.corePaused) {
    return {
      kind: "stop",
      reason: "core-paused",
      message: autoRetry ? "Auto-retry is paused on this Core until an operator resumes it" : null,
    };
  }
  if (!autoRetry) return silent("not-opted-in");
  if (input.runMs < AUTO_RETRY_MIN_RUN_MS) return silent("too-short");
  const max = effectiveMaxAttempts(autoRetry, input.ceiling);
  if (input.attemptCount >= max || autoRetry.inherited + autoRetry.retries >= input.ceiling - 1) {
    return {
      kind: "stop",
      reason: "cap",
      message: `Auto-retry stopped: ${input.attemptCount} of ${max} attempts used`,
    };
  }
  if (!input.progress) {
    return { kind: "stop", reason: "no-progress", message: `Auto-retry stopped: no progress in attempt ${input.attemptCount}` };
  }
  if (autoRetry.lastCause !== null && autoRetry.lastCause === input.cause) {
    return {
      kind: "stop",
      reason: "same-cause",
      message: `Auto-retry stopped: the same exit twice (code ${input.exitCode ?? "unknown"})`,
    };
  }
  return { kind: "retry", n: input.attemptCount + 1, max, delayMs: autoRetryBackoffMs(autoRetry.retries) };
}

/** The system comment of an auto-retry. */
export function formatAutoRetryComment(f: { n: number; max: number; exitCode: number | null }): string {
  return `Auto-retry ${f.n}/${f.max}: previous Session exited (code ${f.exitCode ?? "unknown"}) without a result`;
}

/** The waiting reason of an `assigned` Task whose auto-retry back-off runs (the dispatcher writes it, no comment). */
export function formatAutoRetryWaiting(notBefore: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((notBefore - now) / 60_000));
  return `waiting: auto-retry in ${minutes} min`;
}

/** The line a retried attempt's prompt adds after the attempt line. */
export function formatAutoRetryPromptLine(exitCode: number | null): string {
  return `The previous attempt's Session exited with code ${exitCode ?? "unknown"} without a result. Read your state file or the comments before repeating any step.`;
}

/** The exit code inside a {@link autoRetryCauseSignature}; null for `unknown` or a signature that is not one. */
export function exitCodeOfCause(cause: string | null | undefined): number | null {
  const head = cause?.split("|")[0] ?? "";
  return /^-?\d+$/.test(head) ? Number(head) : null;
}

export function formatAutoRetryCircuitComment(coreId: string): string {
  return `Auto-retry is paused on Core ${coreId}: ${AUTO_RETRY_BREAKER_COUNT} auto-retries within ${AUTO_RETRY_BREAKER_WINDOW_MS / 60_000} minutes. An operator resumes it in the settings`;
}
