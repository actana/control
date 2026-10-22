import { describe, expect, it } from "vitest";
import { acceptsDrop, boardColumnOf, DROP_REASONS, dropDecision, type BoardColumnId, type DropDecision } from "../task-board-drop";
import { BOARD_COLUMNS } from "../task-board";
import { canMoveTask, TASK_STATUSES, type TaskStatus } from "~/shared/tasks";

const COLUMNS: BoardColumnId[] = ["draft", "assigned", "in_progress", "finished"];
const ready = { coreId: "core-a", agent: "agent-a" };
const task = (status: TaskStatus, extra: { coreId?: string | null; agent?: string | null } = {}) => ({ status, ...ready, ...extra });

const R = DROP_REASONS;
const refuse = (reason: string): DropDecision => ({ kind: "refuse", reason });
const noop: DropDecision = { kind: "noop" };

const TABLE: Record<TaskStatus, Record<BoardColumnId, DropDecision>> = {
  draft: { draft: noop, assigned: { kind: "assign", to: "assigned" }, in_progress: refuse(R.onlyPanelStarts), finished: refuse(R.draftNotRun) },
  assigned: { draft: { kind: "draft", to: "draft" }, assigned: noop, in_progress: refuse(R.onlyPanelStarts), finished: refuse(R.assignedNotRun) },
  in_progress: { draft: refuse(R.runningStopFirst), assigned: refuse(R.runningStopFirst), in_progress: noop, finished: refuse(R.resultFilesDecide) },
  done: { draft: refuse(R.finishedNotDraft), assigned: { kind: "reassign", to: "assigned" }, in_progress: refuse(R.onlyPanelStarts), finished: noop },
  partial: { draft: refuse(R.finishedNotDraft), assigned: { kind: "reassign", to: "assigned" }, in_progress: refuse(R.onlyPanelStarts), finished: noop },
  failed: { draft: refuse(R.finishedNotDraft), assigned: { kind: "reassign", to: "assigned" }, in_progress: refuse(R.onlyPanelStarts), finished: noop },
};

describe("dropDecision", () => {
  for (const status of TASK_STATUSES) {
    for (const column of COLUMNS) {
      it(`${status} dropped on ${column}`, () => {
        expect(dropDecision(task(status), column)).toEqual(TABLE[status][column]);
      });
    }
  }

  it("uses the exact reason strings", () => {
    expect(R).toEqual({
      onlyPanelStarts: "Only the Panel starts a Task: drop it on Assigned and the Panel starts it.",
      resultFilesDecide: "A running Task ends when its result files say so. To end it now, use Stop in the Task detail.",
      runningStopFirst: "This Task is running. Stop it first (Stop in the Task detail), then re-assign it.",
      needsCoreAndAgent: "Assign needs a Core and an Agent, and this draft does not have both.",
      draftNotRun: "A draft has not run yet. Drop it on Assigned to start it.",
      assignedNotRun: "This Task has not run yet. Its result files decide when it is finished.",
      finishedNotDraft: "A finished Task cannot go back to draft. Drop it on Assigned to run it again.",
    });
  });

  it("refuses to assign a draft without a Core, without an Agent, or without both", () => {
    const refused = refuse(R.needsCoreAndAgent);
    expect(dropDecision(task("draft", { coreId: null }), "assigned")).toEqual(refused);
    expect(dropDecision(task("draft", { agent: null }), "assigned")).toEqual(refused);
    expect(dropDecision(task("draft", { coreId: null, agent: null }), "assigned")).toEqual(refused);
    expect(dropDecision(task("draft"), "assigned")).toEqual({ kind: "assign", to: "assigned" });
  });

  it("only legal service moves are ever offered", () => {
    for (const status of TASK_STATUSES) {
      for (const column of COLUMNS) {
        const d = dropDecision(task(status), column);
        if (d.kind === "assign" || d.kind === "draft" || d.kind === "reassign") expect(canMoveTask(status, d.to)).toBe(true);
      }
    }
  });

  it("never offers the moves only the Panel or the result files make", () => {
    expect(dropDecision(task("assigned"), "in_progress").kind).toBe("refuse");
    for (const status of ["draft", "done", "failed", "partial"] as const) expect(dropDecision(task(status), "in_progress").kind).toBe("refuse");
    expect(dropDecision(task("in_progress"), "finished").kind).toBe("refuse");
  });
});

describe("boardColumnOf", () => {
  it("agrees with BOARD_COLUMNS", () => {
    for (const col of BOARD_COLUMNS) for (const s of col.statuses) expect(boardColumnOf(s)).toBe(col.id);
    for (const s of TASK_STATUSES) expect(BOARD_COLUMNS.some((c) => c.statuses.includes(s))).toBe(true);
  });
});

describe("acceptsDrop", () => {
  it("is false for noop and refuse, true for the legal moves", () => {
    for (const status of TASK_STATUSES) {
      for (const column of COLUMNS) {
        const kind = TABLE[status][column].kind;
        expect(acceptsDrop(task(status), column)).toBe(kind === "assign" || kind === "draft" || kind === "reassign");
      }
    }
    expect(acceptsDrop(task("draft", { agent: null }), "assigned")).toBe(false);
  });
});

describe("DROP_REASONS", () => {
  it("are sentences", () => {
    for (const reason of Object.values(R)) {
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.endsWith(".")).toBe(true);
    }
  });
});
