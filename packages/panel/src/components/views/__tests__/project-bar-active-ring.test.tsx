// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectWithCounts } from "~/shared/projects";

// Issue 376. The rail is memoised and its only prop is `coreId`, so a click on
// another pin of the SAME Core changes nothing the memo can see: same props,
// same query data, only the route moved. Reading the route off `useRouter()`
// (a plain snapshot that notifies nobody) therefore left the accent ring
// parked on the previously clicked pin until some unrelated render — a hover,
// a query refetch — happened to repaint the bar.
//
// So this suite drives a REAL TanStack router rather than a stubbed one: the
// point under test is whether the component subscribes to route state, and a
// hand-rolled router stub would answer that question for it.

const invalidateQueries = vi.fn(async () => {});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));
vi.mock("~/queries", () => ({
  useProjects: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
  useSettings: () => ({ data: undefined }),
  queryKeys: { projects: ["projects"], groups: ["groups"], project: (id: string) => ["project", id] },
}));
// Both pins come off one Core, which is the shape the bug needs: clicking
// between them changes only the route.
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [] }),
  useRemotePinnedProjects: () => ({ projects: remotePinned, refresh: vi.fn() }),
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
      activeGroup: actual.ACTIVE_GROUP_ALL,
      setActiveGroup: vi.fn(),
      groups: [],
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

const CORE_ID = "core_alpha";

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
    coreId: CORE_ID,
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

const PROJECT_A = makeProject({ id: "p_alpha", name: "Alpha", pinnedOrder: 0 });
const PROJECT_B = makeProject({ id: "p_beta", name: "Beta", pinnedOrder: 1 });

/** What `useRemotePinnedProjects` hands the bar for the current test. */
let remotePinned: ProjectWithCounts[] = [];

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
  remotePinned = [PROJECT_A, PROJECT_B];
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

/** The project the accent ring currently sits on, or null when it is hidden. */
function ringOn(container: HTMLElement): string | null {
  return container.querySelector("[data-active-project-id]")?.getAttribute("data-active-project-id") ?? null;
}

function tile(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-project-id="${id}"]`);
  if (!el) throw new Error(`no rail tile for ${id}`);
  return el;
}

afterEach(() => {
  cleanup();
  remotePinned = [];
  vi.clearAllMocks();
});

describe("ProjectBar active ring", () => {
  it("moves to the second pin of the same Core as soon as the URL is that project's route", async () => {
    const { router, view } = await mountRail();
    const container = view.container;

    fireEvent.click(tile(container, PROJECT_A.id));
    await settle();
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_A.id}`);
    expect(ringOn(container)).toBe(PROJECT_A.id);

    // The same-Core click the issue is about: nothing but the route changes,
    // so no hover and no query refresh gets a chance to repaint the bar.
    fireEvent.click(tile(container, PROJECT_B.id));
    await settle();

    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_B.id}`);
    // Same assertion point as the URL check above — the ring has to have moved
    // by the time the route reads as B, not one stray render later.
    expect(ringOn(container)).toBe(PROJECT_B.id);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("keeps the ring following a plain route change with no click at all", async () => {
    const { router, view } = await mountRail();
    const container = view.container;

    // A navigation the rail did not initiate (a hotkey, a link elsewhere in
    // the shell) has to move the ring too — the subscription, not the click
    // handler, is what makes that work.
    await act(async () => {
      await router.navigate({
        to: "/projects/$id",
        params: { id: PROJECT_B.id },
        search: { coreId: CORE_ID },
      });
    });
    await settle();

    expect(ringOn(container)).toBe(PROJECT_B.id);
  });

  it("routes a Core pin click with its owning coreId in the search", async () => {
    const { router, view } = await mountRail();

    fireEvent.click(tile(view.container, PROJECT_B.id));
    await settle();

    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_B.id}`);
    expect(router.state.location.search).toEqual({ coreId: CORE_ID });
    expect(router.state.location.searchStr).toContain(`coreId=${CORE_ID}`);
  });
});
