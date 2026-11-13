// @vitest-environment jsdom
//
// Fleet sessions in pages (#960): the first page only, Load more with the
// Core's cursor, refreshes that keep what was loaded, and a Core that cannot
// page. The panel bridge is the one mocked edge; it answers like a Core would,
// from a mutable list, with the cursor an offset into it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CoreLinkSessionRow } from "@actana/sdk/core";

type Page = { limit: number; cursor?: string; archived?: boolean };
type Msg = { coreId: string; event: { kind: string } };

const h = vi.hoisted(() => ({
  eventHandlers: new Set<(msg: { coreId: string; event: { kind: string } }) => void>(),
  calls: [] as { coreId: string; page?: Page }[],
  /** Each Core's list, already in the Core's order. */
  lists: {} as Record<string, unknown[]>,
  /** Cores that answer the old unpaged way. */
  legacy: new Set<string>(),
}));

function session(id: string, over: Partial<CoreLinkSessionRow> = {}): CoreLinkSessionRow {
  return {
    sessionId: id,
    title: id,
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "finished",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1_000,
    ...over,
  };
}
/** `n` finished sessions, newest first: s001 is the newest. */
function many(n: number): CoreLinkSessionRow[] {
  return Array.from({ length: n }, (_, i) =>
    session(`s${String(i + 1).padStart(3, "0")}`, { updatedAt: 10_000 - i }),
  );
}

function core(id: string) {
  return {
    id,
    endpoint: `wss://${id}`,
    label: id,
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: id, state: "connected", lastSeenAt: 1_000 },
  };
}
let registered = ["core-a"];

vi.mock("~/lib/api", () => ({
  api: { listCores: async () => ({ cores: registered.map(core) }) },
}));

const bridge = {
  isConnected: () => true,
  watchCore: () => () => {},
  onEvent: (cb: (msg: Msg) => void) => {
    h.eventHandlers.add(cb);
    return () => h.eventHandlers.delete(cb);
  },
  onDialStatus: () => () => {},
  onConnectionChange: () => () => {},
  listSessionRows: async (coreId: string, page?: Page) => {
    h.calls.push({ coreId, page });
    const list = (h.lists[coreId] ?? []) as CoreLinkSessionRow[];
    if (!page || h.legacy.has(coreId)) {
      return { sessions: [...list], archivedCount: 0, nextCursor: null, total: list.length };
    }
    const start = page.cursor ? Number(page.cursor) : 0;
    const end = start + page.limit;
    return {
      sessions: list.slice(start, end),
      archivedCount: 0,
      nextCursor: end < list.length ? String(end) : null,
      total: list.length,
    };
  },
};
vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));

const { useFleetSessions, FLEET_PAGE_SIZE } = await import("~/lib/use-fleet");

async function emit(kind: string, coreId = "core-a") {
  await act(async () => {
    for (const cb of [...h.eventHandlers]) cb({ coreId, event: { kind } });
    await new Promise((r) => setTimeout(r, 0));
  });
}
const ids = (rows: { sessionId: string }[]) => rows.map((r) => r.sessionId);

beforeEach(() => {
  h.eventHandlers.clear();
  h.calls = [];
  h.lists = {};
  h.legacy.clear();
  registered = ["core-a"];
});

