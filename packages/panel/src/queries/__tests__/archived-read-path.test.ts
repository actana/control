import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreLinkSessionRow } from "@actana/sdk/core";

/**
 * Where the Archived view's contents come from (ADR 0019).
 *
 * A Core sends its archived rows over a frame of their own, and the number of
 * them rides the active answer as a scalar — so the Archived tab can be gated
 * and labelled while the active view is showing, without an archived row
 * having been fetched.
 */

const listSessionRows = vi.fn();
const listArchivedSessions = vi.fn();

vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({ listSessionRows, listArchivedSessions }),
}));

const { archivedSessionsQueryOptions, queryKeys, sessionsQueryOptions } = await import("~/queries");

function snapshot(over: Partial<CoreLinkSessionRow> = {}): CoreLinkSessionRow {
  return {
    sessionId: "t1",
    title: "restock",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1,
    ...over,
  };
}

describe("the archived read path", () => {
  let qc: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("parks the archived count from the sessions answer where the Archived tab reads it", async () => {
    listSessionRows.mockResolvedValue({ sessions: [snapshot()], archivedCount: 3 });

    const sessions = await qc.fetchQuery(sessionsQueryOptions("core_a"));

    expect(sessions.map((t) => t.id)).toEqual(["t1"]);
    expect(qc.getQueryData(queryKeys.coreArchivedSessionCount("core_a"))).toBe(3);
    // Knowing the count cost no archived rows.
    expect(listArchivedSessions).not.toHaveBeenCalled();
  });

  it("asks the Core for its sessions with no project to name", async () => {
    listSessionRows.mockResolvedValue({ sessions: [], archivedCount: 0 });

    await qc.fetchQuery(sessionsQueryOptions("core_a"));

    expect(listSessionRows).toHaveBeenCalledWith("core_a");
  });

  it("keeps each Core's count in its own bucket", async () => {
    listSessionRows.mockResolvedValueOnce({ sessions: [], archivedCount: 3 });
    listSessionRows.mockResolvedValueOnce({ sessions: [], archivedCount: 9 });

    await qc.fetchQuery(sessionsQueryOptions("core_a"));
    await qc.fetchQuery(sessionsQueryOptions("core_b"));

    expect(qc.getQueryData(queryKeys.coreArchivedSessionCount("core_a"))).toBe(3);
    expect(qc.getQueryData(queryKeys.coreArchivedSessionCount("core_b"))).toBe(9);
  });

  it("fetches the archived rows over their own frame, scoped to the Core", async () => {
    listArchivedSessions.mockResolvedValue([snapshot({ sessionId: "old", archived: true })]);

    const rows = await qc.fetchQuery(archivedSessionsQueryOptions("core_a", { enabled: true }));

    expect(listArchivedSessions).toHaveBeenCalledWith("core_a");
    expect(rows).toEqual([expect.objectContaining({ id: "old", archived: true })]);
    expect(listSessionRows).not.toHaveBeenCalled();
  });

  it("keeps the archived rows out of the active list's cache bucket", async () => {
    listSessionRows.mockResolvedValue({ sessions: [snapshot()], archivedCount: 1 });
    listArchivedSessions.mockResolvedValue([snapshot({ sessionId: "old", archived: true })]);

    await qc.fetchQuery(sessionsQueryOptions("core_a"));
    await qc.fetchQuery(archivedSessionsQueryOptions("core_a", { enabled: true }));

    const active = qc.getQueryData<Array<{ id: string }>>(queryKeys.sessions("core_a"));
    expect(active?.map((t) => t.id)).toEqual(["t1"]);
  });

  it("does not read a Core's rows before there is a Core", () => {
    expect(sessionsQueryOptions("").enabled).toBe(false);
    expect(sessionsQueryOptions("core_a").enabled).toBe(true);
  });

  it("surfaces an unreachable Core as a query error, like the active list does", async () => {
    listArchivedSessions.mockRejectedValue(new Error("core_a is unreachable"));

    await expect(
      qc.fetchQuery(archivedSessionsQueryOptions("core_a", { enabled: true })),
    ).rejects.toThrow("core_a is unreachable");
  });
});
