// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectWithCounts } from "~/shared/projects";
import type { Group } from "~/db/schema";
import type { CorePinFiling } from "~/lib/core-pins-engine";

// Issue 382. The rail is one strip of pins, but the rows on it have two
// owners: the projects in this Panel's own database, and the pins each Core
// owns and answers for over the core-link. Both write paths the rail used were
// Panel-only —
//
//   * `PATCH /api/projects/pinned-order` validates the order it is given
//     against the Panel's `projects` table, so a rail order naming a Core's pin
//     was rejected outright, taking the Panel rows' reorder down with it;
//   * `PATCH /api/projects/:id` 404s for a project the Panel holds no row for,
//     so dragging a Core pin into another group failed the same way.
//
// — which is what the operator saw: the tile animates into its new slot, the
// slot springs back, and a toast says it could not move.
//
// What this suite pins is the split: each row's position and group are written
// by whoever owns that row, and the two halves share ONE numbering space — the
// row's index in the whole rail — so the merged list sorts back into the
// operator's order on reload rather than into two interleaved dense runs.
//
// It also pins the half the review of PR #476 found missing: a Core-owned row
// is not in the query cache the optimistic update reaches, so the rail has to
// tell the fleet engine about the move as well, before the first await. The
// engine's own side of that contract is `lib/__tests__/core-pins-rail-slot`;
// what is checked here is that `ProjectBar` tells it, and that the tile the
// operator moved is drawn where they moved it.
//
// Order-only gestures are driven with Shift+Arrow, which needs no geometry.
// The regroup case is a real pointer drag — it is the only gesture that
// produces a group change, and it is the literal second half of the issue's
// repro — so the rail's rects are laid out by hand below, since every rect in
// jsdom is zero.

const invalidateQueries = vi.fn(async () => {});
// A working stand-in for the query cache, not an inert spy: the rail's two
// halves take their optimism from two different places and the interleaving is
// the thing under test, so a `setQueryData` that dropped the Panel half would
// make the rendered order meaningless.
const setQueryData = vi.fn((key: readonly unknown[], updater: unknown) => {
  if (key[0] !== "projects") return;
  panelProjects =
    typeof updater === "function"
      ? ((updater as (current: ProjectWithCounts[]) => ProjectWithCounts[])(panelProjects) ??
        panelProjects)
      : (updater as ProjectWithCounts[]);
});
const getQueryData = vi.fn(() => panelProjects);

/** Every write the rail makes, in the order it made them. */
let writeLog: string[] = [];

const reorderPinnedProjects = vi.fn(async (_order: string[]) => {
  writeLog.push("reorderPinnedProjects");
  return { projects: panelProjects };
});
const reorderCorePinnedProjects = vi.fn(
  async (_order: readonly { projectId: string; coreId: string; pinnedOrder: number }[]) => {
    writeLog.push("reorderCorePinnedProjects");
    return { presentation: [] };
  },
);
const updateProject = vi.fn(async (_id: string, _body: Record<string, unknown>) => {
  writeLog.push("updateProject");
  return { project: null };
});
const updateProjectPresentation = vi.fn(
  async (_id: string, _coreId: string, _patch: Record<string, unknown>) => {
    writeLog.push("updateProjectPresentation");
    return { presentation: {} };
  },
);
const applyCorePinFiling = vi.fn((filing: ReadonlyMap<string, CorePinFiling>) => {
  writeLog.push("applyCorePinFiling");
  corePinsStore.applyFiling(filing);
});
const settleCorePinFiling = vi.fn(async (_projectIds: readonly string[]) => {
  writeLog.push("settleCorePinFiling");
});
const refreshRemotePinned = vi.fn();
const mutateProjectForCore = vi.fn(
  async (_coreId: string | null | undefined, _mutation: Record<string, unknown>) => {
    writeLog.push("mutateProjectForCore");
    return null;
  },
);
const toastError = vi.fn();

