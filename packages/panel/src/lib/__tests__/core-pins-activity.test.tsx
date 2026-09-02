// @vitest-environment jsdom
//
// The rail's activity dots for a Core-owned pin (#377).
//
// A pin row's `taskCounts` is what `ProjectBar` draws its dots from, and for a
// Core-owned project it used to be zero whatever the Core was doing. These
// tests drive `useRemotePinnedProjects` against a fake Core and check the three
// things that matter: a running Session lights the count, a finish clears it on
// the event rather than on a reload, and a Core the tab cannot reach keeps the
// counts it last had instead of going dark — a dark dot is a claim, and it
// would be the wrong one.
//
// They also hold the engine to its other promise: the hook is mounted two or
// three times at once, and one event must still cost one fan-out.
//
// Nothing here advances a timer. The poll is 15s and each test finishes in
// milliseconds, so every read observed is a mount- or event-driven one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import { getPinnedProjectStatusDots } from "~/components/views/project-bar-status-dots";

const CORE_ID = "core-a";
const PROJECT_ID = "project-1";

const h = vi.hoisted(() => ({
  eventHandlers: new Set<(msg: { coreId: string; event: { kind: string } }) => void>(),
  dialHandlers: new Set<(status: unknown) => void>(),
  listTasksCalls: 0,
  listProjectsCalls: 0,
  /** What the Core would answer right now. Mutated by the tests. */
  tasks: [] as CoreLinkTaskSnapshot[],
  projects: [] as CoreLinkProjectSnapshot[],
  /** The dial state `listCores` reports. */
  dialState: "connected" as string,
}));

function task(taskId: string, status: string): CoreLinkTaskSnapshot {
  return {
    taskId,
    projectId: PROJECT_ID,
    title: taskId,
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status,
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1_000,
  };
}

function project(projectId: string, pinned = true): CoreLinkProjectSnapshot {
  return {
    projectId,
    name: projectId,
    path: `/srv/${projectId}`,
    icon: "PR",
    iconColor: "#7ce58a",
    pinned,
    rememberHarnessSettings: false,
    savedHarness: null,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    updatedAt: 1_000,
  };
}

vi.mock("~/lib/api", () => ({
  api: {
    listCores: async () => ({
      cores: [
        {
          id: CORE_ID,
          endpoint: "wss://core-a:4100",
          label: "Warehouse VM",
          lastEventId: 0,
          createdAt: 0,
          updatedAt: 0,
          dial: { coreId: CORE_ID, state: h.dialState, lastSeenAt: 1_000 },
        },
      ],
    }),
    listProjectPresentation: async () => ({ presentation: [] }),
  },
}));

const bridge = {
  isConnected: () => true,
  watchCore: () => () => {},
  onEvent: (cb: (msg: { coreId: string; event: { kind: string } }) => void) => {
    h.eventHandlers.add(cb);
    return () => h.eventHandlers.delete(cb);
  },
  onDialStatus: (cb: (status: unknown) => void) => {
    h.dialHandlers.add(cb);
    return () => h.dialHandlers.delete(cb);
  },
  onConnectionChange: () => () => {},
  listProjects: async () => {
    h.listProjectsCalls++;
    return [...h.projects];
  },
  listTasks: async () => {
    h.listTasksCalls++;
    return { tasks: [...h.tasks], archivedCount: 0 };
  },
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));

const { useRemotePinnedProjects } = await import("~/lib/use-fleet");

