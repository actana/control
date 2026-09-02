import { describe, expect, it, vi } from "vitest";
import type { Task } from "~/db/schema";
import {
  archivedSessionsEligibleForReap,
  commandForTask,
  nextActiveByProject,
  resolveActiveTaskIdForProject,
  type OpenTerminal,
} from "../terminal-store";

vi.mock("../api", () => ({
  api: {
    updateTask: vi.fn().mockResolvedValue(undefined),
  },
}));

const baseTask = {
  id: "task-1",
  projectId: "project-1",
  title: "Task",
  titleManuallySet: false,
  icon: null,
  status: "ready",
  branch: "main",
  preview: "",
  lines: 0,
  archived: false,
  pinned: false,
  claudeSessionId: null,
  claudeSkipPermissions: false,
  claudeBareSession: false,
  createdAt: 1,
  updatedAt: 1,
} satisfies Omit<Task, "agent">;

describe("commandForTask", () => {
  it("starts a new Claude conversation when a ready task already has a session id", () => {
    const task = {
      ...baseTask,
      agent: "claude-code",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
    } satisfies Task;

    expect(commandForTask(task)).toBe(
      "claude --session-id 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions",
    );
  });

  it("resumes Claude conversations after the first launch", () => {
    const task = {
      ...baseTask,
      agent: "claude-code",
      status: "running",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
    } satisfies Task;

    expect(commandForTask(task)).toBe(
      "claude --resume 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions",
    );
  });

  it("passes remembered permission-bypass mode to Cursor CLI", () => {
    const task = {
      ...baseTask,
      agent: "cursor-cli",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
      claudeSkipPermissions: true,
    } satisfies Task;

    expect(commandForTask(task)).toBe(
      "cursor-agent --resume 00000000-0000-4000-8000-000000000000 --force",
    );
  });

  it("starts OpenCode without a session id until one is captured", () => {
    const task = {
      ...baseTask,
      agent: "opencode",
      claudeSessionId: null,
    } satisfies Task;

    expect(commandForTask(task)).toBe("opencode");
  });

  it("resumes OpenCode after a ses_* session id is captured", () => {
    const task = {
      ...baseTask,
      agent: "opencode",
      status: "running",
      claudeSessionId: "ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
    } satisfies Task;

    expect(commandForTask(task)).toBe(
      "opencode --session ses_3cf7dd8d4ffeUPfENpVxfFojZ2",
    );
  });

  it("does not pass legacy UUID session ids to OpenCode", () => {
    const task = {
      ...baseTask,
      agent: "opencode",
      claudeSessionId: "00000000-0000-4000-8000-000000000000",
    } satisfies Task;

    expect(commandForTask(task)).toBe("opencode");
  });

  it("starts Codex with hooks until a session id is captured", () => {
    const task = {
      ...baseTask,
      agent: "codex",
      claudeSessionId: null,
      status: "ready",
    } satisfies Task;

    expect(commandForTask(task)).toBe("codex --enable hooks --yolo");
  });

  it("resumes Codex after the first prompt captured a session id", () => {
    const task = {
      ...baseTask,
      agent: "codex",
      status: "running",
      claudeSessionId: "019d7a0f-432a-7fa1-a821-b7841f983967",
    } satisfies Task;

    expect(commandForTask(task)).toBe(
      "codex resume 019d7a0f-432a-7fa1-a821-b7841f983967 --enable hooks --yolo",
    );
  });
});

