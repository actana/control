import type { TaskSessionState } from "~/shared/tasks";

/** The Session states a Task shows a badge for (#954). `working` and `exited` are the normal course of a run and show nothing. */
const BADGES: Partial<Record<TaskSessionState, { label: string; color: string }>> = {
  "needs-input": { label: "Needs input", color: "var(--status-needs, var(--warning))" },
  interrupted: { label: "Interrupted", color: "var(--error)" },
  "idle-no-result": { label: "Idle without result", color: "var(--warning)" },
};

/** The badge for a Task's Session state, or null when there is nothing to show (`working`, `exited`, no attempt). */
export function sessionStateBadge(state: TaskSessionState | null): { label: string; color: string } | null {
  return state ? (BADGES[state] ?? null) : null;
}

/** Whether the Operator has to look at a Task: the board's "Needs attention" chip keeps exactly these. */
export function needsAttention(state: TaskSessionState | null): boolean {
  return sessionStateBadge(state) !== null;
}
