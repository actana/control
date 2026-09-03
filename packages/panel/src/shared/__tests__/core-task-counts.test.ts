import { describe, it, expect } from "vitest";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";
import { getPinnedProjectStatusDots } from "~/components/views/project-bar-status-dots";
import {
  coreTaskCountsByProject,
  emptyTaskCounts,
  getProjectActivity,
  projectRowFromSnapshot,
  taskCountsFromCoreTasks,
} from "../projects";

// Issue 377: a Core-owned pin's activity dots never moved, because the row the
// rail renders reported zero of every status no matter what the Core was
// running. These cover the derivation the dots read from — the Core's own
// `tasksList` snapshots, the same frame and the same rows the grid renders —
// and the two things an operator must see: a running Session lighting the
// matching dot, and a finished one clearing it on the next read, with no
// reload in between.

function task(over: Partial<CoreLinkTaskSnapshot> = {}): CoreLinkTaskSnapshot {
  return {
    taskId: "t1",
    projectId: "p1",
    title: "Ship it",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 10,
    ...over,
  };
}

function snapshot(over: Partial<CoreLinkProjectSnapshot> = {}): CoreLinkProjectSnapshot {
  return {
    projectId: "p1",
    name: "Control",
    path: "/srv/control",
    icon: "CT",
    iconColor: "#7ce58a",
    pinned: true,
    rememberHarnessSettings: true,
    savedHarness: "claude-code",
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: true,
    updatedAt: 4200,
    ...over,
  };
}

/** The pinned row as the rail would build it from one read of a Core. */
function pinRow(tasks: readonly CoreLinkTaskSnapshot[]) {
  const counts = coreTaskCountsByProject(tasks);
  return projectRowFromSnapshot(snapshot(), null, counts.get("p1"));
}

describe("taskCountsFromCoreTasks", () => {
  it("counts a Core's rows by status the way the Panel counts its own", () => {
    const counts = taskCountsFromCoreTasks([
      task({ taskId: "t1", status: "running" }),
      task({ taskId: "t2", status: "running" }),
      task({ taskId: "t3", status: "needs-input" }),
      task({ taskId: "t4", status: "finished" }),
    ]);
    expect(counts.running).toBe(2);
    expect(counts["needs-input"]).toBe(1);
    expect(counts.finished).toBe(1);
    expect(counts.total).toBe(4);
    // `finished` is active but done, so it stays out of activeNonDone — the
    // same line the Panel server's own aggregation draws.
    expect(counts.activeNonDone).toBe(3);
  });

  // Archived rows travel in their own list (ADR 0019). A Core that includes
  // one must not leave a dot lit for a Session the operator filed away.
  it("leaves archived rows out of every bucket", () => {
    const counts = taskCountsFromCoreTasks([
      task({ taskId: "t1", status: "running", archived: true }),
      task({ taskId: "t2", status: "ready" }),
    ]);
    expect(counts.running).toBe(0);
    expect(counts.ready).toBe(1);
    expect(counts.total).toBe(1);
  });

  // A Core may name a status this Panel does not render. The row exists, so it
  // counts toward the total, but it lights no dot it cannot be mapped to.
  it("counts a status it does not know toward the total only", () => {
    const counts = taskCountsFromCoreTasks([task({ status: "warp-drive" })]);
    expect(counts.total).toBe(1);
    expect(counts.running).toBe(0);
    expect(counts.activeNonDone).toBe(0);
  });

  it("has every status at zero for a Core with no tasks", () => {
    expect(taskCountsFromCoreTasks([])).toEqual(emptyTaskCounts());
  });
});

describe("coreTaskCountsByProject", () => {
  it("keeps each project's counts to its own rows", () => {
    const byProject = coreTaskCountsByProject([
      task({ taskId: "t1", projectId: "p1", status: "running" }),
      task({ taskId: "t2", projectId: "p2", status: "needs-input" }),
    ]);
    expect(byProject.get("p1")?.running).toBe(1);
    expect(byProject.get("p1")?.["needs-input"]).toBe(0);
    expect(byProject.get("p2")?.["needs-input"]).toBe(1);
    expect(byProject.get("p2")?.running).toBe(0);
  });

  // Absent, not zeroed: a project the Core reported no tasks for is one the
  // caller falls back to `emptyTaskCounts` for.
  it("omits projects the Core reported no tasks for", () => {
    expect(coreTaskCountsByProject([]).get("p1")).toBeUndefined();
  });
});

describe("a Core-owned pin's activity dots", () => {
  it("lights the matching dot while a Core Session is running", () => {
    const row = pinRow([task({ status: "running" })]);
    expect(row.taskCounts.running).toBe(1);
    expect(getPinnedProjectStatusDots(row.taskCounts)).toEqual(["running"]);
    expect(getProjectActivity(row)).toBe("agent-running");
  });

  it("lights one dot per running Session, as the rail draws them", () => {
    const row = pinRow([
      task({ taskId: "t1", status: "running" }),
      task({ taskId: "t2", status: "running" }),
    ]);
    expect(getPinnedProjectStatusDots(row.taskCounts)).toEqual(["running", "running"]);
  });

  // The clearing half of the acceptance: the next read of the same Core — the
  // refetch a `task:statusChanged` event triggers, not a page load — carries
  // the finished row, and the running dot goes out with it.
  it("clears the running dot on the next snapshot after the Session finishes", () => {
    const running = pinRow([task({ status: "running" })]);
    expect(running.taskCounts.running).toBe(1);

    const finished = pinRow([task({ status: "finished" })]);
    expect(finished.taskCounts.running).toBe(0);
    expect(getPinnedProjectStatusDots(finished.taskCounts)).not.toContain("running");
    expect(getProjectActivity(finished)).toBe("offline");
  });

  // Needs-input outranks running in the rail's activity, and it is the state
  // an operator most needs to see from the rail.
  it("reports needs-input over running when a Session is waiting", () => {
    const row = pinRow([
      task({ taskId: "t1", status: "running" }),
      task({ taskId: "t2", status: "needs-input" }),
    ]);
    expect(getProjectActivity(row)).toBe("needs-input");
  });

  // Back-compat: the callers that have not read the Core's tasks still map to
  // zeros rather than to an invented status.
  it("stays at zero for a caller that passes no counts", () => {
    const row = projectRowFromSnapshot(snapshot());
    expect(row.taskCounts).toEqual(emptyTaskCounts());
  });
});
