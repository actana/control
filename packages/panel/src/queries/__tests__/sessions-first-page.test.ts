import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreLinkSessionRow } from "@actana/sdk/core";

// #960: the workspace's Session bucket is the Core's first page, not its history.

const listSessionRows = vi.fn();

vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({ listSessionRows }),
}));

const { WORKSPACE_SESSIONS_LIMIT, fetchSessionRowById, queryKeys, sessionsQueryOptions } = await import("~/queries");

const row = (id: string, over: Partial<CoreLinkSessionRow> = {}): CoreLinkSessionRow => ({
  sessionId: id,
  title: id,
  titleManuallySet: false,
  claudeSessionId: null,
  agent: "claude-code",
  status: "running",
  pinned: false,
  archived: false,
  icon: null,
  updatedAt: 1,
  ...over,
});

describe("the workspace Session bucket", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("asks for the first page of active Sessions only and still parks the archived count", async () => {
    listSessionRows.mockResolvedValue({
      sessions: [row("a"), row("b")],
      archivedCount: 7,
      nextCursor: "c2",
      total: 1200,
    });

    const sessions = await qc.fetchQuery(sessionsQueryOptions("core_a"));

    expect(WORKSPACE_SESSIONS_LIMIT).toBe(100);
    expect(listSessionRows).toHaveBeenCalledTimes(1);
    expect(listSessionRows).toHaveBeenCalledWith("core_a", { limit: 100, archived: false });
    expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(qc.getQueryData(queryKeys.coreArchivedSessionCount("core_a"))).toBe(7);
    // Where the page ended rides along: the true count and the cursor Load more starts from.
    expect(qc.getQueryData(queryKeys.sessionPage("core_a"))).toEqual({ total: 1200, nextCursor: "c2" });
  });

  it("still works against an older Core that answers every row with no cursor", async () => {
    const all = Array.from({ length: 150 }, (_, i) => row(`s${i}`));
    listSessionRows.mockResolvedValue({ sessions: all, archivedCount: 0, nextCursor: null });

    const sessions = await qc.fetchQuery(sessionsQueryOptions("core_a"));

    expect(sessions).toHaveLength(150);
    expect(qc.getQueryData(queryKeys.sessionPage("core_a"))).toEqual({ total: 150, nextCursor: null });
  });
});

describe("fetchSessionRowById", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks the Core for exactly that active row", async () => {
    listSessionRows.mockResolvedValue({ sessions: [row("far", { title: "old one" })], archivedCount: 0 });

    const found = await fetchSessionRowById("core_a", "far");

    expect(listSessionRows).toHaveBeenCalledWith("core_a", { limit: 1, ids: ["far"], archived: false });
    expect(found).toEqual(expect.objectContaining({ id: "far", title: "old one" }));
  });

  it("is null when the Core does not have it", async () => {
    listSessionRows.mockResolvedValue({ sessions: [], archivedCount: 0 });
    expect(await fetchSessionRowById("core_a", "gone")).toBeNull();
  });

  it("matches on id when an older Core ignores the filter and answers everything", async () => {
    listSessionRows.mockResolvedValue({ sessions: [row("x"), row("far")], archivedCount: 0, nextCursor: null });
    expect((await fetchSessionRowById("core_a", "far"))?.id).toBe("far");
    expect(await fetchSessionRowById("core_a", "nope")).toBeNull();
  });
});
