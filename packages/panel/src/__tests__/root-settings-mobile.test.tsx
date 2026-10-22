// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Shell wiring for phone Settings (#835): the Cores drawer can be opened while
// Settings is open, so its Operator/Settings rows must re-target the open
// Settings, and drawer navigation must close it.

type DrawerProps = {
  onOpenSettings: (panel?: string | null) => void;
  onNavigate: () => void;
};
const drawer: { props: DrawerProps | null } = { props: null };

vi.mock("~/lib/fleet-context", () => ({
  FleetProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFleet: () => ({ cores: [{ id: "a", label: "alpha", dial: { state: "connected" } }], fleet: { rows: [] } }),
}));
vi.mock("~/components/views/FirstRunGate", () => ({
  FirstRunGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/views/TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("~/components/views/UserTerminalPanel", () => ({ UserTerminalPanel: () => null }));
vi.mock("~/components/views/CoreRail", () => ({ CoreRail: () => null }));
vi.mock("~/components/views/CoresDrawer", () => ({
  CoresDrawer: (props: DrawerProps) => {
    drawer.props = props;
    return null;
  },
  useCoresDrawerOpen: () => [false, vi.fn()],
}));
vi.mock("~/components/views/MobileTopBar", () => ({ MobileTopBar: () => null }));
vi.mock("~/components/views/CoreTabBar", () => ({ CoreTabBar: () => null }));
vi.mock("~/components/views/ProviderUsageIndicator", () => ({ ProviderUsageIndicator: () => null }));
vi.mock("~/components/views/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("~/components/views/SessionNotificationsButton", () => ({ SessionNotificationsButton: () => null }));
vi.mock("~/components/ui/TopBar", () => ({ TopBar: () => null }));
vi.mock("~/components/views/SettingsPanel", async () => {
  const React = await import("react");
  return {
    SettingsPanel: ({ initialPanel, onBack }: { initialPanel?: string | null; onBack: () => void }) => {
      const [panel] = React.useState(initialPanel ?? null);
      React.useEffect(() => {
        window.addEventListener("mc:close-settings", onBack);
        return () => window.removeEventListener("mc:close-settings", onBack);
      }, [onBack]);
      return panel ? (
        <div data-settings-page={panel} data-view="page" />
      ) : (
        <div data-testid="settings-list" data-view="list" />
      );
    },
  };
});
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
const { OPEN_SETTINGS_EVENT } = await import("~/lib/design-meta");

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
  drawer.props = null;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Shell phone Settings and the Cores drawer", () => {
  it("phone: the drawer's Operator and Settings rows re-target an open Settings", async () => {
    stubWidth(390);
    await mountShell();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: {} }));
    });
    expect(document.querySelector('[data-testid="settings-list"]')).toBeTruthy();
    await act(async () => {
      drawer.props!.onOpenSettings("operator");
    });
    const page = document.querySelector("[data-settings-page=operator]");
    expect(page?.getAttribute("data-view")).toBe("page");
    await act(async () => {
      drawer.props!.onOpenSettings(null);
    });
    expect(document.querySelector("[data-settings-page]")).toBeNull();
    expect(document.querySelector("[data-view=list]")).toBeTruthy();
  });

  it("phone: the drawer's onNavigate closes an open Settings", async () => {
    stubWidth(390);
    await mountShell();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: {} }));
    });
    expect(document.querySelector("[data-view]")).toBeTruthy();
    await act(async () => {
      drawer.props!.onNavigate();
    });
    expect(document.querySelector("[data-view]")).toBeNull();
  });

  it("phone: the drawer's Operator row opens Settings when it is closed", async () => {
    stubWidth(390);
    await mountShell();
    await act(async () => {
      drawer.props!.onOpenSettings("operator");
    });
    expect(document.querySelector("[data-settings-page=operator]")).toBeTruthy();
  });
});
