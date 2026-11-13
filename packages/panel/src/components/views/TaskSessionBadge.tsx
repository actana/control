import { sessionStateBadge } from "~/lib/task-session-state";
import type { TaskSessionState } from "~/shared/tasks";

/**
 * What a Task's Session is waiting on (#954): Needs input, Interrupted or Idle without result. Nothing for
 * `working`, `exited` or no attempt. One element, so the card and the detail stay as they were without it.
 */
export function TaskSessionBadge({ state, title }: { state: TaskSessionState | null; title?: string }) {
  const badge = sessionStateBadge(state);
  if (!badge) return null;
  return (
    <span
      data-session-state={state}
      title={title}
      style={{
        display: "inline-block",
        flexShrink: 0,
        marginLeft: 8,
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 11,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: badge.color,
        border: `1px solid ${badge.color}`,
        verticalAlign: "baseline",
      }}
    >
      {badge.label}
    </span>
  );
}
