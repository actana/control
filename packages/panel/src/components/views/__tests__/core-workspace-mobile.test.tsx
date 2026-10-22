// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";

// Core › Workspace on compact screens (#832, screen M27). matchMedia and the
// Core link are the edges; the terminal store is the seam we assert against.

const now = Date.now();
const session = (id: string, status: string, title: string, extra: Partial<Session> = {}) =>
  ({
    id,
    coreId: "a",
    title,
    agent: "claude-code",
    status,
    archived: false,
    pinned: false,
    preview: `tail of ${title}`,
    icon: null,
    createdAt: now - 1000,
    updatedAt: now - 120_000,
    ...extra,
  }) as unknown as Session;

let sessionRows: Session[] = [];
const openSession = vi.fn();
const focusGridSession = vi.fn();
const setGridView = vi.fn();
const toggle = vi.fn();
let gridView = false;

vi.mock("~/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/queries")>()),
  useSessions: () => ({ data: sessionRows, isLoading: false, isError: false, refetch: vi.fn() }),
  useArchivedSessions: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useCoreArchivedSessionCount: () => 0,
  useHookToken: () => undefined,
  useSettings: () => ({ data: undefined }),
}));
vi.mock("~/lib/api", () => ({ api: { getKeybindings: async () => ({ bindings: {} }) } }));
vi.mock("~/lib/use-core-live-queries", () => ({ useCoreLiveQueries: () => undefined }));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [{ id: "a", label: "alpha" }] }),
}));
vi.mock("~/lib/use-events", () => ({ useServerEvents: () => undefined }));
vi.mock("~/lib/cli-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/cli-availability")>()),
  useCliAvailability: () => ({}),
}));
vi.mock("~/lib/prefetch-terminal-modules", () => ({ prefetchTerminalModules: async () => undefined }));
vi.mock("~/components/views/NewHarnessDialog", () => ({
  NewHarnessDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="New session" /> : null),
}));
vi.mock("~/components/views/SessionGrid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/views/SessionGrid")>()),
  SessionGrid: () => <div data-testid="session-grid" />,
}));
vi.mock("~/lib/terminal-store", () => ({
  useTerminals: () => ({
    sessions: sessionRows.map((s) => ({ sessionId: s.id, coreId: "a", session: s })),
    gridView,
    setGridView,
    activeSessionIdFor: () => null,
    openSession,
    focusGridSession,
    syncSession: vi.fn(),
    rehydrate: vi.fn(),
    toggle,
    close: vi.fn(),
    requestNewRow: vi.fn(),
    requestCloneInsertAfter: vi.fn(),
    setActiveSession: vi.fn(),
    activeFor: () => null,
    adoptSessionId: vi.fn(),
    deselect: vi.fn(),
    getGridFocusedSessionId: () => null,
  }),
}));

const { RouterProvider, createRootRoute, createRouter, createMemoryHistory } = await import(
  "@tanstack/react-router"
);
const { requestSessionOpen } = await import("~/lib/session-notification-store");
const { Route } = await import("~/routes/cores.$coreId_.workspace");

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
  Route.update({
    id: "/cores/$coreId_/workspace",
    path: "/cores/$coreId/workspace",
    getParentRoute: () => root,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([Route]),
    history: createMemoryHistory({ initialEntries: ["/cores/a/workspace"] }),
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

beforeEach(() => {
  gridView = false;
  openSession.mockClear();
  focusGridSession.mockClear();
  toggle.mockClear();
  sessionRows = [
    session("s1", "running", "Implement #558"),
    session("s2", "needs-input", "Migrate sessions table", { pinned: true }),
    session("s3", "finished", "Consult on PR"),
    session("s4", "ready", "Triage CI"),
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Core workspace on compact screens", () => {
  it("phone: Sessions are stacked in one column", async () => {
    stubWidth(390);
    await mount();
    const list = document.querySelector("[data-ws-stack]") as HTMLElement;
    expect(list).toBeTruthy();
    expect(list.querySelectorAll("[data-ws-card]").length).toBe(4);
    expect(document.querySelector("[data-grid-columns]")).toBeNull();
    const card = list.querySelector("[data-ws-card]") as HTMLElement;
    expect(within(card).getByText("Needs input")).toBeTruthy();
  });

  it("phone: the scope control shows Active and Pinned with counts and switches scope", async () => {
    stubWidth(390);
    await mount();
    const active = screen.getByRole("button", { name: /^Active\s*4$/ });
    const pinned = screen.getByRole("button", { name: /^Pinned\s*1$/ });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(pinned);
    });
    expect(pinned.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-ws-card]").length).toBe(1);
    expect(screen.getByText("Migrate sessions table")).toBeTruthy();
  });

  it("phone: New opens the New session dialog", async () => {
    stubWidth(390);
    await mount();
    expect(screen.queryByRole("dialog", { name: "New session" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
    });
    expect(screen.getByRole("dialog", { name: "New session" })).toBeTruthy();
  });

  it("phone: tapping a card's open button activates that Session", async () => {
    stubWidth(390);
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Triage CI" }));
    });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0]![0]).toBe("a");
    expect((openSession.mock.calls[0]![1] as Session).id).toBe("s4");
  });

  it("phone: the card shows the Session's live tail", async () => {
    stubWidth(390);
    await mount();
    expect(screen.getByText("tail of Triage CI")).toBeTruthy();
  });

  it("phone: grid toggle is hidden and the stacked list shows even if grid view was on", async () => {
    stubWidth(390);
    gridView = true;
    await mount();
    expect(screen.queryByRole("button", { name: /grid view/i })).toBeNull();
    expect(screen.queryByTestId("session-grid")).toBeNull();
    expect(document.querySelectorAll("[data-ws-card]").length).toBe(4);
    expect(screen.queryByRole("button", { name: "Session actions" })).toBeNull();
  });

  it("phone: a pending Session open activates the Session even if grid view was on", async () => {
    stubWidth(390);
    gridView = true;
    requestSessionOpen("a", "s4");
    await mount();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle.mock.calls[0]![0]).toBe("a");
    expect((toggle.mock.calls[0]![1] as Session).id).toBe("s4");
    expect(focusGridSession).not.toHaveBeenCalled();
  });

  it("tablet: uses the same stacked list", async () => {
    stubWidth(800);
    await mount();
    expect(document.querySelector("[data-ws-stack]")).toBeTruthy();
  });

  it("phone: pin stays reachable on the card", async () => {
    stubWidth(390);
    await mount();
    expect(screen.getByRole("button", { name: "Pin Implement #558" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive Implement #558" })).toBeTruthy();
  });

  it("desktop: workspace unchanged", async () => {
    await mount();
    expect(document.querySelector("[data-ws-stack]")).toBeNull();
    expect(document.querySelector("[data-ws-card]")).toBeNull();
    expect(document.querySelector(".mc-ws-toolbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Grid view — show all sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New session/ })).toBeTruthy();
    // Status columns: the pinned Session peels into "Pinned", the rest group by status.
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open terminal for Triage CI" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Triage CI" })).toBeNull();
  });

  it("desktop: scope toggle shows once grid view is on", async () => {
    gridView = true;
    await mount();
    expect(screen.getByRole("button", { name: /Change session filter/ })).toBeTruthy();
    expect(screen.getByTestId("session-grid")).toBeTruthy();
  });
});
