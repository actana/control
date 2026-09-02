// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectWithCounts } from "~/shared/projects";
import type { Group } from "~/db/schema";

// Issue 378. The scoped rail is the active group's workspace, and it drew the
// selection ring only for a tile inside that workspace. So opening a project in
// group A and then switching the GroupSwitcher to B left the page sitting on A
// while the rail showed B's pins with no ring anywhere — the rail asserting
// that nothing was open while the operator was plainly inside a project, with
// no way back to it except remembering which group it lived in.
//
// The two things this suite pins down are exactly the issue's acceptance
// criteria: the rail keeps a visible selection affordance for the project you
// are on, and nothing navigates — the URL still matches that project.
//
// The group switch is driven through a real subscribable store rather than a
// re-render with new props, because that is the shape of the bug: ProjectBar is
// memoised on `coreId`, so a group switch reaches it only through its own hook
// subscriptions.

const invalidateQueries = vi.fn(async () => {});

const GROUP_A: Group = { id: "g_alpha", name: "Alpha group", color: "#ff8800" } as Group;
const GROUP_B: Group = { id: "g_beta", name: "Beta group", color: "#0088ff" } as Group;
const GROUP_EMPTY: Group = { id: "g_empty", name: "Empty group", color: "#00ff88" } as Group;

/** The GroupSwitcher's selection, as a store the rail can subscribe to. */
const activeGroupStore = {
  value: GROUP_A.id as string,
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

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));
vi.mock("~/queries", () => ({
  useProjects: () => ({ data: panelProjects }),
  useGroups: () => ({ data: groups }),
  useSettings: () => ({ data: undefined }),
  queryKeys: { projects: ["projects"], groups: ["groups"], project: (id: string) => ["project", id] },
}));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [] }),
  useRemotePinnedProjects: () => ({ projects: [], refresh: vi.fn() }),
}));
vi.mock("~/lib/use-events", () => ({ useServerEvents: () => {} }));
vi.mock("~/lib/keybindings/store", () => ({
  useBinding: () => ({ mods: [], key: "" }),
}));
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
  };
}

const PROJECT_A = makeProject({
  id: "p_alpha",
  name: "Alpha",
  groupId: GROUP_A.id,
  pinnedOrder: 0,
});
const PROJECT_B = makeProject({
  id: "p_beta",
  name: "Beta",
  groupId: GROUP_B.id,
  pinnedOrder: 1,
});

let panelProjects: ProjectWithCounts[] = [];
let groups: Group[] = [];

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ProjectBar />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

async function mountRail() {
  panelProjects = [PROJECT_A, PROJECT_B];
  groups = [GROUP_A, GROUP_B, GROUP_EMPTY];
  const router = buildRouter();
  const view = render(<RouterProvider router={router as never} />);
  await settle();
  return { router, view };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Drive the GroupSwitcher the way the operator does — nothing else changes. */
async function switchGroupTo(id: string) {
  await act(async () => {
    activeGroupStore.set(id);
  });
  await settle();
}

/** The project the accent ring currently sits on, or null when it is hidden. */
function ringOn(container: HTMLElement): string | null {
  return container.querySelector("[data-active-project-id]")?.getAttribute("data-active-project-id") ?? null;
}

function tile(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-project-id="${id}"]`);
  if (!el) throw new Error(`no rail tile for ${id}`);
  return el;
}

function tileOrNull(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-project-id="${id}"]`);
}

/** Every tile the rail is currently drawing for one project. */
function tilesFor(container: HTMLElement, id: string): NodeListOf<HTMLElement> {
  return container.querySelectorAll<HTMLElement>(`[data-project-id="${id}"]`);
}

/** The accessible name of the rail's `role="navigation"` landmark. */
function railName(container: HTMLElement): string | null {
  return container.querySelector(".mc-project-rail")?.getAttribute("aria-label") ?? null;
}

afterEach(() => {
  cleanup();
  panelProjects = [];
  groups = [];
  activeGroupStore.value = GROUP_A.id;
  activeGroupStore.listeners.clear();
  vi.clearAllMocks();
});

