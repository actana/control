// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const syncSession = vi.fn();
const rehydrate = vi.fn();
let gridProps: { pinnedSessionIds?: ReadonlySet<string> } = {};
let gridButtonRows: readonly Session[] = [];
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
  SessionGrid: (props: { pinnedSessionIds?: ReadonlySet<string> }) => {
    gridProps = props;
    return <div data-testid="session-grid" />;
  },
}));
vi.mock("~/components/views/GridLayoutButton", () => ({
  GridLayoutButton: ({ sessionRows }: { sessionRows?: readonly Session[] }) => {
    gridButtonRows = sessionRows ?? [];
    return null;
  },
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
    syncSession,
    rehydrate,
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
  syncSession.mockClear();
  rehydrate.mockClear();
  gridProps = {};
  gridButtonRows = [];
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

describe("the workspace list past the first page (#960)", () => {
  const seedPage = (total: number, nextCursor: string | null) =>
    qc.setQueryData(queryKeys.sessionPage("a"), { total, nextCursor });
  const scopeCount = (label: string) =>
    screen.getByText(label, { selector: ".mc-ws-scope button" }).querySelector(".mc-ws-scope-count")?.textContent;

  it("shows the Core's true Active count and a Load more that reaches row 101", async () => {
    seedPage(150, "c1");
    listSessionRows.mockImplementation(async (_core: string, page: { cursor?: string }) =>
      page.cursor
        ? { sessions: [snap("row101")], archivedCount: 0, nextCursor: null, total: 150 }
        : { sessions: [], archivedCount: 0, nextCursor: "c1", total: 150 },
    );
    await mount();

    expect(scopeCount("Active")).toBe("150");
    expect(screen.queryByText("Far row101")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more" })));

    expect(listSessionRows).toHaveBeenCalledWith("a", { limit: 100, archived: false, cursor: "c1" });
    expect(await screen.findByText("Far row101")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    // r3: the row Load more added opens like any other.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Far row101" })));
    expect(openSession).toHaveBeenCalledWith("a", expect.objectContaining({ id: "row101" }));
    // ...and its open terminal keeps following the Core's row.
    expect(syncSession).toHaveBeenCalledWith(expect.objectContaining({ id: "row101" }));
  });

  it("refreshes the rows Load more appended when the Core's list is invalidated, and drops them on a Core switch", async () => {
    seedPage(150, "c1");
    const answers = [
      { sessions: [], archivedCount: 0, nextCursor: "c1", total: 150 }, // span read: page 1 (cursor only)
      { sessions: [snap("row101")], archivedCount: 0, nextCursor: null, total: 150 },
    ];
    listSessionRows.mockImplementation(async (_core: string, page: { cursor?: string }) =>
      page.cursor ? answers[1]! : answers[0]!,
    );
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more" })));
    expect(await screen.findByText("Far row101")).toBeTruthy();

    // The Core now says that Session was archived.
    answers[1] = { sessions: [{ ...snap("row101"), archived: true }], archivedCount: 1, nextCursor: null, total: 149 };
    await act(async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.sessions("a") });
    });
    await vi.waitFor(() => expect(screen.queryByText("Far row101")).toBeNull());
  });

  it("lists a pinned Session that sits past the first page, by asking the Core for the pinned rows", async () => {
    seedPage(150, "c1");
    listSessionRows.mockImplementation(async (_core: string, page: { pinned?: boolean }) =>
      page.pinned
        ? { sessions: [{ ...snap("pinned-far"), pinned: true }], archivedCount: 0, nextCursor: null, total: 1 }
        : { sessions: [], archivedCount: 0, nextCursor: null, total: 150 },
    );
    await mount();

    expect(await screen.findByText("Far pinned-far")).toBeTruthy();
    expect(listSessionRows).toHaveBeenCalledWith("a", { limit: 100, archived: false, pinned: true });
    expect(scopeCount("Pinned")).toBe("1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Far pinned-far" })));
    expect(openSession).toHaveBeenCalledWith("a", expect.objectContaining({ id: "pinned-far" }));
  });

  it("hands the grid the pinned Session past the first page, for its Pinned filter and picker", async () => {
    stubWidth(1400);
    gridView = true;
    openEntries = [session("s1", "running", "Implement #558")];
    seedPage(150, "c1");
    listSessionRows.mockImplementation(async (_core: string, page: { pinned?: boolean }) =>
      page.pinned
        ? { sessions: [{ ...snap("pinned-far"), pinned: true }], archivedCount: 0, nextCursor: null, total: 1 }
        : { sessions: [], archivedCount: 0, nextCursor: null, total: 150 },
    );
    await mount();

    await vi.waitFor(() => expect(gridProps.pinnedSessionIds?.has("pinned-far")).toBe(true));
    expect(gridButtonRows.map((r) => r.id)).toContain("pinned-far");
  });

  it("reopens a persisted active Session that is past the first page, by asking the Core for it", async () => {
    listSessionRows.mockResolvedValue({ sessions: [snap("far")], archivedCount: 0, nextCursor: null, total: 1 });
    await mount();
    await act(async () => setActive("far"));

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledWith("a", expect.objectContaining({ id: "far" })));
  });

  it("keeps an open Session that is in no loaded page in step with the Core's row", async () => {
    openEntries = [session("far", "running", "Far one")];
    listSessionRows.mockResolvedValue({
      sessions: [{ ...snap("far"), status: "needs-input" }],
      archivedCount: 0,
      nextCursor: null,
      total: 1,
    });
    await mount();

    await vi.waitFor(() =>
      expect(syncSession).toHaveBeenCalledWith(expect.objectContaining({ id: "far", status: "needs-input" })),
    );
  });

  it("cycles from an active Session past the first page", async () => {
    stubWidth(1400);
    seedPage(150, "c1");
    listSessionRows.mockImplementation(async (_core: string, page: { cursor?: string }) =>
      page.cursor
        ? { sessions: [snap("row101")], archivedCount: 0, nextCursor: null, total: 150 }
        : { sessions: [], archivedCount: 0, nextCursor: "c1", total: 150 },
    );
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more" })));
    await screen.findByText("Far row101");
    await act(async () => setActive("row101"));
    toggle.mockClear();

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "]", code: "BracketRight", ctrlKey: true, metaKey: true, shiftKey: true });
    });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing more when the first page holds every Session", async () => {
    seedPage(2, null);
    await mount();

    expect(scopeCount("Active")).toBe("2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(listSessionRows).not.toHaveBeenCalled();
  });
});