const GROUP_A: Group = { id: "g_alpha", name: "Alpha group", color: "#ff8800" } as Group;
const GROUP_B: Group = { id: "g_beta", name: "Beta group", color: "#0088ff" } as Group;

/**
 * The fleet engine's snapshot, as a store the rail subscribes to — which is
 * what the real one is. Mocking `useRemotePinnedProjects` as a plain value
 * would have made the optimistic path untestable here, which is exactly how
 * the first round of this suite missed it.
 */
const corePinsStore = {
  value: [] as ProjectWithCounts[],
  listeners: new Set<() => void>(),
  set(next: ProjectWithCounts[]) {
    corePinsStore.value = next;
    for (const listener of corePinsStore.listeners) listener();
  },
  applyFiling(filing: ReadonlyMap<string, CorePinFiling>) {
    corePinsStore.set(
      corePinsStore.value.map((row) => {
        const patch = filing.get(row.id);
        if (!patch) return row;
        return {
          ...row,
          ...("pinnedOrder" in patch ? { pinnedOrder: patch.pinnedOrder ?? null } : {}),
          ...("groupId" in patch ? { groupId: patch.groupId ?? null } : {}),
        };
      }),
    );
  },
  subscribe(listener: () => void) {
    corePinsStore.listeners.add(listener);
    return () => corePinsStore.listeners.delete(listener);
  },
  snapshot: () => corePinsStore.value,
};

/** The GroupSwitcher's selection, as a store the rail can subscribe to. */
const activeGroupStore = {
  value: "all" as string,
  listeners: new Set<() => void>(),
  set(next: string) {
    activeGroupStore.value = next;
    for (const listener of activeGroupStore.listeners) listener();
  },
  subscribe(listener: () => void) {
    activeGroupStore.listeners.add(listener);
    return () => activeGroupStore.listeners.delete(listener);
  },
  snapshot: () => activeGroupStore.value,
};

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries, setQueryData, getQueryData }),
}));
vi.mock("~/queries", () => ({
  useProjects: () => ({ data: panelProjects }),
  useGroups: () => ({ data: groups }),
  useSettings: () => ({ data: undefined }),
  queryKeys: { projects: ["projects"], groups: ["groups"], project: (id: string) => ["project", id] },
}));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [] }),
  useRemotePinnedProjects: () => ({
    projects: useSyncExternalStore(
      corePinsStore.subscribe,
      corePinsStore.snapshot,
      corePinsStore.snapshot,
    ),
    refresh: refreshRemotePinned,
  }),
}));
vi.mock("~/lib/core-pins-engine", () => ({
  applyCorePinFiling: (filing: ReadonlyMap<string, CorePinFiling>) => applyCorePinFiling(filing),
  settleCorePinFiling: (ids: readonly string[]) => settleCorePinFiling(ids),
}));
vi.mock("~/lib/mutate-project-for-core", () => ({
  mutateProjectForCore: (coreId: string | null | undefined, mutation: Record<string, unknown>) =>
    mutateProjectForCore(coreId, mutation),
}));
vi.mock("~/lib/use-events", () => ({ useServerEvents: () => {} }));
vi.mock("~/lib/keybindings/store", () => ({ useBinding: () => ({ mods: [], key: "" }) }));
vi.mock("~/lib/active-group", async () => {
  const actual = await vi.importActual<typeof import("~/shared/ui-preferences")>(
    "~/shared/ui-preferences",
  );
  return {
    ACTIVE_GROUP_ALL: actual.ACTIVE_GROUP_ALL,
    ACTIVE_GROUP_UNGROUPED: actual.ACTIVE_GROUP_UNGROUPED,
    useActiveGroup: () => ({
      activeGroup: useSyncExternalStore(
        activeGroupStore.subscribe,
        activeGroupStore.snapshot,
        activeGroupStore.snapshot,
      ),
      setActiveGroup: (next: string) => activeGroupStore.set(next),
      groups,
    }),
  };
});
vi.mock("~/lib/api", () => ({
  api: {
    getKeybindings: async () => ({ bindings: {} }),
    listProjectPresentation: async () => ({ presentation: [] }),
    reorderPinnedProjects,
    reorderCorePinnedProjects,
    updateProject,
    updateProjectPresentation,
  },
}));

