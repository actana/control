// @vitest-environment jsdom
//
// Where a Core-owned pin sits on the rail (#382), driven against the real
// engine rather than a mock of it.
//
// The rail is one strip of tiles with two owners on it. A Panel-owned row's
// slot lives in the React Query `projects` cache, and an optimistic reorder has
// somewhere to put it. A Core-owned row lives here, in `core-pins-engine`'s
// module state, and the review of PR #476 found two ways that asymmetry showed
// on screen:
//
//   1. There was no optimistic setter at all. The only mutator was
//      `refreshCorePins`, which runs the whole fan-out — so the tile the
//      operator had just dragged to the top was re-rendered at the bottom the
//      instant the drop settled (its `pinnedOrder` still null, which the
//      comparator reads as last) and stayed there for two HTTP legs plus a
//      `listProjects` and a `listTasks` for every Core.
//   2. A Core that was momentarily off the link kept its pins — deliberately —
//      but kept them with the slot baked in at the last successful read. A
//      reorder wrote the right slot to the database and the next pass put the
//      old one straight back on screen, with no toast, until the Core returned.
//
// These drive `useRemotePinnedProjects` against a fake Core and a mutable
// presentation table, which is exactly the seam both bugs live in.
//
// Nothing here advances a timer: the poll is 15s and every test finishes in
// milliseconds, so each read observed is a mount-, event- or caller-driven one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { CoreLinkProjectSnapshot } from "@actana/sdk/core-link-frames";
import type { CoreDialStatus } from "~/shared/cores";
import type { ProjectPresentation } from "~/db/schema";
import type { ProjectWithCounts } from "~/shared/projects";

const CORE_ID = "core-a";

const h = vi.hoisted(() => ({
  dialHandlers: new Set<(status: unknown) => void>(),
  presentationReads: 0,
  /** The Panel's own presentation table, as the server would answer it. */
  presentation: [] as ProjectPresentation[],
  projects: [] as CoreLinkProjectSnapshot[],
  dialState: "connected" as string,
  /**
   * Holds the NEXT presentation read open, so a test can have a pass genuinely
   * in flight while it does something else. The rows are snapshotted before the
   * wait, which is the point: the held pass answers with the table as it stood
   * when it read, not as it stands when it is let go.
   */
  readGate: null as Promise<void> | null,
  releaseRead: null as (() => void) | null,
  failRead: false,
}));

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

function filed(over: Partial<ProjectPresentation> & { projectId: string }): ProjectPresentation {
  return {
    coreId: CORE_ID,
    imagePath: null,
    groupId: null,
    launchUrl: null,
    pinnedOrder: null,
    updatedAt: 1_000,
    ...over,
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
    listProjectPresentation: async () => {
      h.presentationReads++;
      if (h.failRead) throw new Error("presentation read failed");
      const rows = h.presentation.map((row) => ({ ...row }));
      const gate = h.readGate;
      h.readGate = null;
      if (gate) await gate;
      return { presentation: rows };
    },
  },
}));

const bridge = {
  isConnected: () => true,
  watchCore: () => () => {},
  onEvent: () => () => {},
  onDialStatus: (cb: (status: unknown) => void) => {
    h.dialHandlers.add(cb);
    return () => h.dialHandlers.delete(cb);
  },
  onConnectionChange: () => () => {},
  listProjects: async () => [...h.projects],
  listTasks: async () => ({ tasks: [], archivedCount: 0 }),
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));

const { useRemotePinnedProjects } = await import("~/lib/use-fleet");
const { applyCorePinFiling, settleCorePinFiling } = await import("~/lib/core-pins-engine");

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

function slotOf(projects: readonly ProjectWithCounts[], projectId: string): number | null {
  return projects.find((p) => p.id === projectId)?.pinnedOrder ?? null;
}

/** Arm `h.readGate`; the returned function lets the held read answer. */
function holdNextRead(): () => void {
  let release = () => {};
  h.readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.releaseRead = release;
  return release;
}

