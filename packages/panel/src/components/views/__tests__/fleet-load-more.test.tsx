// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

// Sessions load in pages (#960): the counts are the Core's own totals, and a
// Load more ends each Core's list on the Fleet home and on the Core page.

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
const rows = Array.from({ length: 25 }, (_, i) => ({
  coreId: "a",
  coreLabel: "alpha",
  sessionId: `s${i}`,
  title: `Session ${i}`,
  agent: "claude-code",
  status: "finished",
  updatedAt: Date.now() - i * 1000,
}));
let pages: Record<string, { total: number; hasMore: boolean }> | undefined;
let loadingMore = new Set<string>();
const loadMore = vi.fn();
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores,
    fleet: { rows, offlineCores: [], singleCore: true, pages },
    loading: false,
    coresLoading: false,
    coresError: null,
    refreshCores: vi.fn(),
    error: null,
    refresh: vi.fn(),
    loadMore,
    loadingMore,
  }),
}));
vi.mock("~/lib/user-terminal-store", () => ({
  useUserTerminals: () => ({ togglePanel: vi.fn(), panelOpen: false }),
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
  api: { getKeybindings: async () => ({ bindings: {} }), listTasksPage: async () => ({ tasks: [], nextCursor: null }), getTaskCounts: async () => ({ byStatus: {}, byCore: {} }) },
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { CorePage } = await import("../CorePage");
const { FleetView } = await import("../FleetView");
const { writeCoreSessionsView } = await import("~/lib/core-sessions-view");

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

async function mount(which: "fleet" | "core") {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: which === "fleet" ? FleetView : () => <CorePage coreId="a" tab="sessions" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  loadMore.mockClear();
  loadingMore = new Set();
  pages = undefined;
  try {
    localStorage.clear();
  } catch {
    // no storage: nothing to reset
  }
});

describe("Fleet home paging", () => {
  it("shows the Core's total, not the rows loaded, and a Load more that asks for that Core", async () => {
    pages = { a: { total: 60, hasMore: true } };
    stubWidth(1280);
    await mount("fleet");
    expect(screen.getByText("60 active sessions across 1 Core")).toBeTruthy();
    const section = document.querySelector<HTMLElement>('[data-core-section="a"]')!;
    expect(section.parentElement?.textContent).toContain("60");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledWith("a");
  });

  it("says Loading… and disables the button while a page is in flight", async () => {
    pages = { a: { total: 60, hasMore: true } };
    loadingMore = new Set(["a"]);
    stubWidth(1280);
    await mount("fleet");
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no Load more for a Core that lists everything", async () => {
    pages = { a: { total: 25, hasMore: false } };
    stubWidth(1280);
    await mount("fleet");
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
    expect(screen.getByText("25 active sessions across 1 Core")).toBeTruthy();
  });

  it("offers no Load more and counts the rows when the Core gave no paging", async () => {
    pages = undefined;
    stubWidth(1280);
    await mount("fleet");
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
    expect(screen.getByText("25 active sessions across 1 Core")).toBeTruthy();
  });

  it("makes Load more a 44px tap target on a phone", async () => {
    pages = { a: { total: 60, hasMore: true } };
    stubWidth(390);
    await mount("fleet");
    expect(screen.getByRole("button", { name: "Load more" }).style.minHeight).toBe("44px");
  });
});

describe("Core page Sessions paging", () => {
  it("phone cards: total in the count, 44px Load more", async () => {
    pages = { a: { total: 60, hasMore: true } };
    stubWidth(390);
    await mount("core");
    expect(document.querySelector(".mc-sessions-count")?.textContent).toBe("60 sessions");
    const btn = screen.getByRole("button", { name: "Load more" });
    expect(btn.style.minHeight).toBe("44px");
    fireEvent.click(btn);
    expect(loadMore).toHaveBeenCalledWith("a");
  });

  it.each(["grid", "list"] as const)("desktop %s: Load more after the sessions", async (view) => {
    writeCoreSessionsView("a", view);
    pages = { a: { total: 60, hasMore: true } };
    stubWidth(1280);
    await mount("core");
    expect(document.querySelector(view === "grid" ? "[data-sessions-grid]" : "[data-sessions-list]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledWith("a");
  });

  it("shows no Load more when there is nothing further", async () => {
    pages = { a: { total: 25, hasMore: false } };
    stubWidth(390);
    await mount("core");
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
    expect(document.querySelector(".mc-sessions-count")?.textContent).toBe("25 sessions");
  });
});
