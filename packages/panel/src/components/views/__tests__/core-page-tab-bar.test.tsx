// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

// CorePage on compact screens carries the bottom tab bar; on desktop it keeps
// only the header's tabs. matchMedia is the edge: jsdom has none (= desktop).

const cores: CoreWithDial[] = [
  {
    id: "a",
    endpoint: "wss://x",
    label: "alpha",
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: "a", state: "connected", lastSeenAt: 1 },
  },
];
const fleet = { rows: [], offlineCores: [], singleCore: false };
const refreshCores = vi.fn();
const togglePanel = vi.fn();
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores,
    fleet,
    loading: false,
    coresLoading: false,
    coresError: null,
    refreshCores,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/lib/user-terminal-store", () => ({
  useUserTerminals: () => ({ togglePanel, panelOpen: false }),
}));
const bridge = {
  isConnected: () => true,
  listHarnessAvailability: vi.fn(async () => ({})),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
  onDialStatus: vi.fn(() => () => {}),
};
vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));
vi.mock("~/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/queries")>()),
  useSettings: () => ({ data: undefined }),
}));
vi.mock("~/lib/api", () => ({
  api: { getKeybindings: async () => ({ bindings: {} }), listTasks: async () => ({ tasks: [] }) },
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { CorePage } = await import("../CorePage");

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      media: query,
      matches: max ? width <= Number(max[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

async function mount() {
  const root = createRootRoute();
  const coreRoute = createRoute({
    getParentRoute: () => root,
    path: "/cores/$coreId",
    validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab as string | undefined }),
    component: () => <CorePage coreId="a" tab="sessions" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([coreRoute]),
    history: createMemoryHistory({ initialEntries: ["/cores/a"] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <KeybindingsProvider>
          <RouterProvider router={router} />
        </KeybindingsProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
  return router;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("CorePage tab bar", () => {
  it("CorePage shows the tab bar on compact and not on desktop", async () => {
    await mount();
    expect(screen.queryByRole("navigation", { name: "Core sections" })).toBeNull();
    cleanup();
    stubWidth(390);
    await mount();
    expect(screen.getByRole("navigation", { name: "Core sections" })).toBeTruthy();
  });

  it("tapping a tab in the bar navigates with ?tab=", async () => {
    stubWidth(390);
    const router = await mount();
    await act(async () => {
      screen.getByRole("button", { name: "Files" }).click();
    });
    expect(router.state.location.search).toMatchObject({ tab: "files" });
  });

  it("the header tablist carries the class the compact CSS hides", async () => {
    await mount();
    expect(screen.getByRole("tablist").className).toContain("mc-core-header-tabs");
  });
});
