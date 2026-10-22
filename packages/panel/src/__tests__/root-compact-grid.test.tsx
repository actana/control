// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Shell on compact screens (#832). A grid-view flag saved from desktop
// (`mc.gridView`, per browser) must not hide the Session terminal panel on a
// phone: the Workspace route shows the stacked list there, so the panel is the
// only way to reach a Session's terminal (M21). matchMedia is the edge; the
// real terminal store provides the grid flag.

vi.mock("~/lib/fleet-context", () => ({
  FleetProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFleet: () => ({ cores: [{ id: "a", label: "alpha", dial: { state: "connected" } }], fleet: { rows: [] } }),
}));
vi.mock("~/components/views/FirstRunGate", () => ({
  FirstRunGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/views/TerminalPanel", () => ({
  TerminalPanel: () => <div data-testid="session-terminal-panel" />,
}));
vi.mock("~/components/views/UserTerminalPanel", () => ({ UserTerminalPanel: () => null }));
vi.mock("~/components/views/CoreRail", () => ({ CoreRail: () => null }));
vi.mock("~/components/views/CoresDrawer", () => ({
  CoresDrawer: () => null,
  useCoresDrawerOpen: () => [false, vi.fn()],
}));
vi.mock("~/components/views/MobileTopBar", () => ({ MobileTopBar: () => null }));
vi.mock("~/components/views/CoreTabBar", () => ({ CoreTabBar: () => null }));
vi.mock("~/components/views/ProviderUsageIndicator", () => ({ ProviderUsageIndicator: () => null }));
vi.mock("~/components/views/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("~/components/views/SessionNotificationsButton", () => ({ SessionNotificationsButton: () => null }));
vi.mock("~/components/ui/TopBar", () => ({ TopBar: () => null }));
vi.mock("~/lib/use-core-hotkeys", () => ({ useCoreHotkeys: () => undefined }));
vi.mock("~/lib/use-event-stream-reconcile", () => ({ useEventStreamReconcile: () => undefined }));
vi.mock("~/lib/use-session-finish-notifications", () => ({
  useSessionFinishNotifications: () => ({ notifications: [] }),
}));
vi.mock("~/lib/window-idle", () => ({ useWindowIdleController: () => undefined }));
vi.mock("~/lib/use-hotkey", () => ({ useHotkey: () => undefined }));
vi.mock("~/lib/api", () => ({ api: { getKeybindings: async () => ({ bindings: {} }) } }));

const { RouterProvider, createRouter, createRoute, createMemoryHistory } = await import(
  "@tanstack/react-router"
);
const { Route: rootRoute } = await import("~/routes/__root");

function stubWidth(width: number) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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

async function mountShell() {
  const workspace = createRoute({
    getParentRoute: () => rootRoute,
    path: "/cores/$coreId/workspace",
    component: () => <div data-testid="workspace-outlet" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspace]),
    history: createMemoryHistory({ initialEntries: ["/cores/a/workspace"] }),
    context: { queryClient: new QueryClient() },
  });
  const { findByTestId } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await findByTestId("workspace-outlet");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Shell with a saved grid-view flag", () => {
  it("phone: the Session terminal panel still renders when grid view was saved on", async () => {
    stubWidth(390);
    window.localStorage.setItem("mc.gridView", "1");
    await mountShell();
    expect(document.querySelector('[data-testid="session-terminal-panel"]')).toBeTruthy();
  });

  it("desktop: grid view on hides the Session terminal panel (unchanged)", async () => {
    stubWidth(1440);
    window.localStorage.setItem("mc.gridView", "1");
    await mountShell();
    expect(document.querySelector('[data-testid="session-terminal-panel"]')).toBeNull();
  });

  it("desktop: grid view off renders the Session terminal panel", async () => {
    stubWidth(1440);
    await mountShell();
    expect(document.querySelector('[data-testid="session-terminal-panel"]')).toBeTruthy();
  });
});
