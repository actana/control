// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";

// A Core's page: header (switcher, one status pill, tabs) and three tabs. The
// Terminal is the bottom drawer, so it must never be a tab.

let cores: CoreWithDial[] = [];
let rows: Record<string, unknown>[] = [];
const togglePanel = vi.fn();
const setHomeActive = vi.fn();

vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({
    cores,
    fleet: { rows, offlineCores: [], singleCore: false },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/lib/user-terminal-store", () => ({
  useUserTerminals: () => ({ togglePanel, panelOpen: false, setHomeActive }),
}));
vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => null }));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { CorePage } = await import("../CorePage");

function core(id: string, label: string, state: CoreWithDial["dial"]["state"] = "connected"): CoreWithDial {
  return {
    id,
    endpoint: "wss://x",
    label,
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: id, state, lastSeenAt: 1 },
  };
}

function row(over: Record<string, unknown>) {
  return {
    coreId: "a",
    coreLabel: "alpha",
    sessionId: "s1",
    projectId: "p1",
    title: "Refactor executor",
    agent: "claude-code",
    status: "running",
    updatedAt: Date.now(),
    ...over,
  };
}

async function mount(tab: "sessions" | "files" | "tasks", coreId = "a") {
  const root = createRootRoute();
  const coreRoute = createRoute({
    getParentRoute: () => root,
    path: "/cores/$coreId",
    validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab as string | undefined }),
    component: () => <CorePage coreId={coreId} tab={tab} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([coreRoute]),
    history: createMemoryHistory({ initialEntries: [`/cores/${coreId}`] }),
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
  togglePanel.mockReset();
  setHomeActive.mockReset();
  rows = [];
});

describe("CorePage", () => {
  it("has exactly three tabs, Sessions, Files and Tasks, and no Terminal tab", async () => {
    cores = [core("a", "alpha")];
    await mount("sessions");
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Sessions", "Files", "Tasks"]);
    expect(screen.queryByRole("tab", { name: /terminal/i })).toBeNull();
  });

  it("keeps the Terminal as a drawer toggle in the header, not a tab", async () => {
    cores = [core("a", "alpha")];
    await mount("sessions");
    fireEvent.click(screen.getByRole("button", { name: "Toggle terminal" }));
    expect(togglePanel).toHaveBeenCalledTimes(1);
  });

  it("claims the terminal drawer's home scope while mounted and releases it on leave", async () => {
    cores = [core("a", "alpha")];
    await mount("sessions");
    expect(setHomeActive).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(setHomeActive).toHaveBeenLastCalledWith(false);
  });

  it("shows one status pill with online, and a switcher listing every Core", async () => {
    cores = [core("a", "alpha"), core("b", "bravo")];
    await mount("sessions");
    const pills = document.querySelectorAll("[data-core-pill]");
    expect(pills.length).toBe(1);
    expect(pills[0]!.textContent).toContain("online");
    const switcher = screen.getByLabelText("Switch Core") as HTMLSelectElement;
    expect([...switcher.options].map((o) => o.textContent)).toEqual(["alpha", "bravo"]);
    expect(switcher.value).toBe("a");
  });

  it("says offline in the pill for an unreachable Core", async () => {
    cores = [core("a", "alpha", "unreachable")];
    await mount("sessions");
    expect(document.querySelector("[data-core-pill]")!.textContent).toContain("offline");
  });

  it("switches Core through the switcher", async () => {
    cores = [core("a", "alpha"), core("b", "bravo")];
    const router = await mount("sessions");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Switch Core"), { target: { value: "b" } });
    });
    expect(router.state.location.pathname).toBe("/cores/b");
  });

  it("selects a tab by navigating to ?tab=", async () => {
    cores = [core("a", "alpha")];
    const router = await mount("sessions");
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
    });
    expect(router.state.location.search).toMatchObject({ tab: "files" });
  });

  it("lists only this Core's Sessions on the Sessions tab", async () => {
    cores = [core("a", "alpha"), core("b", "bravo")];
    rows = [row({}), row({ coreId: "b", sessionId: "s2", title: "Other Core's work" })];
    await mount("sessions");
    expect(screen.getByText("Refactor executor")).toBeTruthy();
    expect(screen.queryByText("Other Core's work")).toBeNull();
  });

  it("renders placeholders for Files and Tasks", async () => {
    cores = [core("a", "alpha")];
    await mount("files");
    expect(screen.getByText(/#565/)).toBeTruthy();
    cleanup();
    await mount("tasks");
    expect(screen.getByText(/#571/)).toBeTruthy();
  });

  it("says so when the Core is not registered", async () => {
    cores = [core("a", "alpha")];
    await mount("sessions", "ghost");
    expect(screen.getByText("Core not found")).toBeTruthy();
  });
});
