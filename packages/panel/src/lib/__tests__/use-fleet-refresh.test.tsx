// @vitest-environment jsdom
//
// The Fleet fan-out and the finish that lands while it is in flight (#389).
//
// The hook used to return early whenever a refresh was already running, so a
// `session:finished` arriving mid-fan-out was dropped: the answers already in
// flight predate the finish, nothing re-read them, and the row stayed running
// until the 15s poll. These tests hold a fan-out open on purpose, land the
// finish inside that window, and then count the reads.
//
// Nothing here advances a timer. `FLEET_POLL_MS` and `CORES_POLL_MS` are both
// 15s and each test finishes in milliseconds, so every read a test observes is
// an event-driven one — which is exactly the claim under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import { mergeFleetTasks } from "~/shared/fleet-merge";

const CORE_ID = "core-a";
const PROJECT_ID = "project-1";

const h = vi.hoisted(() => ({
  /** Every `onEvent` subscriber currently mounted. */
  eventHandlers: new Set<(msg: { coreId: string; event: { kind: string } }) => void>(),
  /** One entry per in-flight `listTasks`, oldest first. */
  inFlight: [] as { settle: () => void }[],
  listTasksCalls: 0,
  listProjectsCalls: 0,
  /** What the Core would answer *right now*. Mutated by the tests. */
  tasks: [] as CoreLinkTaskSnapshot[],
  pinned: true,
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
          dial: { coreId: CORE_ID, state: "connected", lastSeenAt: 1_000 },
        },
      ],
    }),
    listProjectPresentation: async () => ({ presentation: [] }),
  },
}));

// One bridge object for the whole suite, exactly as `getPanelBridge` memoizes
// the real one: the hooks key their effects on its identity.
const bridge = {
  isConnected: () => true,
  watchCore: () => () => {},
  onEvent: (cb: (msg: { coreId: string; event: { kind: string } }) => void) => {
    h.eventHandlers.add(cb);
    return () => h.eventHandlers.delete(cb);
  },
  onDialStatus: () => () => {},
  onConnectionChange: () => () => {},
  listProjects: async () => {
    h.listProjectsCalls++;
    return [
      {
        projectId: PROJECT_ID,
        name: "Control",
        path: "/srv/control",
        icon: "CO",
        iconColor: "#888888",
        pinned: h.pinned,
        rememberHarnessSettings: false,
        savedHarness: null,
        savedSkipPermissions: false,
        savedBareSession: false,
        defaultGridView: false,
        updatedAt: 1_000,
      },
    ];
  },
  // Held open until the test says so: the whole bug lives in this window.
  listTasks: () => {
    h.listTasksCalls++;
    const snapshot = () => ({ tasks: [...h.tasks], archivedCount: 0 });
    return new Promise<{ tasks: CoreLinkTaskSnapshot[]; archivedCount: number }>((resolve) => {
      h.inFlight.push({ settle: () => resolve(snapshot()) });
    });
  },
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));

const { useFleetTasks, useRemotePinnedProjects } = await import("~/lib/use-fleet");
const { fleetProjectKey, taskCountsByFleetProject } = await import("~/shared/projects");

