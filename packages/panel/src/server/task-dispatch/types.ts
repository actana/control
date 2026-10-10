import type { Harness } from "~/shared/agents";
import type { TaskSessionStopOutcome } from "~/shared/task-wire";

/** A Session the dispatcher started on a Core: its id, and a way to hear it end. */
export type StartedSession = {
  sessionId: string;
  /** The harness's process exited. Fires once. */
  onExit(cb: (exit: { exitCode: number }) => void): void;
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

/** What happened when a Session was asked to stop (#723). */
export type SessionStopResult = { outcome: TaskSessionStopOutcome; detail: string | null };

/** How a Session is stopped on its Core. Never throws: every failure is an outcome. */
export type SessionStopper = (target: { coreId: string; sessionId: string }) => Promise<SessionStopResult>;

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
