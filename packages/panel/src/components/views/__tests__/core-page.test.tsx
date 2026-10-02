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
  useUserTerminals: () => ({ togglePanel, panelOpen: false }),
}));
const bridge = {
  isConnected: () => true,
  listHarnessAvailability: vi.fn(async () => ({
    "claude-code": { status: "available", path: "/usr/bin/claude" },
  })),
  installHarness: vi.fn(async () => ({ accepted: true })),
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
const mutateSessionForCore = vi.fn();
vi.mock("~/lib/mutate-session-for-core", () => ({
  mutateSessionForCore: (...args: unknown[]) => mutateSessionForCore(...args),
}));

const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const { CorePage } = await import("../CorePage");
const { readPendingSessionOpen } = await import("~/lib/session-notification-store");
const { showRequestedSession } = await import("~/lib/open-requested-session");
const { takePendingInitialInput } = await import("~/lib/pending-initial-input");
const { __resetCliAvailabilityStoresForTests } = await import("~/lib/cli-availability");
const { __resetCoreRememberForTests } = await import("~/lib/core-remember");

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
    title: "Refactor executor",
    agent: "claude-code",
    status: "running",
    updatedAt: Date.now(),
    ...over,
  };
}

async function mount(tab: "sessions" | "files" | "tasks", coreId = "a") {
  const root = createRootRoute();
  const workspaceRoute = createRoute({
    getParentRoute: () => root,
    path: "/cores/$coreId/workspace",
    component: () => <div>workspace</div>,
  });
  const coreRoute = createRoute({
    getParentRoute: () => root,
    path: "/cores/$coreId",
    validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab as string | undefined }),
    component: () => <CorePage coreId={coreId} tab={tab} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([coreRoute, workspaceRoute]),
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
  mutateSessionForCore.mockReset();
  window.localStorage.clear();
  __resetCliAvailabilityStoresForTests();
  __resetCoreRememberForTests();
  togglePanel.mockReset();
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

  it("passes Shared folder attached and the core-link protocol version into the pill", async () => {
    cores = [
      {
        ...core("a", "alpha"),
        dial: { coreId: "a", state: "connected", lastSeenAt: 1, coreVersion: "0.19.0" },
        sharedFolder: { state: "attached", prefix: "cores/a/", keyExpiresAt: 1, error: null },
      },
    ];
    await mount("sessions");
    const pill = document.querySelector("[data-core-pill]")!;
    expect(pill.textContent).toContain("online 0.19.0");
    expect(pill.textContent).toContain("shared attached");
    expect(pill.querySelector('[title="Core link protocol version"]')).not.toBeNull();
  });

  it("passes Shared folder failed into the pill when the folder state is error", async () => {
    cores = [
      {
        ...core("a", "alpha"),
        dial: { coreId: "a", state: "connected", lastSeenAt: 1, coreVersion: "0.19.0" },
        sharedFolder: { state: "error", prefix: "cores/a/", keyExpiresAt: 1, error: "push failed" },
      },
    ];
    await mount("sessions");
    const pill = document.querySelector("[data-core-pill]")!;
    expect(pill.textContent).toContain("shared failed");
    expect(pill.textContent).toContain("0.19.0");
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

  it("renders the Files Drive for Files (a Core with no Shared folder is told so) and this Core's Tasks board under Tasks", async () => {
    cores = [core("a", "alpha")];
    await mount("files");
    expect(screen.getByText("No Shared folder yet")).toBeTruthy();
    cleanup();
    await mount("tasks");
    // The board, without the per-Core chips: the Core page is already one Core.
    expect(screen.getByRole("button", { name: "New Task" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Filter by Core" })).toBeNull();
  });

  it("says so when the Core is not registered", async () => {
    cores = [core("a", "alpha")];
    await mount("sessions", "ghost");
    expect(screen.getByText("Core not found")).toBeTruthy();
  });

  // Issue 560 R2: starting a Session from the Core page must hand the workspace
  // the Session it created, and the prompt it was started with, to spawn.
  it("starts the Session it creates: create frame, prompt staged, workspace asked to open it", async () => {
    cores = [core("a", "alpha")];
    mutateSessionForCore.mockImplementation(async (_core: string, frame: { sessionId: string }) => ({
      sessionId: frame.sessionId,
      title: "Waiting",
      titleManuallySet: false,
      icon: null,
      agent: "claude-code",
      status: "idle",
      archived: false,
      pinned: false,
      claudeSessionId: null,
      updatedAt: 1,
    }));
    const router = await mount("sessions");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /new session/i })[0]!);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^prompt$/i), { target: { value: "fix the build" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });
    await act(async () => {});

    expect(mutateSessionForCore).toHaveBeenCalledTimes(1);
    const [coreId, frame] = mutateSessionForCore.mock.calls[0]!;
    expect(coreId).toBe("a");
    expect(frame).toMatchObject({ op: "create", agent: "claude-code" });
    expect(frame).not.toHaveProperty("cwd");
    // The workspace is told which Session to open, scoped to this Core, and the
    // pane will find the prompt waiting for the first spawn.
    expect(readPendingSessionOpen("a")).toMatchObject({ sessionId: frame.sessionId, coreId: "a" });
    expect(router.state.location.pathname).toBe("/cores/a/workspace");

    // The workspace consumes that request: the terminal it creates must name
    // this Core, or the pane has no transport and never spawns the Session.
    const request = readPendingSessionOpen("a")!;
    const session = { id: request.sessionId, agent: "claude-code" } as never;
    const terminals = {
      activeFor: vi.fn(() => null),
      activeSessionIdFor: vi.fn(() => null),
      rehydrate: vi.fn(),
      toggle: vi.fn(),
    };
    showRequestedSession({ terminals, session, coreId: request.coreId });
    expect(terminals.toggle).toHaveBeenCalledWith("a", session);
    // The prompt is still staged for that spawn.
    expect(takePendingInitialInput(frame.sessionId)).toBe("fix the build");
  });

  it("opens an existing Session by id, not just the workspace", async () => {
    cores = [core("a", "alpha")];
    rows = [row({ sessionId: "s9" })];
    const router = await mount("sessions");
    await act(async () => {
      fireEvent.click(screen.getByText("Refactor executor"));
    });
    expect(readPendingSessionOpen("a")).toMatchObject({ sessionId: "s9", coreId: "a" });
    expect(router.state.location.pathname).toBe("/cores/a/workspace");
  });
});