/** Let the oldest held `listTasks` answer, with the Core's current rows. */
async function settleOldestRead(): Promise<void> {
  const call = h.inFlight.shift();
  if (!call) throw new Error("no listTasks in flight");
  await act(async () => {
    call.settle();
    // Two turns: the fan-out's `Promise.all`, then the state it sets.
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A Core event, as the panel link delivers it. */
async function emit(kind: string): Promise<void> {
  await act(async () => {
    for (const cb of [...h.eventHandlers]) cb({ coreId: CORE_ID, event: { kind } });
    await Promise.resolve();
  });
}

/** Wait until the fan-out the hook starts on mount is the one in flight. */
async function waitForRead(n: number): Promise<void> {
  await waitFor(() => expect(h.listTasksCalls).toBeGreaterThanOrEqual(n));
}

beforeEach(() => {
  h.eventHandlers.clear();
  h.inFlight = [];
  h.listTasksCalls = 0;
  h.listProjectsCalls = 0;
  h.tasks = [task("task-1", "running")];
  h.pinned = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFleetTasks — a finish that lands during an in-flight refresh", () => {
  it("shows the finish after that refresh, without waiting for the 15s poll", async () => {
    const { result } = renderHook(() => useFleetTasks());

    // First fan-out: the Session is running.
    await waitForRead(1);
    await settleOldestRead();
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(1));
    expect(result.current.fleet.rows[0]?.status).toBe("running");

    // A task event opens a second fan-out and we hold it open.
    await emit("task:updated");
    await waitForRead(2);

    // The Session finishes *inside* that window. The read already in flight
    // was launched before it, so its answer cannot carry the finish.
    h.tasks = [task("task-1", "finished")];
    await emit("session:finished");

    // The stale answer lands first — this is the state the old code settled on.
    await settleOldestRead();

    // ...and the dropped event has to have re-armed the fan-out.
    await waitFor(() => expect(h.listTasksCalls).toBe(3));
    await settleOldestRead();

    await waitFor(() => expect(result.current.fleet.rows[0]?.status).toBe("finished"));
    // Three reads: mount, the event, and the trailing re-run. No poll tick.
    expect(h.listTasksCalls).toBe(3);
  });

  it("re-runs exactly once for a burst of events landing in one refresh", async () => {
    const { result } = renderHook(() => useFleetTasks());

    await waitForRead(1);
    await settleOldestRead();
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(1));

    await emit("task:updated");
    await waitForRead(2);

    // Six more events while that one read is in flight — a burst, not six
    // refreshes. Coalescing them is the other half of the fix.
    h.tasks = [task("task-1", "finished")];
    for (const kind of [
      "task:updated",
      "task:updated",
      "session:finished",
      "pty:exited",
      "task:updated",
      "session:finished",
    ]) {
      await emit(kind);
    }
    expect(h.listTasksCalls).toBe(2);

    await settleOldestRead();
    await waitFor(() => expect(h.listTasksCalls).toBe(3));
    await settleOldestRead();
    await waitFor(() => expect(result.current.fleet.rows[0]?.status).toBe("finished"));

    // One trailing pass for the whole burst, and nothing behind it.
    expect(h.listTasksCalls).toBe(3);
    expect(h.inFlight).toHaveLength(0);
  });

  it("settles after the trailing pass instead of re-reading forever", async () => {
    const { result } = renderHook(() => useFleetTasks());

    await waitForRead(1);
    await settleOldestRead();
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(1));

    await emit("task:updated");
    await waitForRead(2);
    await emit("session:finished");
    await settleOldestRead();

    // The trailing pass runs and then stops. A coalescing loop that cleared
    // its flag *after* the read instead of before would keep re-reading here.
    await waitFor(() => expect(h.listTasksCalls).toBe(3));
    await settleOldestRead();
    expect(h.listTasksCalls).toBe(3);
  });
});

describe("useRemotePinnedProjects — pin activity dots", () => {
  it("counts a pinned project from the same settled fan-out the row came from", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());

    await waitForRead(1);
    await settleOldestRead();
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    // Running work lights the dot: the counts are the fan-out's, not zeroes.
    await waitFor(() => expect(result.current.projects[0]?.taskCounts.running).toBe(1));
    expect(result.current.projects[0]?.taskCounts.activeNonDone).toBe(1);

    // The same mid-refresh finish, seen from the rail.
    await emit("task:updated");
    await waitForRead(2);
    h.tasks = [task("task-1", "finished")];
    await emit("session:finished");
    await settleOldestRead();
    await waitFor(() => expect(h.listTasksCalls).toBe(3));
    await settleOldestRead();

    await waitFor(() => expect(result.current.projects[0]?.taskCounts.finished).toBe(1));
    const counts = result.current.projects[0]!.taskCounts;
    expect(counts.running).toBe(0);
    expect(counts.activeNonDone).toBe(0);
    expect(counts.total).toBe(1);
  });
});

describe("taskCountsByFleetProject", () => {
  it("tallies exactly the rows mergeFleetTasks settled on", () => {
    const rows = mergeFleetTasks([
      {
        coreId: CORE_ID,
        coreLabel: "Warehouse VM",
        ok: true,
        lastSeenAt: 1_000,
        tasks: [
          task("task-1", "finished"),
          task("task-2", "running"),
          task("task-3", "needs-input"),
          { ...task("task-4", "running"), archived: true },
        ],
      },
    ]).rows;

    const counts = taskCountsByFleetProject(rows);
    const forProject = counts.get(fleetProjectKey(CORE_ID, PROJECT_ID));

    // The archived row is not in `rows`, so it is not in the counts either.
    expect(forProject?.total).toBe(rows.length);
    expect(forProject?.finished).toBe(1);
    expect(forProject?.running).toBe(1);
    expect(forProject?.["needs-input"]).toBe(1);
    expect(forProject?.activeNonDone).toBe(2);
  });

  it("keys by Core so two Cores sharing a project id do not merge", () => {
    const counts = taskCountsByFleetProject([
      { coreId: "core-a", projectId: PROJECT_ID, status: "running" },
      { coreId: "core-b", projectId: PROJECT_ID, status: "running" },
    ]);
    expect(counts.get(fleetProjectKey("core-a", PROJECT_ID))?.running).toBe(1);
    expect(counts.get(fleetProjectKey("core-b", PROJECT_ID))?.running).toBe(1);
  });
});
