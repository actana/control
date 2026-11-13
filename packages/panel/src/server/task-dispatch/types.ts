import type { Harness } from "~/shared/agents";
import type { TaskSessionStopOutcome } from "~/shared/task-wire";

/** A Session the dispatcher started on a Core: its id, and a way to hear it end. */
export type StartedSession = {
  sessionId: string;
  /** The harness's process exited. Fires once. */
  onExit(cb: (exit: { exitCode: number }) => void): void;
  /** The Core reported a new status for the Session (`running`, `needs-input`, `finished`, ...). Fires on every change. */
  onStatus(cb: (status: string) => void): void;
  /** Let go of the listeners this Panel holds on the Session. The Session itself keeps running. */
  dispose(): void;
};

export type StartSessionRequest = {
  coreId: string;
  harness: Harness;
  model: string | null;
  flags: readonly string[];
  title: string;
  prompt: string;
};

/** How a Session is started on a Core. The default goes through the Core's client; a test hands in a fake. */
export type SessionStarter = (request: StartSessionRequest) => Promise<StartedSession>;

/**
 * Why a re-assigned Task's own Session could not be resumed (#955), so a new Session was started instead. `reason` is a
 * phrase that reads after "resume not possible: " (the `New Session ...` dispatch comment of #955 p2 puts it there);
 * `code` is for tests and logs. It is the one seam between the resume path and the fallback.
 */
export type ResumeRefusal = {
  code: "no-earlier-session" | "other-core" | "other-harness" | "session-gone" | "no-session-id" | "no-resume" | "resume-refused" | "exited-at-once" | "send-refused" | "no-answer";
  reason: string;
};

export const RESUME_REFUSALS = {
  noEarlierSession: { code: "no-earlier-session", reason: "no earlier Session is recorded for this Task" },
  otherCore: { code: "other-core", reason: "its Agent now runs on another Core" },
  otherHarness: { code: "other-harness", reason: "its Agent now runs another harness" },
  sessionGone: { code: "session-gone", reason: "the Core no longer has that Session" },
  noSessionId: { code: "no-session-id", reason: "the Session has no harness session id" },
  noResume: { code: "no-resume", reason: "the harness cannot resume that Session" },
  exitedAtOnce: { code: "exited-at-once", reason: "the harness exited at once" },
  sendRefused: { code: "send-refused", reason: "the running Session did not take the message" },
  noAnswer: { code: "no-answer", reason: "the Core did not answer" },
  resumeRefused: (why: string): ResumeRefusal => ({ code: "resume-refused", reason: `the Core refused the resume (${why})` }),
} as const satisfies Record<string, ResumeRefusal | ((why: string) => ResumeRefusal)>;

export type ResumeSessionRequest = {
  coreId: string;
  /** The Session to go back to: its own row, harness session id and transcript. */
  sessionId: string;
  harness: Harness;
  model: string | null;
  flags: readonly string[];
  /** The next message of the Session: the pointer line to the attempt's prompt file. */
  prompt: string;
};

/**
 * What came of an attempt to continue a Task's own Session (#955):
 *  - `resumed`: the harness was reopened in resume mode on the same Session row and the message typed in;
 *  - `sent`: the Session's harness was still live (one live harness per Task), so the message was typed into it;
 *  - `cannot`: nothing was done to the Session (`stillLive`: its harness is running, and did not take the message).
 * A full Core or a link that is gone is not an outcome: it throws, as `SessionStarter` does, and the Task waits.
 */
export type ResumeOutcome =
  | { kind: "resumed" | "sent"; session: StartedSession }
  | { kind: "cannot"; refusal: ResumeRefusal; stillLive?: boolean };

/** How a Task's own Session is continued on its Core. The default goes through the Core's client; a test hands in a fake. */
export type SessionResumer = (request: ResumeSessionRequest) => Promise<ResumeOutcome>;

/** What happened when a Session was asked to stop (#723). */
export type SessionStopResult = { outcome: TaskSessionStopOutcome; detail: string | null };

/** How a Session is stopped on its Core. Never throws: every failure is an outcome. */
export type SessionStopper = (
  target: { coreId: string; sessionId: string },
  /** `takeOver: false` (#962 close_session): a Session someone holds the lock on is left alone and the outcome is `failed` with detail `session-locked`. Default true. */
  opts?: { takeOver?: boolean },
) => Promise<SessionStopResult>;

/** Which of the given Sessions have a live PTY on a Core; `null` means the Core gave no answer (no link, an error, too slow). */
export type SessionLiveness = (coreId: string, sessionIds: readonly string[]) => Promise<ReadonlySet<string> | null>;

/**
 * The Core's reported status of each of the given Sessions (#949). A Session the Core did not list is absent from the
 * map; `null` means the Core gave no answer (no link, an error, too slow), which changes nothing.
 */
export type SessionStatusReader = (coreId: string, sessionIds: readonly string[]) => Promise<ReadonlyMap<string, string> | null>;

export type Clock = () => number;

/** What the dispatcher says to the log. `console` by default; a test collects it. */
export type DispatchLog = {
  info(message: string): void;
  error(message: string): void;
};

export const consoleDispatchLog: DispatchLog = {
  info: (message) => console.log(`[panel] ${message}`),
  error: (message) => console.error(`[panel] ${message}`),
};

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
