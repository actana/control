import type { TaskStatus } from "~/shared/tasks";
import type { TaskDto } from "~/shared/task-wire";

/** Same ids as BOARD_COLUMNS[].id in lib/task-board.ts. */
export type BoardColumnId = "draft" | "assigned" | "in_progress" | "finished";

export type DropDecision =
  | { kind: "assign"; to: "assigned" } // draft -> Assigned (the Assign button)
  | { kind: "draft"; to: "draft" } // assigned -> Draft (Back to draft)
  | { kind: "reassign"; to: "assigned" } // done/partial/failed -> Assigned (a new attempt)
  | { kind: "refuse"; reason: string }
  | { kind: "noop" }; // dropped on its own column

type DropTask = Pick<TaskDto, "status" | "coreId" | "agent">;

/** Why a drop is refused; shown as a toast and as the hovered column's reason line. */
export const DROP_REASONS = {
  onlyPanelStarts: "Only the Panel starts a Task: drop it on Assigned and the Panel starts it.",
  resultFilesDecide: "A running Task ends when its result files say so. To end it now, use Stop in the Task detail.",
  runningStopFirst: "This Task is running. Stop it first (Stop in the Task detail), then re-assign it.",
  needsCoreAndAgent: "Assign needs a Core and an Agent, and this draft does not have both.",
  draftNotRun: "A draft has not run yet. Drop it on Assigned to start it.",
  assignedNotRun: "This Task has not run yet. Its result files decide when it is finished.",
  finishedNotDraft: "A finished Task cannot go back to draft. Drop it on Assigned to run it again.",
} as const;

export function boardColumnOf(status: TaskStatus): BoardColumnId {
  if (status === "draft" || status === "assigned" || status === "in_progress") return status;
  return "finished";
}

const refuse = (reason: string): DropDecision => ({ kind: "refuse", reason });

/** What dropping a Task on a column does. Every legal move is `api.setTaskStatus(task.id, decision.to)`. */
export function dropDecision(task: DropTask, target: BoardColumnId): DropDecision {
  const from = boardColumnOf(task.status);
  if (from === target) return { kind: "noop" };
  switch (from) {
    case "draft":
      if (target === "assigned") {
        return task.coreId && task.agent ? { kind: "assign", to: "assigned" } : refuse(DROP_REASONS.needsCoreAndAgent);
      }
      return refuse(target === "in_progress" ? DROP_REASONS.onlyPanelStarts : DROP_REASONS.draftNotRun);
    case "assigned":
      if (target === "draft") return { kind: "draft", to: "draft" };
      return refuse(target === "in_progress" ? DROP_REASONS.onlyPanelStarts : DROP_REASONS.assignedNotRun);
    case "in_progress":
      return refuse(target === "finished" ? DROP_REASONS.resultFilesDecide : DROP_REASONS.runningStopFirst);
    case "finished":
      if (target === "assigned") return { kind: "reassign", to: "assigned" };
      return refuse(target === "draft" ? DROP_REASONS.finishedNotDraft : DROP_REASONS.onlyPanelStarts);
  }
}

/** true for assign/draft/reassign; false for refuse and noop. */
export function acceptsDrop(task: DropTask, target: BoardColumnId): boolean {
  const kind = dropDecision(task, target).kind;
  return kind === "assign" || kind === "draft" || kind === "reassign";
}
