// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

// #832: on a phone the Sessions tab hides the Core header (and with it the
// terminal toggle), so its toolbar carries a Terminals button.

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
const togglePanel = vi.fn();
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores,
    fleet: { rows: [], offlineCores: [], singleCore: false },
    loading: false,
    coresLoading: false,
    coresError: null,
    refreshCores: vi.fn(),
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
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  togglePanel.mockClear();
  window.localStorage.clear();
});

describe("Core > Sessions terminals entry point", () => {
  it("phone: a Terminals button opens the panel from Core › Sessions", async () => {
    stubWidth(390);
    await mount();
    const button = screen.getByRole("button", { name: "Terminals" });
    await act(async () => button.click());
    expect(togglePanel).toHaveBeenCalledOnce();
  });

  it("desktop: the Sessions toolbar has no Terminals button (the header toggle is there)", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: "Terminals" })).toBeNull();
    expect(screen.getByRole("button", { name: "Toggle terminal" })).toBeTruthy();
  });
});