describe("useFleetSessions paging", () => {
  it("asks each Core for the first page only", async () => {
    registered = ["core-a", "core-b"];
    h.lists = { "core-a": many(60), "core-b": many(3) };
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(FLEET_PAGE_SIZE + 3));
    expect(FLEET_PAGE_SIZE).toBe(25);
    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) expect(call.page).toEqual({ limit: 25, archived: false });
    expect(result.current.fleet.pages?.["core-a"]).toEqual({ total: 60, hasMore: true });
    expect(result.current.fleet.pages?.["core-b"]).toEqual({ total: 3, hasMore: false });
  });

  it("Load more sends the Core's cursor, appends, and never duplicates", async () => {
    h.lists = { "core-a": many(60) };
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(25));

    act(() => result.current.loadMore!("core-a"));
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(50));
    expect(h.calls.at(-1)).toEqual({ coreId: "core-a", page: { limit: 25, archived: false, cursor: "25" } });
    expect(new Set(ids(result.current.fleet.rows)).size).toBe(50);
    expect(result.current.fleet.pages?.["core-a"]).toEqual({ total: 60, hasMore: true });

    act(() => result.current.loadMore!("core-a"));
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(60));
    expect(result.current.fleet.pages?.["core-a"]).toEqual({ total: 60, hasMore: false });
    expect(result.current.loadingMore!.has("core-a")).toBe(false);
  });

  it("dedupes a row the next page repeats because the list shifted", async () => {
    h.lists = { "core-a": many(60) };
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(25));
    // A new session lands on top: the cursor's page now starts with a row already held.
    h.lists["core-a"] = [session("new", { updatedAt: 99_999 }), ...many(60)];
    act(() => result.current.loadMore!("core-a"));
    await waitFor(() => expect(result.current.fleet.rows.length).toBeGreaterThan(25));
    const all = ids(result.current.fleet.rows);
    expect(new Set(all).size).toBe(all.length);
  });

  it("a live event refreshes loaded pages in one request and keeps them", async () => {
    h.lists = { "core-a": many(60) };
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(25));
    act(() => result.current.loadMore!("core-a"));
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(50));
    h.calls = [];

    // s040 (a loaded row) starts running: it moves to the front, nothing is lost or doubled.
    h.lists["core-a"] = [
      session("s040", { status: "running", updatedAt: 20_000 }),
      ...many(60).filter((r) => r.sessionId !== "s040"),
    ];
    await emit("session:updated");
    await waitFor(() => expect(result.current.fleet.rows[0]?.sessionId).toBe("s040"));
    expect(result.current.fleet.rows[0]?.status).toBe("running");
    expect(result.current.fleet.rows).toHaveLength(50);
    expect(new Set(ids(result.current.fleet.rows)).size).toBe(50);
    expect(h.calls).toEqual([{ coreId: "core-a", page: { limit: 50, archived: false } }]);
    expect(result.current.fleet.pages?.["core-a"]).toEqual({ total: 60, hasMore: true });
  });

  it("a refresh follows cursors when more than 100 rows are held", async () => {
    h.lists = { "core-a": many(260) };
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(25));
    for (let want = 50; want <= 125; want += 25) {
      act(() => result.current.loadMore!("core-a"));
      await waitFor(() => expect(result.current.fleet.rows).toHaveLength(want));
    }
    h.calls = [];
    await emit("session:updated");
    await waitFor(() => expect(h.calls.length).toBe(2));
    expect(h.calls[0]?.page).toEqual({ limit: 100, archived: false });
    expect(h.calls[1]?.page).toEqual({ limit: 100, archived: false, cursor: "100" });
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(200));
    expect(new Set(ids(result.current.fleet.rows)).size).toBe(200);
  });

  it("a deleted row disappears and the total follows the Core", async () => {
    h.lists = { "core-a": many(60) };
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(25));
    h.lists["core-a"] = many(60).filter((r) => r.sessionId !== "s002");
    await emit("session:deleted");
    await waitFor(() => expect(ids(result.current.fleet.rows)).not.toContain("s002"));
    expect(result.current.fleet.pages?.["core-a"]?.total).toBe(59);
  });

  it("an older Core that cannot page lists everything and offers no more", async () => {
    h.lists = { "core-a": many(40) };
    h.legacy.add("core-a");
    const { result } = renderHook(() => useFleetSessions());
    await waitFor(() => expect(result.current.fleet.rows).toHaveLength(40));
    expect(result.current.fleet.pages?.["core-a"]?.hasMore ?? false).toBe(false);
    act(() => result.current.loadMore!("core-a"));
    expect(h.calls).toHaveLength(1);
  });
});