const {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
} = await import("@tanstack/react-router");
const { ProjectBar } = await import("../ProjectBar");

function makeProject(
  over: Partial<ProjectWithCounts> & Pick<ProjectWithCounts, "id" | "name">,
): ProjectWithCounts {
  return {
    path: `/srv/${over.id}`,
    icon: "folder",
    iconColor: "#88aaff",
    imagePath: null,
    groupId: null,
    pinned: true,
    pinnedOrder: 0,
    launchUrl: null,
    rememberHarnessSettings: false,
    savedHarness: null,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    coreId: null,
    taskCounts: {
      ready: 0,
      running: 0,
      "needs-input": 0,
      interrupted: 0,
      finished: 0,
      terminated: 0,
      disconnected: 0,
      total: 0,
      activeNonDone: 0,
    },
    ...over,
  } as ProjectWithCounts;
}

// A mixed rail in one group, in rail order: Panel, Core, Panel, Core. The
// interleaving is the point — an owner-local numbering could not express it.
const PANEL_ONE = makeProject({
  id: "p_panel_one",
  name: "Panel one",
  groupId: GROUP_A.id,
  pinnedOrder: 0,
});
const CORE_ONE = makeProject({
  id: "p_core_one",
  name: "Core one",
  groupId: GROUP_A.id,
  pinnedOrder: 1,
  coreId: "core_alpha",
});
const PANEL_TWO = makeProject({
  id: "p_panel_two",
  name: "Panel two",
  groupId: GROUP_A.id,
  pinnedOrder: 2,
});
const CORE_TWO = makeProject({
  id: "p_core_two",
  name: "Core two",
  groupId: GROUP_A.id,
  pinnedOrder: 3,
  coreId: "core_beta",
});

let panelProjects: ProjectWithCounts[] = [];
let groups: Group[] = [];

function buildRouter(at = "/", barCoreId: string | null = null) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ProjectBar coreId={barCoreId} />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$id",
    component: () => null,
    validateSearch: (search: Record<string, unknown>) => ({
      coreId: typeof search.coreId === "string" ? search.coreId : undefined,
    }),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, projectRoute]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountRail(at = "/", barCoreId: string | null = null) {
  const router = buildRouter(at, barCoreId);
  const view = render(<RouterProvider router={router as never} />);
  await settle();
  return { router, view };
}

/**
 * Right-click a tile and pick an item from the menu that opens. The menu is
 * portalled to `document.body`, so it is found there rather than in the
 * container.
 */
async function railMenuAction(
  container: HTMLElement,
  id: string,
  label: string,
): Promise<void> {
  await act(async () => {
    fireEvent.contextMenu(tile(container, id), { clientX: 10, clientY: 10 });
  });
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] button')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no "${label}" item in the rail menu for ${id}`);
  await act(async () => {
    fireEvent.click(item);
  });
  await settle();
}