/** Let every queued microtask drain, without asserting anything about them. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  h.dialHandlers.clear();
  h.presentationReads = 0;
  h.dialState = "connected";
  h.readGate = null;
  h.releaseRead = null;
  h.failRead = false;
  h.projects = [project("p-one"), project("p-two")];
  h.presentation = [
    filed({ projectId: "p-one", pinnedOrder: 0 }),
    filed({ projectId: "p-two", pinnedOrder: 1 }),
  ];
});

afterEach(() => {
  // A read left held would leave the engine's coalescing loop running forever,
  // and it is module state — every later test in this file would then wait on
  // a pass that never ends. Let go of it whatever the test did.
  h.releaseRead?.();
  h.releaseRead = null;
  h.readGate = null;
  // The engine is module state refcounted by its subscribers, so every test
  // has to hand its mounts back — the last one leaving is what resets it.
  cleanup();
  vi.restoreAllMocks();
});

describe("a Core-owned pin's rail slot", () => {
  it("reads the slot back off the presentation row", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    expect(slotOf(result.current.projects, "p-one")).toBe(0);
    expect(slotOf(result.current.projects, "p-two")).toBe(1);
  });

  it("moves the tile on the write, not on the fan-out that confirms it", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    const readsBefore = h.presentationReads;

    // What `persistProjectOrder` does before its first await. Nothing has been
    // sent yet, and no Core has been asked anything.
    await act(async () => {
      applyCorePinFiling(
        new Map([
          ["p-two", { pinnedOrder: 0 }],
          ["p-one", { pinnedOrder: 1 }],
        ]),
      );
    });

    expect(slotOf(result.current.projects, "p-two")).toBe(0);
    expect(slotOf(result.current.projects, "p-one")).toBe(1);
    // The point of the finding: the operator does not wait on a fan-out to see
    // the tile they just moved.
    expect(h.presentationReads).toBe(readsBefore);
  });

  it("outranks a read that lands while the write is still in flight", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    await act(async () => {
      applyCorePinFiling(new Map([["p-two", { pinnedOrder: 0 }]]));
    });

    // A poll ticks mid-write. The server has not been told yet, so it answers
    // with the slot the operator has already replaced — and the rail must not
    // repaint itself with it.
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(h.presentationReads).toBeGreaterThan(1));
    expect(slotOf(result.current.projects, "p-two")).toBe(0);
  });

  it("hands the rail back to the server once the write has been read back", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    let token = 0;
    await act(async () => {
      token = applyCorePinFiling(new Map([["p-two", { pinnedOrder: 0 }]]));
    });
    // The write lands.
    h.presentation = [
      filed({ projectId: "p-one", pinnedOrder: 1 }),
      filed({ projectId: "p-two", pinnedOrder: 0 }),
    ];
    await act(async () => {
      await settleCorePinFiling(["p-two"], token);
    });

    expect(slotOf(result.current.projects, "p-two")).toBe(0);

    // And the overlay really is gone: the server is authoritative again, so a
    // slot changed elsewhere now reaches the rail.
    h.presentation = [
      filed({ projectId: "p-one", pinnedOrder: 0 }),
      filed({ projectId: "p-two", pinnedOrder: 7 }),
    ];
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(slotOf(result.current.projects, "p-two")).toBe(7));
  });

  it("carries a group change for a Core pin as well as a slot", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.projects.find((p) => p.id === "p-two")?.groupId).toBeNull();

    // Dragging a Core pin into another cluster is the second half of #382's
    // repro, and it moves the same way: presentation, optimistically first.
    await act(async () => {
      applyCorePinFiling(new Map([["p-two", { pinnedOrder: 0, groupId: "g-alpha" }]]));
    });

    expect(result.current.projects.find((p) => p.id === "p-two")?.groupId).toBe("g-alpha");
  });

  it("re-files a disconnected Core's remembered pins from the presentation it just read", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    // The link drops. The pins stay — that is deliberate, a Core the tab
    // cannot reach still has pins — and they are served from `lastRowsByCore`.
    await dial("unreachable");
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    // The operator reorders anyway. The write needs no Core: the slot lives in
    // the Panel's own database, and `reorderCorePins` succeeds.
    h.presentation = [
      filed({ projectId: "p-one", pinnedOrder: 1 }),
      filed({ projectId: "p-two", pinnedOrder: 0, groupId: "g-alpha" }),
    ];
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Before the fix the remembered rows carried the slot baked in at the last
    // successful read, so this republished 0 and 1 the old way round and the
    // rail stayed wrong until the Core came back.
    await waitFor(() => expect(slotOf(result.current.projects, "p-two")).toBe(0));
    expect(slotOf(result.current.projects, "p-one")).toBe(1);
    expect(result.current.projects.find((p) => p.id === "p-two")?.groupId).toBe("g-alpha");
    // Core facts are still the remembered ones — nothing here invented a read
    // of a Core that is not there.
    expect(result.current.projects.find((p) => p.id === "p-two")?.name).toBe("p-two");
  });

  it("does not take the overlay down until a read that started after the settle has landed", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    let token = 0;
    await act(async () => {
      token = applyCorePinFiling(
        new Map([
          ["p-two", { pinnedOrder: 0 }],
          ["p-one", { pinnedOrder: 1 }],
        ]),
      );
    });
    expect(slotOf(result.current.projects, "p-two")).toBe(0);

    // A pass is ALREADY in flight when the writes come back — started by the
    // poll, by a reconnect, or by any task, session, PTY or project-list event,
    // which on a fleet with a live session is continuous. Its read was taken
    // before the write landed, so it is carrying the old slots.
    const release = holdNextRead();
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });

    // The write lands on the server while that pass is still fanning out.
    h.presentation = [
      filed({ projectId: "p-one", pinnedOrder: 1 }),
      filed({ projectId: "p-two", pinnedOrder: 0 }),
    ];

    let settled = false;
    const settle = settleCorePinFiling(["p-two", "p-one"], token).then(() => {
      settled = true;
    });
    await drain();
    // The finding: `await run()` resolved here on the next microtask, having
    // read nothing, because the coalescing runner records a request it cannot
    // serve rather than serving it. The overlay came down under a pass that had
    // read the table before the write.
    expect(settled).toBe(false);
    expect(slotOf(result.current.projects, "p-two")).toBe(0);

    await act(async () => {
      release();
      await settle;
    });

    // The stale pass landed, the fresh one behind it corrected the rail, and
    // the tile the operator moved never went back to where they found it.
    expect(settled).toBe(true);
    expect(slotOf(result.current.projects, "p-two")).toBe(0);
    expect(slotOf(result.current.projects, "p-one")).toBe(1);
  });

  it("puts the server's order back when the write it was optimistic about failed", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    let token = 0;
    await act(async () => {
      token = applyCorePinFiling(
        new Map([
          ["p-two", { pinnedOrder: 0 }],
          ["p-one", { pinnedOrder: 1 }],
        ]),
      );
    });
    expect(slotOf(result.current.projects, "p-two")).toBe(0);

    // `reorderPinnedProjects` refused the move — another tab unpinning a Panel
    // row is enough. Nothing was written: the table still reads the way it did.
    await act(async () => {
      await settleCorePinFiling(["p-two", "p-one"], token);
    });

    // The Panel half of the rail reverts with the query cache and the toast
    // says the move failed, so the Core half has to revert too. It did not: the
    // settle read with the overlay still up, published the optimistic slots,
    // then deleted the entries and published nothing — leaving the operator an
    // order nobody chose until the next pass, up to a poll tick away.
    expect(slotOf(result.current.projects, "p-two")).toBe(1);
    expect(slotOf(result.current.projects, "p-one")).toBe(0);
  });

  it("lets an earlier gesture's settle alone with a later gesture's overlay", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));

    // Two Shift+Arrows in quick succession. The gesture guard is released
    // before the settle on purpose — the second key must not be swallowed — so
    // the first gesture's settle can resolve after the second has overlaid its
    // own slot, with that second write still in flight.
    let first = 0;
    let second = 0;
    await act(async () => {
      first = applyCorePinFiling(new Map([["p-two", { pinnedOrder: 0 }]]));
      second = applyCorePinFiling(new Map([["p-two", { pinnedOrder: 5 }]]));
    });
    expect(slotOf(result.current.projects, "p-two")).toBe(5);

    await act(async () => {
      await settleCorePinFiling(["p-two"], first);
    });
    expect(slotOf(result.current.projects, "p-two")).toBe(5);

    // And it is a live overlay that was left, not a leftover value: a read
    // landing now still does not get to repaint the tile.
    h.presentation = [
      filed({ projectId: "p-one", pinnedOrder: 0 }),
      filed({ projectId: "p-two", pinnedOrder: 9 }),
    ];
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(slotOf(result.current.projects, "p-two")).toBe(5);

    // The second gesture's own settle is what takes it down.
    await act(async () => {
      await settleCorePinFiling(["p-two"], second);
    });
    await waitFor(() => expect(slotOf(result.current.projects, "p-two")).toBe(9));
  });

  it("holds the rail still when the presentation read fails", async () => {
    const { result } = renderHook(() => useRemotePinnedProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(slotOf(result.current.projects, "p-two")).toBe(1);

    h.failRead = true;
    const readsBefore = h.presentationReads;
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(h.presentationReads).toBeGreaterThan(readsBefore));

    // Degrading a failed read to an empty answer files every row null, and null
    // is last to the comparator — so one API blip sent the whole Core half of
    // the rail to the end of it, with no toast (#478 item 3).
    expect(slotOf(result.current.projects, "p-one")).toBe(0);
    expect(slotOf(result.current.projects, "p-two")).toBe(1);

    // Same again for a Core that is off the link, which is the case #382's own
    // fix newly exposed: its rows are remembered, and their filing is now
    // re-read every pass rather than baked in.
    await dial("unreachable");
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.projects).toHaveLength(2);
    expect(slotOf(result.current.projects, "p-one")).toBe(0);
    expect(slotOf(result.current.projects, "p-two")).toBe(1);
  });
});