describe("ProjectBar selection across a group switch", () => {
  it("keeps the ring on the open project when the active group hides it, and stays on its URL", async () => {
    const { router, view } = await mountRail();
    const container = view.container;

    fireEvent.click(tile(container, PROJECT_A.id));
    await settle();
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_A.id}`);
    expect(ringOn(container)).toBe(PROJECT_A.id);

    await switchGroupTo(GROUP_B.id);

    // Acceptance 2: nothing navigated. The page is still the project the
    // operator opened.
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_A.id}`);
    // Acceptance 1: the rail does not pretend nothing is selected — the open
    // project still has a tile, and the ring is still on it.
    expect(tileOrNull(container, PROJECT_A.id)).not.toBeNull();
    expect(ringOn(container)).toBe(PROJECT_A.id);
    // ...and the switch really did happen: B's own pin is what the rail is
    // scoped to now.
    expect(tileOrNull(container, PROJECT_B.id)).not.toBeNull();
    expect(tile(container, PROJECT_A.id).dataset.offGroup).toBe("true");
    expect(tile(container, PROJECT_B.id).dataset.offGroup).toBeUndefined();
    // Exactly one tile, never two. The off-group cluster is appended only when
    // the scoped cluster does not already hold the project, and both lists are
    // derived from the same `projects` array — so a second tile would mean the
    // guard had gone wrong, and the ring's `data-active-project-id` would no
    // longer name one place on screen.
    expect(tilesFor(container, PROJECT_A.id)).toHaveLength(1);
    expect(container.querySelectorAll("[data-off-group]")).toHaveLength(1);
  });

  it("keeps the affordance even when the group switched to is empty", async () => {
    const { router, view } = await mountRail();
    const container = view.container;

    fireEvent.click(tile(container, PROJECT_A.id));
    await settle();

    // An empty group used to collapse the whole rail to nothing, which is the
    // same lie in a louder form: no rail, no ring, page still on the project.
    await switchGroupTo(GROUP_EMPTY.id);

    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_A.id}`);
    expect(ringOn(container)).toBe(PROJECT_A.id);
    expect(tile(container, PROJECT_A.id).dataset.offGroup).toBe("true");
    expect(tilesFor(container, PROJECT_A.id)).toHaveLength(1);
  });

  it("names the rail after the active group, not after the off-group tile", async () => {
    const { view } = await mountRail();
    const container = view.container;

    fireEvent.click(tile(container, PROJECT_A.id));
    await settle();
    expect(railName(container)).toBe(`${GROUP_A.name} projects`);

    // A destination that still has pins of its own: the landmark follows the
    // switcher, and the appended tile does not get a say.
    await switchGroupTo(GROUP_B.id);
    expect(railName(container)).toBe(`${GROUP_B.name} projects`);

    // The case that made this a regression rather than a nicety. With an empty
    // active group the off-group cluster is the ONLY cluster, so a label read
    // off `railClusters[0]` announced "Alpha group projects" while the
    // GroupSwitcher read "Empty group" — the rail asserting something false
    // about grouping, which is the whole of #378, on the a11y surface.
    await switchGroupTo(GROUP_EMPTY.id);
    expect(railName(container)).toBe(`${GROUP_EMPTY.name} projects`);
    expect(railName(container)).not.toContain(GROUP_A.name);
  });

  it("gives the off-group tile no chord badge, no drag slot and no reorder", async () => {
    const { view } = await mountRail();
    const container = view.container;

    fireEvent.click(tile(container, PROJECT_A.id));
    await settle();
    // In its own group the tile is an ordinary pin: chord badge, drop slot.
    expect(tile(container, PROJECT_A.id).dataset.pinnedItem).toBe("true");
    expect(tile(container, PROJECT_A.id).querySelector(".mc-project-hotkey-badge")).not.toBeNull();

    await switchGroupTo(GROUP_B.id);

    // As the off-group affordance it must claim none of that: the chords and
    // the persisted pinned order belong to the group actually being shown, and
    // B's own pin keeps digit 1.
    const off = tile(container, PROJECT_A.id);
    expect(off.dataset.pinnedItem).toBeUndefined();
    expect(off.querySelector(".mc-project-hotkey-badge")).toBeNull();
    expect(off.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(
      tile(container, PROJECT_B.id).querySelector(".mc-project-hotkey-badge")?.textContent,
    ).toBe("1");
  });

  it("folds the tile back into the ordinary rail when its own group is active again", async () => {
    const { router, view } = await mountRail();
    const container = view.container;

    fireEvent.click(tile(container, PROJECT_A.id));
    await settle();
    await switchGroupTo(GROUP_B.id);
    await switchGroupTo(GROUP_A.id);

    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_A.id}`);
    expect(ringOn(container)).toBe(PROJECT_A.id);
    expect(container.querySelectorAll(`[data-project-id="${PROJECT_A.id}"]`)).toHaveLength(1);
    expect(tile(container, PROJECT_A.id).dataset.offGroup).toBeUndefined();
    expect(tileOrNull(container, PROJECT_B.id)).toBeNull();
  });
});
