import { Icon } from "~/components/ui/Icon";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { TASK_STATUS_LABEL } from "~/lib/task-board";
import type { TaskCardDrag } from "~/lib/use-board-drag";
import { FINISHED_TASK_STATUSES } from "~/shared/tasks";
import type { TaskDto } from "~/shared/task-wire";

const STATUS_COLOR: Record<TaskDto["status"], string> = {
  draft: "var(--text-dim)",
  assigned: "var(--brand-accent)",
  in_progress: "var(--warning)",
  done: "var(--text-success)",
  partial: "var(--warning)",
  failed: "var(--error)",
};

/** One Task on the board (screen 06): title, a status line, and when it last changed. */
export function TaskCard({
  task,
  coreLabel,
  agentLabel,
  onOpen,
  onReply,
  drag,
}: {
  task: TaskDto;
  coreLabel: string | null;
  agentLabel: string | null;
  onOpen: (id: string) => void;
  /** A finished Task offers Reply, which opens it on the composer. */
  onReply?: (id: string) => void;
  /** On the board the card can be dragged to another column (#827); Space then picks it up. */
  drag?: TaskCardDrag;
}) {
  const finished = (FINISHED_TASK_STATUSES as readonly string[]).includes(task.status);
  const detail =
    task.status === "draft" && !task.agent
      ? "draft · no Agent yet"
      : [
          TASK_STATUS_LABEL[task.status].toLowerCase(),
          task.status === "in_progress" ? `attempt ${task.attemptCount}` : null,
          coreLabel,
          agentLabel,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <div
      role="button"
      tabIndex={0}
      data-task-card={task.id}
      aria-label={`Open task ${task.title}`}
      aria-roledescription={drag ? "draggable Task" : undefined}
      aria-describedby={drag?.describedBy}
      onClick={() => {
        // The click a drag ends with is not a request to open the Task.
        if (drag?.consumeClick()) return;
        onOpen(task.id);
      }}
      onPointerDown={drag?.onPointerDown}
      onBlur={drag?.onBlur}
      onKeyDown={(e) => {
        // A key on the Reply button inside is the button's, not the card's.
        if (e.target !== e.currentTarget) return;
        if (drag?.onKeyDown(e)) return;
        // Enter opens it; so does Space, when Space is not the drag's.
        if (e.key === "Enter" || (e.key === " " && !drag)) {
          e.preventDefault();
          onOpen(task.id);
        }
      }}
      style={{
        position: "relative",
        display: "flex",
        gap: 12,
        padding: 12,
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--surface-card)",
        cursor: drag?.lifted ? "grabbing" : "pointer",
        minWidth: 0,
        // The carried card stays in its slot, faded, while its ghost follows the pointer.
        opacity: drag?.lifted ? 0.4 : undefined,
        // A long press lifts the card, so it must not select text or open the
        // iOS callout. No touch-action: none, so a swipe across it still scrolls.
        userSelect: drag ? "none" : undefined,
        WebkitUserSelect: drag ? "none" : undefined,
        WebkitTouchCallout: drag ? "none" : undefined,
      }}
    >
      <span
        aria-hidden
        style={{ position: "absolute", top: 8, left: 8, width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[task.status] }}
      />
      <div style={{ width: 40, height: 40, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: 8, border: "1px solid var(--border)" }}>
        <Icon name="terminal" size={16} />
      </div>
      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {detail}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>
          <span>{formatRelativeTime(task.updatedAt)}</span>
          {finished && onReply ? (
            <button
              type="button"
              className="mc-btn mc-btn-frame mc-btn-sm"
              aria-label={`Reply to ${task.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onReply(task.id);
              }}
            >
              Reply
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
