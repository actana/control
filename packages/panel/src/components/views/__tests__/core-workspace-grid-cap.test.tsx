// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";

// #895: opening the grid must never fan out to every Session of a Core. The
// terminal store is the seam we assert against (what gets materialized).

const now = Date.now();
const session = (id: string, status: string, extra: Partial<Session> = {}) =>
  ({
    id,
    coreId: "a",
    title: `Session ${id}`,
    agent: "claude-code",
    status,
    archived: false,
    pinned: false,
    preview: "",
    icon: null,
    createdAt: now - 1000,
    updatedAt: now - 120_000,
    ...extra,
  }) as unknown as Session;

let sessionRows: Session[] = [];
const rehydrate = vi.fn();
const setGridView = vi.fn();
const toggleGridView = vi.fn();
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
  NewHarnessDialog: () => null,
}));
vi.mock("~/components/views/SessionGrid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/views/SessionGrid")>()),
  SessionGrid: () => <div data-testid="session-grid" />,
}));
vi.mock("~/lib/terminal-store", () => ({
  useTerminals: () => ({
    sessions: [],
    gridView,
    setGridView,
    toggleGridView,
    activeSessionIdFor: () => null,
    openSession: vi.fn(),
    focusGridSession: vi.fn(),
    syncSession: vi.fn(),
    rehydrate,
    toggle: vi.fn(),
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
const { Route } = await import("~/routes/cores.$coreId_.workspace");

function stubWidth(width: number) {
  vi.stubGlobal("innerWidth", width);
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

const openedIds = () => rehydrate.mock.calls.map(([, s]) => (s as Session).id);

beforeEach(() => {
  gridView = false;
  rehydrate.mockClear();
  setGridView.mockClear();
  toggleGridView.mockClear();
  stubWidth(1440);
  // 200 Sessions: mostly finished, a few running at the far end of the list.
  sessionRows = [
    ...Array.from({ length: 190 }, (_, i) => session(`done-${i}`, "finished", { updatedAt: now - i })),
    ...Array.from({ length: 5 }, (_, i) => session(`run-${i}`, "running", { updatedAt: now - 500_000 - i })),
    ...Array.from({ length: 5 }, (_, i) => session(`idle-${i}`, "ready", { updatedAt: now - 10 - i })),
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("enterGridView (#895)", () => {
  it("opens at most the cap out of 200 Sessions, running ones first, finished never", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Grid view — show all sessions" }));
    });
    expect(setGridView).toHaveBeenCalledWith(true);
    const ids = openedIds();
    expect(ids).toHaveLength(8);
    expect(ids.slice(0, 5).sort()).toEqual(["run-0", "run-1", "run-2", "run-3", "run-4"]);
    expect(ids.some((id) => id.startsWith("done-"))).toBe(false);
  });
});

describe("session.gridView hotkey (#895)", () => {
  const press = (target: Element) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "A", ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );

  it("toggles the grid from the page body", async () => {
    await mount();
    await act(async () => {
      press(document.body);
    });
    expect(setGridView).toHaveBeenCalledWith(true);
  });

  it("is ignored while focus is inside a terminal's text area", async () => {
    await mount();
    const host = document.createElement("div");
    host.className = "xterm";
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    host.appendChild(textarea);
    document.body.appendChild(host);
    textarea.focus();
    await act(async () => {
      press(textarea);
    });
    expect(setGridView).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();
    host.remove();
  });
});
