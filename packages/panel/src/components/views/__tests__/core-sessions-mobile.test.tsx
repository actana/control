// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import { readCoreSessionsView, writeCoreSessionsView } from "~/lib/core-sessions-view";

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
    dial: { coreId: "a", state: "connected", lastSeenAt: 1, coreVersion: "v3" },
    sharedFolder: { state: "attached" },
  } as CoreWithDial,
];
const now = Date.now();
const row = (id: string, status: string, title: string, agent: string) => ({
  coreId: "a",
  coreLabel: "alpha",
  sessionId: id,
  title,
  agent,
  status,
  updatedAt: now - 120_000,
});
const fleet = {
  rows: [
    row("s1", "running", "Implement issue 558", "claude-code"),
    row("s2", "needs-input", "Migrate sessions table", "codex"),
    row("s3", "finished", "Consult on PR", "codex"),
  ],
  offlineCores: [],
  singleCore: false,
};
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

describe("Core Sessions on compact screens", () => {
  it("phone: lists each Session as a card with status, harness, title and time", async () => {
    stubWidth(390);
    await mount();
    const cards = document.querySelectorAll("[data-session-card]");
    expect(cards.length).toBe(3);
    const first = cards[0] as HTMLElement;
    expect(first.tagName).toBe("BUTTON");
    expect(first.textContent).toContain("Running");
    expect(first.textContent).toContain("claude-code");
    expect(first.textContent).toContain("Implement issue 558");
    expect(first.textContent).toContain("2 minutes ago");
    expect((cards[1] as HTMLElement).textContent).toContain("Needs input");
    expect((cards[2] as HTMLElement).textContent).toContain("Finished");
  });

  it("phone: tapping a card opens the workspace for that Session", async () => {
    stubWidth(390);
    const router = await mount();
    await act(async () => {
      (document.querySelectorAll("[data-session-card]")[1] as HTMLElement).click();
    });
    expect(router.state.location.pathname).toContain("workspace");
  });

  it("phone: shows the session count, the Core status line and a New session button", async () => {
    stubWidth(390);
    await mount();
    expect(screen.getByText("3 sessions")).toBeTruthy();
    expect(screen.getByText(/online v3 · shared attached/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New session/ })).toBeTruthy();
    // The cards are the only layout here: there is no Grid/List switch to show.
    expect(screen.queryByRole("button", { name: /view/i })).toBeNull();
  });

  it("phone: the view toggle does not change the stored desktop view", async () => {
    writeCoreSessionsView("a", "grid");
    stubWidth(390);
    await mount();
    expect(screen.queryByRole("button", { name: "Grid view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "List view" })).toBeNull();
    expect(readCoreSessionsView("a")).toBe("grid");
  });

  it("tablet: cards sit in two columns", async () => {
    stubWidth(800);
    await mount();
    const grid = document.querySelector("[data-sessions-cards]") as HTMLElement;
    expect(grid.getAttribute("data-columns")).toBe("2");
    stubWidth(390);
    cleanup();
    await mount();
    expect((document.querySelector("[data-sessions-cards]") as HTMLElement).getAttribute("data-columns")).toBe("1");
  });

  it("desktop: Sessions toolbar and list are unchanged", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Grid view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "List view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New session/ })).toBeTruthy();
    expect(document.querySelector("[data-sessions-list]")).toBeTruthy();
    expect(document.querySelector("[data-sessions-cards]")).toBeNull();
    expect(document.querySelector("[data-session-card]")).toBeNull();
    expect(screen.queryByText("2 sessions")).toBeNull();
    expect(document.querySelector("[data-core-status-line]")).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "Grid view" }).click();
    });
    expect(document.querySelector("[data-sessions-grid]")).toBeTruthy();
    expect(document.querySelector("[data-sessions-list]")).toBeNull();
  });
});