function tile(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-project-id="${id}"]`);
  if (!el) throw new Error(`no rail tile for ${id}`);
  return el;
}

/** The operator's reorder gesture that needs no geometry. */
async function shiftArrow(container: HTMLElement, id: string, key: "ArrowUp" | "ArrowDown") {
  fireEvent.keyDown(tile(container, id), { key, shiftKey: true });
  await settle();
}

/** The rail's tiles, top to bottom. */
function railIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-project-id]")].map(
    (el) => el.dataset.projectId!,
  );
}

// ── Pointer-drag support ────────────────────────────────────────────────────
//
// The drag reads the rail's geometry once, at pointerdown, and every slot it
// can drop into is derived from that snapshot. jsdom reports every rect as
// zero, so the rail is laid out here with the component's own constants —
// header 20px, tile 48px, 8px gap — and `getBoundingClientRect` is pointed at
// it. Nothing else about the gesture is simulated: the events are the real
// ones, and the component does its own arithmetic on them.

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const RECTS = new WeakMap<Element, DOMRect>();
const ZERO_RECT = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;

function railRect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 58, width: 58, height } as DOMRect;
}

function layoutRail(container: HTMLElement): void {
  const bar = container.querySelector<HTMLElement>(".mc-project-rail");
  if (!bar) throw new Error("no rail");
  let y = 0;
  for (const el of bar.querySelectorAll<HTMLElement>(
    "[data-cluster-header], [data-pinned-item]",
  )) {
    const height = el.hasAttribute("data-cluster-header") ? 20 : 48;
    RECTS.set(el, railRect(y, height));
    y += height + 8;
  }
}

/**
 * Drag a tile to the very bottom of the rail. The travel is clamped to the
 * last slot, so this lands the tile in the last cluster whatever the exact
 * pixel — which is what makes it a group change without the test having to
 * re-derive the component's slot arithmetic.
 */
async function dragTileToEnd(container: HTMLElement, id: string): Promise<void> {
  layoutRail(container);
  const handle = tile(container, id);
  await act(async () => {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 0 });
  });
  await act(async () => {
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 1000 });
  });
  await act(async () => {
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 1000 });
  });
  // The drop eases into its slot before the reorder is committed.
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  await settle();
}

beforeEach(() => {
  panelProjects = [PANEL_ONE, PANEL_TWO];
  corePinsStore.value = [CORE_ONE, CORE_TWO];
  corePinsStore.listeners.clear();
  groups = [GROUP_A, GROUP_B];
  activeGroupStore.value = "all";
  writeLog = [];
  // jsdom has PointerEvent but none of the capture API the drag uses, and it
  // reports every rect as zero — see `layoutRail`.
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
  Element.prototype.hasPointerCapture = function () {
    return true;
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return RECTS.get(this) ?? ZERO_RECT;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  panelProjects = [];
  corePinsStore.value = [];
  groups = [];
  activeGroupStore.listeners.clear();
  vi.clearAllMocks();
});

describe("ProjectBar reorder on a mixed rail", () => {
  it("draws the Panel's pins and the Cores' pins as one ordered strip", async () => {
    const { view } = await mountRail();
    expect(railIds(view.container)).toEqual([
      PANEL_ONE.id,
      CORE_ONE.id,
      PANEL_TWO.id,
      CORE_TWO.id,
    ]);
  });

  it("sends the whole rail to the Panel API and every Core pin's slot to presentation", async () => {
    const { view } = await mountRail();

    // Move the FIRST Core pin up one slot: [P1, C1, P2, C2] -> [C1, P1, P2, C2].
    await shiftArrow(view.container, CORE_ONE.id, "ArrowUp");

    // Acceptance 2: the gesture is valid, so nothing may toast.
    expect(toastError).not.toHaveBeenCalled();

    // The Panel API is still the Panel API — it is handed the whole rail, so
    // the slot it writes for each of its own rows is that row's slot on the
    // rail rather than its slot among the Panel's rows alone.
    expect(reorderPinnedProjects).toHaveBeenCalledTimes(1);
    expect(reorderPinnedProjects.mock.calls[0]![0]).toEqual([
      CORE_ONE.id,
      PANEL_ONE.id,
      PANEL_TWO.id,
      CORE_TWO.id,
    ]);

    // ...and the Core-owned rows take the same indices out of that same rail,
    // on the presentation rows that are the only place this Panel can keep
    // them. Acceptance 1 is exactly this agreement: one numbering space, so
    // the merged list re-sorts into [C1, P1, P2, C2] after a reload.
    expect(reorderCorePinnedProjects).toHaveBeenCalledTimes(1);
    expect(reorderCorePinnedProjects.mock.calls[0]![0]).toEqual([
      { projectId: CORE_ONE.id, coreId: "core_alpha", pinnedOrder: 0 },
      { projectId: CORE_TWO.id, coreId: "core_beta", pinnedOrder: 3 },
    ]);
  });

  it("moves the Core tile on the gesture, not on the fan-out that confirms it", async () => {
    const { view } = await mountRail();
    expect(railIds(view.container)[1]).toBe(CORE_ONE.id);

    await shiftArrow(view.container, CORE_ONE.id, "ArrowUp");

    // The finding this closes: the Core tile's slot lives in the fleet
    // engine's snapshot, not in the query cache the optimistic update reaches,
    // so without telling the engine the tile stayed where it was — with
    // Shift+Arrow, visibly not moving at all — until a whole fan-out landed.
    expect(applyCorePinFiling).toHaveBeenCalledTimes(1);
    expect([...applyCorePinFiling.mock.calls[0]![0].entries()]).toEqual([
      [CORE_ONE.id, { pinnedOrder: 0 }],
      [CORE_TWO.id, { pinnedOrder: 3 }],
    ]);
    // And it happened before anything was sent.
    expect(writeLog[0]).toBe("applyCorePinFiling");
    // The rail is drawn in the new order, now, with no read of any Core.
    expect(railIds(view.container)[0]).toBe(CORE_ONE.id);
  });

  it("takes the overlay back down once the write has been read back", async () => {
    const { view } = await mountRail();
    await shiftArrow(view.container, CORE_ONE.id, "ArrowUp");

    // The overlay is the engine's, so it is the engine that must be told the
    // write is over — for the same ids it was given, whether the write
    // succeeded or failed.
    expect(settleCorePinFiling).toHaveBeenCalledTimes(1);
    expect(settleCorePinFiling.mock.calls[0]![0]).toEqual([CORE_ONE.id, CORE_TWO.id]);
    expect(writeLog[writeLog.length - 1]).toBe("settleCorePinFiling");
  });

  it("never sends a Core id to the Panel-only project PATCH", async () => {
    const { view } = await mountRail();
    await shiftArrow(view.container, CORE_TWO.id, "ArrowUp");
    expect(toastError).not.toHaveBeenCalled();
    // Order alone changed here, so nothing should have been PATCHed at all.
    expect(updateProject).not.toHaveBeenCalled();
    expect(updateProjectPresentation).not.toHaveBeenCalled();
  });

  it("re-slots every Core pin, not just the one that moved", async () => {
    const { view } = await mountRail();

    // Moving a Panel row past a Core row shifts the Core row's slot too. A
    // Core pin left holding a stale index is the reorder failing to stick for
    // it a poll later, which is the same bug wearing a delay.
    await shiftArrow(view.container, PANEL_TWO.id, "ArrowUp");

    expect(reorderPinnedProjects.mock.calls[0]![0]).toEqual([
      PANEL_ONE.id,
      PANEL_TWO.id,
      CORE_ONE.id,
      CORE_TWO.id,
    ]);
    expect(reorderCorePinnedProjects.mock.calls[0]![0]).toEqual([
      { projectId: CORE_ONE.id, coreId: "core_alpha", pinnedOrder: 2 },
      { projectId: CORE_TWO.id, coreId: "core_beta", pinnedOrder: 3 },
    ]);
  });

  it("leaves presentation alone on a rail with no Core pin", async () => {
    corePinsStore.value = [];
    const { view } = await mountRail();
    await shiftArrow(view.container, PANEL_TWO.id, "ArrowUp");

    expect(reorderPinnedProjects.mock.calls[0]![0]).toEqual([PANEL_TWO.id, PANEL_ONE.id]);
    // A Panel-only rail is the shape this always worked for; it must not grow
    // a request it does not need, and there is nothing for the engine to
    // overlay — the empty map and the empty id list are both no-ops there.
    expect(reorderCorePinnedProjects).not.toHaveBeenCalled();
    expect(applyCorePinFiling.mock.calls[0]![0].size).toBe(0);
    expect(settleCorePinFiling.mock.calls[0]![0]).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("keeps the off-group tile out of the order it persists", async () => {
    // #378 appends a tile for the project the route is on when the active
    // group hides it. It is a selection affordance: it holds no slot, so a
    // reorder must neither move it nor renumber it — and it is a Core pin
    // here, so counting it would file a slot on a Core row the group being
    // reordered does not contain.
    const OFF = makeProject({
      id: "p_core_off",
      name: "Core elsewhere",
      groupId: GROUP_B.id,
      pinnedOrder: 4,
      coreId: "core_alpha",
    });
    corePinsStore.value = [CORE_ONE, CORE_TWO, OFF];
    activeGroupStore.value = GROUP_A.id;
    // The route is on a project group A does not hold — the gesture #378
    // covers, arrived at with the group already switched.
    const { view } = await mountRail(`/projects/${OFF.id}`);

    // The rail is group A's workspace plus the off-group affordance at the end.
    expect(tile(view.container, OFF.id).dataset.offGroup).toBe("true");
    expect(tile(view.container, OFF.id).dataset.pinnedItem).toBeUndefined();

    await shiftArrow(view.container, CORE_ONE.id, "ArrowUp");

    // The off-group row keeps the slot it already had — it rides along in the
    // rail order as the passenger it is, and is never moved by this reorder.
    expect(reorderPinnedProjects.mock.calls[0]![0]).toEqual([
      CORE_ONE.id,
      PANEL_ONE.id,
      PANEL_TWO.id,
      CORE_TWO.id,
      OFF.id,
    ]);
    expect(reorderCorePinnedProjects.mock.calls[0]![0]).toEqual([
      { projectId: CORE_ONE.id, coreId: "core_alpha", pinnedOrder: 0 },
      { projectId: CORE_TWO.id, coreId: "core_beta", pinnedOrder: 3 },
      { projectId: OFF.id, coreId: "core_alpha", pinnedOrder: 4 },
    ]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("cannot reorder the off-group tile itself", async () => {
    const OFF = makeProject({
      id: "p_core_off",
      name: "Core elsewhere",
      groupId: GROUP_B.id,
      pinnedOrder: 4,
      coreId: "core_alpha",
    });
    corePinsStore.value = [CORE_ONE, CORE_TWO, OFF];
    activeGroupStore.value = GROUP_A.id;
    const { view } = await mountRail(`/projects/${OFF.id}`);

    await shiftArrow(view.container, OFF.id, "ArrowUp");

    // Nothing was written: the appended tile is not a pin of this rail.
    expect(reorderPinnedProjects).not.toHaveBeenCalled();
    expect(reorderCorePinnedProjects).not.toHaveBeenCalled();
    expect(applyCorePinFiling).not.toHaveBeenCalled();
    expect(settleCorePinFiling).not.toHaveBeenCalled();
  });
});

// The other half of the issue's repro — "drag a Core pin into another group".
// Only the pointer drag produces a group change, so only the pointer drag
// exercises the branch that used to send a Core id to `PATCH /api/projects/:id`
// and take a 404 back.
describe("ProjectBar regroup of a Core-owned pin", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Two clusters, so a drag to the foot of the rail crosses a group
    // boundary: A holds [P1, C1], B holds [P2, C2].
    panelProjects = [
      { ...PANEL_ONE, groupId: GROUP_A.id, pinnedOrder: 0 },
      { ...PANEL_TWO, groupId: GROUP_B.id, pinnedOrder: 2 },
    ];
    corePinsStore.value = [
      { ...CORE_ONE, groupId: GROUP_A.id, pinnedOrder: 1 },
      { ...CORE_TWO, groupId: GROUP_B.id, pinnedOrder: 3 },
    ];
  });

  it("files the new group as presentation and never PATCHes the Panel's own route", async () => {
    const { view } = await mountRail();
    expect(railIds(view.container)).toEqual([
      PANEL_ONE.id,
      CORE_ONE.id,
      PANEL_TWO.id,
      CORE_TWO.id,
    ]);

    await dragTileToEnd(view.container, CORE_ONE.id);

    // The 404 that made this half of the repro fail: a Core-owned project has
    // no `projects` row here, so its group is filed exactly where the
    // Edit-project dialog files it (issue 98).
    expect(updateProject).not.toHaveBeenCalled();
    expect(updateProjectPresentation).toHaveBeenCalledTimes(1);
    expect(updateProjectPresentation.mock.calls[0]).toEqual([
      CORE_ONE.id,
      "core_alpha",
      { groupId: GROUP_B.id },
    ]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("commits the validating order write before the group write", async () => {
    const { view } = await mountRail();
    await dragTileToEnd(view.container, CORE_ONE.id);

    // `reorderPinnedProjects` is the only call here that can refuse the move.
    // Filing the group first meant a refusal left the tile in its new group
    // under a toast saying the move had failed.
    expect(writeLog.indexOf("reorderPinnedProjects")).toBeLessThan(
      writeLog.indexOf("updateProjectPresentation"),
    );
    expect(writeLog.indexOf("reorderPinnedProjects")).toBeGreaterThan(-1);
  });

  it("shows the tile in its new group before the write returns", async () => {
    const { view } = await mountRail();
    await dragTileToEnd(view.container, CORE_ONE.id);

    // The group a Core pin is filed under lives in the same engine snapshot
    // its slot does, so it needs the same optimism or the tile snaps back to
    // the cluster it came from.
    expect(applyCorePinFiling).toHaveBeenCalledTimes(1);
    expect(applyCorePinFiling.mock.calls[0]![0].get(CORE_ONE.id)).toEqual({
      pinnedOrder: 3,
      groupId: GROUP_B.id,
    });
    expect(railIds(view.container)).toEqual([
      PANEL_ONE.id,
      PANEL_TWO.id,
      CORE_TWO.id,
      CORE_ONE.id,
    ]);
  });
});

// The rail's own unpin, which since #382 clears the slot the pin held so a
// re-pin goes to the end of the rail rather than back to where it used to sit.
// That write is addressed to a Core, and the review of PR #476 found it being
// addressed to the wrong one: the menu took the owner from the bar's own
// `coreId` prop when the row did not carry one, and a Panel-owned row never
// does. On a Core-scoped route — which is every project and session route on a
// Core — the operator's own project was therefore filed under that Core, and
// the next prune of it deleted the row and the project's card image off disk.
describe("unpinning from a Core-scoped rail", () => {
  it("does not file a Panel-owned project under the route's Core", async () => {
    const { view } = await mountRail("/", "core_alpha");
    await railMenuAction(view.container, PANEL_ONE.id, "Unpin project");

    // The pin itself goes over the Panel's own API, as a Panel row's must.
    expect(mutateProjectForCore).toHaveBeenCalledTimes(1);
    expect(mutateProjectForCore.mock.calls[0]![0]).toBeNull();
    // And nothing writes a presentation row pairing this Panel project id with
    // a Core that has never heard of it.
    expect(updateProjectPresentation).not.toHaveBeenCalled();
  });

  it("clears the slot of a Core-owned pin, under the Core that owns it", async () => {
    const { view } = await mountRail("/", "core_alpha");
    await railMenuAction(view.container, CORE_TWO.id, "Unpin project");

    // `core_beta`, the row's own Core — not `core_alpha`, the rail's.
    expect(mutateProjectForCore.mock.calls[0]![0]).toBe("core_beta");
    expect(updateProjectPresentation).toHaveBeenCalledTimes(1);
    expect(updateProjectPresentation.mock.calls[0]).toEqual([
      CORE_TWO.id,
      "core_beta",
      { pinnedOrder: null },
    ]);
  });
});
