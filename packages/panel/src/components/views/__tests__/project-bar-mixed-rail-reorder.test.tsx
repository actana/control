// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectWithCounts } from "~/shared/projects";
import type { Group } from "~/db/schema";

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
// Reorders are driven with Shift+Arrow rather than a pointer drag: both land in
// the same `persistProjectOrder`, and the keyboard path has no geometry to fake
// in jsdom, where every rect is zero.

const invalidateQueries = vi.fn(async () => {});
const setQueryData = vi.fn();
const getQueryData = vi.fn(() => panelProjects);

const reorderPinnedProjects = vi.fn(async (_order: string[]) => ({ projects: panelProjects }));
const reorderCorePinnedProjects = vi.fn(
  async (_order: readonly { projectId: string; coreId: string; pinnedOrder: number }[]) => ({
    presentation: [],
  }),
);
const updateProject = vi.fn(async (_id: string, _body: Record<string, unknown>) => ({
  project: null,
}));
const updateProjectPresentation = vi.fn(
  async (_id: string, _coreId: string, _patch: Record<string, unknown>) => ({ presentation: {} }),
);
const refreshRemotePinned = vi.fn();
const toastError = vi.fn();

const GROUP_A: Group = { id: "g_alpha", name: "Alpha group", color: "#ff8800" } as Group;
const GROUP_B: Group = { id: "g_beta", name: "Beta group", color: "#0088ff" } as Group;

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
  useRemotePinnedProjects: () => ({ projects: corePins, refresh: refreshRemotePinned }),
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
let corePins: ProjectWithCounts[] = [];
let groups: Group[] = [];

function buildRouter(at = "/") {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ProjectBar />
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

async function mountRail(at = "/") {
  const router = buildRouter(at);
  const view = render(<RouterProvider router={router as never} />);
  await settle();
  return { router, view };
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

beforeEach(() => {
  panelProjects = [PANEL_ONE, PANEL_TWO];
  corePins = [CORE_ONE, CORE_TWO];
  groups = [GROUP_A, GROUP_B];
  activeGroupStore.value = "all";
});

afterEach(() => {
  cleanup();
  panelProjects = [];
  corePins = [];
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

    // A Core row moved means the fleet's own snapshot is stale; the rail asks
    // for it again rather than waiting out a poll.
    expect(refreshRemotePinned).toHaveBeenCalled();
  });

  it("never sends a Core id to the Panel-only project PATCH", async () => {
    const { view } = await mountRail();
    await shiftArrow(view.container, CORE_TWO.id, "ArrowUp");
    expect(toastError).not.toHaveBeenCalled();
    // The 404 that made a Core pin's regroup fail. Order alone changed here,
    // so nothing should have been PATCHed at all.
    expect(updateProject).not.toHaveBeenCalled();
    for (const call of updateProjectPresentation.mock.calls) {
      expect(call[0]).not.toBe(PANEL_ONE.id);
      expect(call[0]).not.toBe(PANEL_TWO.id);
    }
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
    corePins = [];
    const { view } = await mountRail();
    await shiftArrow(view.container, PANEL_TWO.id, "ArrowUp");

    expect(reorderPinnedProjects.mock.calls[0]![0]).toEqual([PANEL_TWO.id, PANEL_ONE.id]);
    // A Panel-only rail is the shape this always worked for; it must not grow
    // a request it does not need.
    expect(reorderCorePinnedProjects).not.toHaveBeenCalled();
    expect(refreshRemotePinned).not.toHaveBeenCalled();
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
    corePins = [CORE_ONE, CORE_TWO, OFF];
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
    corePins = [CORE_ONE, CORE_TWO, OFF];
    activeGroupStore.value = GROUP_A.id;
    const { view } = await mountRail(`/projects/${OFF.id}`);

    await shiftArrow(view.container, OFF.id, "ArrowUp");

    // Nothing was written: the appended tile is not a pin of this rail.
    expect(reorderPinnedProjects).not.toHaveBeenCalled();
    expect(reorderCorePinnedProjects).not.toHaveBeenCalled();
  });
});
