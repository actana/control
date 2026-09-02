import { describe, expect, it, vi } from "vitest";
import { openClickedSession } from "../open-clicked-session";
import type { Task } from "~/db/schema";
import type { ScopedProject } from "~/lib/scoped-project";

const project = { id: "p1", path: "/work" } as ScopedProject;

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, projectId: "p1", status: "ready", archived: false, ...over } as Task;
}

function openerStub() {
  return { openSession: vi.fn(), focusGridSession: vi.fn() };
}

describe("openClickedSession", () => {
  it("opens an archived Core row, which lives outside the active task list", () => {
    const terminals = openerStub();
    const archived = task("t-archived", { archived: true });

    const opened = openClickedSession("t-archived", {
      tasks: [task("t-active")],
      archivedTasks: [archived],
      project,
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(true);
    expect(terminals.openSession).toHaveBeenCalledWith(project, archived, { coreId: "core-a" });
    expect(terminals.focusGridSession).toHaveBeenCalledWith("t-archived");
  });

  it("still opens an active row out of the task list, unchanged", () => {
    const terminals = openerStub();
    const active = task("t-active");

    const opened = openClickedSession("t-active", {
      tasks: [active],
      archivedTasks: [task("t-archived", { archived: true })],
      project,
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(true);
    expect(terminals.openSession).toHaveBeenCalledWith(project, active, { coreId: "core-a" });
    expect(terminals.focusGridSession).toHaveBeenCalledWith("t-active");
  });

  it("prefers the active row when both lists carry the id (Panel-owned project)", () => {
    const terminals = openerStub();
    const fromTasks = task("t1", { archived: true });
    const fromArchived = task("t1", { archived: true });

    openClickedSession("t1", {
      tasks: [fromTasks],
      archivedTasks: [fromArchived],
      project,
      coreId: null,
      terminals,
    });

    expect(terminals.openSession).toHaveBeenCalledWith(project, fromTasks, { coreId: null });
  });

  it("opens nothing for an id in neither list", () => {
    const terminals = openerStub();

    const opened = openClickedSession("gone", {
      tasks: [task("t-active")],
      archivedTasks: [task("t-archived", { archived: true })],
      project,
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(false);
    expect(terminals.openSession).not.toHaveBeenCalled();
    expect(terminals.focusGridSession).not.toHaveBeenCalled();
  });

  it("opens nothing before the project path is ready", () => {
    const terminals = openerStub();

    const opened = openClickedSession("t-archived", {
      tasks: [],
      archivedTasks: [task("t-archived", { archived: true })],
      project: null,
      coreId: "core-a",
      terminals,
    });

    expect(opened).toBe(false);
    expect(terminals.openSession).not.toHaveBeenCalled();
  });
});
