import { describe, expect, it } from "vitest";
import {
  activeSessionWentAway,
  rememberActiveSession,
  type LastActiveSession,
} from "../active-session-memory";
import type { Task } from "~/db/schema";

const SCOPE = "p1";

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, projectId: "p1", status: "ready", archived: false, ...over } as Task;
}

describe("rememberActiveSession", () => {
  it("flags an archived Core row, which lives outside the active task list", () => {
    const remembered = rememberActiveSession("t-archived", SCOPE, {
      tasks: [task("t-live")],
      archivedTasks: [task("t-archived", { archived: true })],
      previous: null,
    });

    expect(remembered).toEqual({ projectId: SCOPE, taskId: "t-archived", archived: true });
  });

  it("flags a Panel-owned archived row, which carries the flag in the task list", () => {
    const remembered = rememberActiveSession("t-archived", SCOPE, {
      tasks: [task("t-live"), task("t-archived", { archived: true })],
      archivedTasks: [],
      previous: null,
    });

    expect(remembered.archived).toBe(true);
  });

  it("leaves a live row unflagged", () => {
    const remembered = rememberActiveSession("t-live", SCOPE, {
      tasks: [task("t-live")],
      archivedTasks: [task("t-archived", { archived: true })],
      previous: null,
    });

    expect(remembered).toEqual({ projectId: SCOPE, taskId: "t-live", archived: false });
  });

  it("keeps the archived verdict when a refetch drops the row from both lists", () => {
    const previous: LastActiveSession = { projectId: SCOPE, taskId: "t-archived", archived: true };

    const remembered = rememberActiveSession("t-archived", SCOPE, {
      tasks: [task("t-live")],
      archivedTasks: [],
      previous,
    });

    expect(remembered.archived).toBe(true);
  });

  it("does not carry an archived verdict across a different id or scope", () => {
    const previous: LastActiveSession = { projectId: SCOPE, taskId: "t-archived", archived: true };

    expect(
      rememberActiveSession("t-live", SCOPE, { tasks: [], archivedTasks: [], previous }).archived,
    ).toBe(false);
    expect(
      rememberActiveSession("t-archived", "p2", { tasks: [], archivedTasks: [], previous }).archived,
    ).toBe(false);
  });
});

describe("activeSessionWentAway", () => {
  it("reads a deselected archived row as a deselect, not a deletion", () => {
    // Closing the panel on an archived Core session used to force-open an
    // unrelated live one, with no coreId, onto a pane that never spawns.
    const previous: LastActiveSession = { projectId: SCOPE, taskId: "t-archived", archived: true };

    expect(activeSessionWentAway(previous, SCOPE, [task("t-live")])).toBe(false);
  });

  it("still reads a live row that left the visible list as a deletion", () => {
    const previous: LastActiveSession = { projectId: SCOPE, taskId: "t-gone", archived: false };

    expect(activeSessionWentAway(previous, SCOPE, [task("t-live")])).toBe(true);
  });

  it("reads a live row still on screen as a deselect", () => {
    const previous: LastActiveSession = { projectId: SCOPE, taskId: "t-live", archived: false };

    expect(activeSessionWentAway(previous, SCOPE, [task("t-live")])).toBe(false);
  });

  it("says nothing about a memory belonging to another scope", () => {
    const previous: LastActiveSession = { projectId: "p2", taskId: "t-gone", archived: false };

    expect(activeSessionWentAway(previous, SCOPE, [task("t-live")])).toBe(false);
  });
});
