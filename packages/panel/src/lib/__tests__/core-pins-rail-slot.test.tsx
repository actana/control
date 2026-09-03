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
      return { presentation: h.presentation.map((row) => ({ ...row })) };
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

beforeEach(() => {
  h.dialHandlers.clear();
  h.presentationReads = 0;
  h.dialState = "connected";
  h.projects = [project("p-one"), project("p-two")];
  h.presentation = [
    filed({ projectId: "p-one", pinnedOrder: 0 }),
    filed({ projectId: "p-two", pinnedOrder: 1 }),
  ];
});

afterEach(() => {
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

    await act(async () => {
      applyCorePinFiling(new Map([["p-two", { pinnedOrder: 0 }]]));
    });
    // The write lands.
    h.presentation = [
      filed({ projectId: "p-one", pinnedOrder: 1 }),
      filed({ projectId: "p-two", pinnedOrder: 0 }),
    ];
    await act(async () => {
      await settleCorePinFiling(["p-two"]);
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
});
