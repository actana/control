// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { Session } from "~/db/schema";

// #960: the workspace list is the Core's first page. A Session beyond it is
// asked for by id; the panel bridge is the edge, the terminal store the seam.

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
const listSessionRows = vi.fn();
vi.mock("~/lib/panel-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/panel-bridge")>()),
  getPanelBridge: () => ({ listSessionRows }),
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
let setActive: (id: string | null) => void = () => undefined;
let openEntries: Session[] = [];
vi.mock("~/lib/terminal-store", async () => {
  const { useState } = await import("react");
  return {
  useTerminals: () => {
    const [activeId, setActiveId] = useState<string | null>(null);
    setActive = setActiveId;
    return {
    sessions: openEntries.map((s) => ({ sessionId: s.id, coreId: "a", session: s })),
    gridView,
    setGridView,
    activeSessionIdFor: () => activeId,
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
    };
  },
  };
});

const { RouterProvider, createRootRoute, createRouter, createMemoryHistory } = await import(
  "@tanstack/react-router"
);
const { readPendingSessionOpen, requestSessionOpen } = await import("~/lib/session-notification-store");
const { queryKeys } = await import("~/queries");
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

let qc: QueryClient;
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
      <QueryClientProvider client={qc}>
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
  listSessionRows.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  openEntries = [];
  sessionRows = [session("s1", "running", "Implement #558"), session("s2", "finished", "Consult on PR")];
  stubWidth(390);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const snap = (id: string) => ({
  sessionId: id,
  title: `Far ${id}`,
  titleManuallySet: false,
  claudeSessionId: null,
  agent: "claude-code",
  status: "finished",
  pinned: false,
  archived: false,
  icon: null,
  updatedAt: 3,
});

describe("opening a Session beyond the first page (#960)", () => {
  it("asks the Core for that one row, adds it to the bucket and opens it", async () => {
    listSessionRows.mockResolvedValue({ sessions: [snap("far")], archivedCount: 0, nextCursor: null, total: 1 });
    requestSessionOpen("a", "far");

    await mount();

    await vi.waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
    expect(listSessionRows).toHaveBeenCalledWith("a", { limit: 1, ids: ["far"], archived: false });
    expect((toggle.mock.calls[0]![1] as Session).id).toBe("far");
    expect(qc.getQueryData<Session[]>(queryKeys.sessions("a"))?.map((s) => s.id)).toContain("far");
    expect(readPendingSessionOpen("a")).toBeNull();
  });

  it("clears the request as stale when the Core does not have the Session", async () => {
    listSessionRows.mockResolvedValue({ sessions: [], archivedCount: 0, nextCursor: null, total: 0 });
    requestSessionOpen("a", "gone");

    await mount();

    await vi.waitFor(() => expect(readPendingSessionOpen("a")).toBeNull());
    expect(listSessionRows).toHaveBeenCalledWith("a", { limit: 1, ids: ["gone"], archived: false });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("does not ask the Core for a Session the first page already holds", async () => {
    requestSessionOpen("a", "s1");

    await mount();

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(listSessionRows).not.toHaveBeenCalled();
  });
});

describe("an open Session that fell out of the first page (#960)", () => {
  it("deselecting it does not yank the operator into another Session", async () => {
    const far = session("far", "finished", "Far one");
    openEntries = [far];
    listSessionRows.mockResolvedValue({ sessions: [snap("far")], archivedCount: 0, nextCursor: null, total: 1 });
    await mount();
    await act(async () => setActive("far"));
    await act(async () => setActive(null));

    await vi.waitFor(() => expect(listSessionRows).toHaveBeenCalledWith("a", { limit: 1, ids: ["far"], archived: false }));
    await act(async () => undefined);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("still hands over a replacement when the Core no longer has the Session", async () => {
    openEntries = [session("far", "finished", "Far one")];
    listSessionRows.mockResolvedValue({ sessions: [], archivedCount: 0, nextCursor: null, total: 0 });
    await mount();
    await act(async () => setActive("far"));
    await act(async () => setActive(null));

    await vi.waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
  });
});