describe("nextActiveByProject", () => {
  const scope = "project-1";

  it("selects a task in a scope that had none", () => {
    expect(nextActiveByProject({}, scope, "task-1")).toEqual({ [scope]: "task-1" });
  });

  it("switches active tasks", () => {
    expect(nextActiveByProject({ [scope]: "task-1" }, scope, "task-2")).toEqual({
      [scope]: "task-2",
    });
  });

  // Selection is navigation, not a toggle: a repeat request for the
  // already-active task leaves it selected. The old `nextActiveTaskId` returned
  // null here whenever a session was materialized, and a null scope is the panel
  // close. Materialization is no longer an input to the decision at all.
  it("keeps the task active when it is requested again", () => {
    expect(nextActiveByProject({ [scope]: "task-1" }, scope, "task-1")).toEqual({
      [scope]: "task-1",
    });
  });

  it("returns the same map object for a repeat request so no re-render is forced", () => {
    const prev = { [scope]: "task-1" };
    expect(nextActiveByProject(prev, scope, "task-1")).toBe(prev);
  });

  // A rapid burst follows the last request and never passes through a null
  // (panel-closing) selection. Seeded on A and requesting A first, so this is a
  // repeat-A -> B -> A: a superset of the plain A -> B -> A burst.
  it("follows the last request across a rapid repeat-A -> B -> A burst", () => {
    const seen: (string | null)[] = [];
    let state: Record<string, string | null> = { [scope]: "task-a" };
    for (const requested of ["task-a", "task-b", "task-a"]) {
      state = nextActiveByProject(state, scope, requested);
      seen.push(state[scope] ?? null);
    }
    expect(seen).toEqual(["task-a", "task-b", "task-a"]);
    expect(seen).not.toContain(null);
    expect(state[scope]).toBe("task-a");
  });

  it("leaves other scopes untouched", () => {
    expect(
      nextActiveByProject({ "project-2": "task-9" }, scope, "task-1"),
    ).toEqual({ "project-2": "task-9", [scope]: "task-1" });
  });
});

describe("resolveActiveTaskIdForProject", () => {
  it("prefers the currently visible scope for root panel lookups", () => {
    expect(
      resolveActiveTaskIdForProject(
        {
          "project-1:main": "main-task",
          "project-1:scope-a": "scoped-task",
        },
        "project-1",
        { "project-1": "project-1:scope-a" },
      ),
    ).toEqual({ scopeKey: "project-1:scope-a", taskId: "scoped-task" });
  });

  it("does not fall back to another scope when the visible scope has no active task", () => {
    expect(
      resolveActiveTaskIdForProject(
        {
          "project-1:main": "main-task",
          "project-1:scope-a": "scoped-task",
        },
        "project-1",
        { "project-1": "project-1:scope-b" },
      ),
    ).toEqual({ scopeKey: "project-1:scope-b", taskId: null });
  });

  it("uses exact scoped ids without cross-scope fallback", () => {
    expect(
      resolveActiveTaskIdForProject(
        {
          "project-1:main": "main-task",
          "project-1:scope-a": "scoped-task",
        },
        "project-1:scope-b",
      ),
    ).toEqual({ scopeKey: "project-1:scope-b", taskId: null });
  });

  it("maps legacy plain project active ids to the main scope key", () => {
    expect(
      resolveActiveTaskIdForProject({ "project-1": "legacy-task" }, "project-1"),
    ).toEqual({ scopeKey: "project-1:main", taskId: "legacy-task" });
  });
});

describe("archivedSessionsEligibleForReap", () => {
  const openTerminal = (opts: {
    taskId: string;
    projectId?: string;
    archived: boolean;
  }): OpenTerminal => ({
    taskId: opts.taskId,
    ptyId: null,
    startCommand: "",
    dangerouslySkipPermissions: false,
    cwd: "/tmp",
    project: {
      id: opts.projectId ?? "project-1",
    } as unknown as OpenTerminal["project"],
    task: { id: opts.taskId, archived: opts.archived } as OpenTerminal["task"],
  });

  it("reaps an archived session that is not the active selection", () => {
    const sessions = [openTerminal({ taskId: "a", archived: true })];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": null })).toEqual([
      "a",
    ]);
  });

  it("keeps an archived session alive while it is the active selection", () => {
    const sessions = [openTerminal({ taskId: "a", archived: true })];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": "a" })).toEqual([]);
  });

  it("never reaps a non-archived session even when it is unselected", () => {
    const sessions = [openTerminal({ taskId: "a", archived: false })];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": null })).toEqual([]);
  });

  it("returns only the unselected archived sessions", () => {
    const sessions = [
      openTerminal({ taskId: "a", archived: true }),
      openTerminal({ taskId: "b", archived: true }),
      openTerminal({ taskId: "c", archived: false }),
    ];
    expect(archivedSessionsEligibleForReap(sessions, { "project-1:main": "b" })).toEqual([
      "a",
    ]);
  });
});