/** A Core event, as the panel link delivers it. */
async function emit(kind: string): Promise<void> {
  await act(async () => {
    for (const cb of [...h.eventHandlers]) cb({ coreId: CORE_ID, event: { kind } });
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A dial-status push, as the service sends one when a Core's link moves. */
async function dial(state: CoreDialStatus["state"]): Promise<void> {
  h.dialState = state;
  await act(async () => {
    for (const cb of [...h.dialHandlers]) {
      cb({ coreId: CORE_ID, state, lastSeenAt: 1_000 } satisfies CoreDialStatus);
    }
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pinFor(projects: { id: string }[], projectId = PROJECT_ID) {
  return projects.find((p) => p.id === projectId);
}

beforeEach(() => {
  h.eventHandlers.clear();
  h.dialHandlers.clear();
  h.listTasksCalls = 0;
  h.listProjectsCalls = 0;
  h.dialState = "connected";
  h.projects = [project(PROJECT_ID)];
  h.tasks = [task("task-1", "running")];
});

afterEach(() => {
  // The engine is module state refcounted by its subscribers, so every test
  // has to hand its mounts back — the last one leaving is what resets it.
  cleanup();
  vi.restoreAllMocks();
});

describe("useRemotePinnedProjects — a Core-owned pin's activity dots", () => {
  it("lights the matching count while a Core Session is running", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    const pin = pinFor(result.current.projects)!;
    expect(pin.coreId).toBe(CORE_ID);
    expect(pin.taskCounts.running).toBe(1);
    expect(getPinnedProjectStatusDots(pin.taskCounts)).toEqual(["running"]);
  });

  it("clears the dot when the Session finishes, on the event and not a reload", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(pinFor(result.current.projects)?.taskCounts.running).toBe(1));

    // The Core finishes the Session and says so. Nothing remounts, nothing
    // reloads: the event is the whole of the update path.
    h.tasks = [task("task-1", "finished")];
    await emit("session:finished");

    await waitFor(() => expect(pinFor(result.current.projects)?.taskCounts.running).toBe(0));
    const pin = pinFor(result.current.projects)!;
    expect(pin.taskCounts.finished).toBe(1);
    expect(getPinnedProjectStatusDots(pin.taskCounts)).not.toContain("running");
  });

  it("lights a dot the Core reports after the pin was already on screen", async () => {
    h.tasks = [];
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(pinFor(result.current.projects)?.taskCounts.running).toBe(0);

    h.tasks = [task("task-1", "running")];
    await emit("task:statusChanged");

    await waitFor(() => expect(pinFor(result.current.projects)?.taskCounts.running).toBe(1));
  });

  it("keeps an unreachable Core's pins and their last counts rather than zeroing", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(pinFor(result.current.projects)?.taskCounts.running).toBe(1));
    const readsWhileConnected = h.listTasksCalls;

    // The link drops. The Panel has no idea what that Core is running now — and
    // "no dots" would say it is running nothing, which is exactly what it must
    // not claim.
    await dial("unreachable");

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(pinFor(result.current.projects)?.taskCounts.running).toBe(1);
    // And it was not asked: a Core the service cannot reach is not worth a
    // frame the router would only answer with an error.
    expect(h.listTasksCalls).toBe(readsWhileConnected);

    // Back up, and the answer is live again.
    h.tasks = [task("task-1", "finished")];
    await dial("connected");
    await waitFor(() => expect(pinFor(result.current.projects)?.taskCounts.running).toBe(0));
  });

  it("costs one fan-out per event however many rails are mounted", async () => {
    const first = renderHook(() => useRemotePinnedProjects());
    const second = renderHook(() => useRemotePinnedProjects());
    const third = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(first.result.current.projects).toHaveLength(1));
    await waitFor(() => expect(third.result.current.projects).toHaveLength(1));

    const before = { tasks: h.listTasksCalls, projects: h.listProjectsCalls };
    h.tasks = [task("task-1", "finished")];
    await emit("session:finished");
    await waitFor(() =>
      expect(pinFor(second.result.current.projects)?.taskCounts.running).toBe(0),
    );

    // One event, one read of each list — not one per mounted rail.
    expect(h.listTasksCalls - before.tasks).toBe(1);
    expect(h.listProjectsCalls - before.projects).toBe(1);
    // And every mount sees it, because they are all reading one snapshot.
    for (const mount of [first, second, third]) {
      expect(pinFor(mount.result.current.projects)?.taskCounts.running).toBe(0);
    }
  });

  it("refreshes the counts, not just the pins, when the rail asks", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(pinFor(result.current.projects)?.taskCounts.running).toBe(1));

    // A pin toggle refreshes through this. The Core has moved on since the last
    // pass, and the toggled tile must not land carrying the old counts.
    h.projects = [project(PROJECT_ID), project("project-2")];
    h.tasks = [task("task-1", "finished")];
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(pinFor(result.current.projects)?.taskCounts.running).toBe(0);
    expect(pinFor(result.current.projects)?.taskCounts.finished).toBe(1);
  });

  it("counts only the pinned project's own tasks", async () => {
    h.projects = [project(PROJECT_ID), project("project-2")];
    h.tasks = [
      task("task-1", "running"),
      { ...task("task-2", "needs-input"), projectId: "project-2" },
    ];
    const { result } = renderHook(() => useRemotePinnedProjects());

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(pinFor(result.current.projects)?.taskCounts.running).toBe(1);
    expect(pinFor(result.current.projects)?.taskCounts["needs-input"]).toBe(0);
    expect(pinFor(result.current.projects, "project-2")?.taskCounts["needs-input"]).toBe(1);
  });
});
