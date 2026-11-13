import { describe, expect, it, vi } from "vitest";
import { createPanelBridge } from "../panel-bridge";
import { PanelLinkClient, type PanelLinkSocketLike } from "../panel-link-client";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";

/**
 * The bridge is what UI components call. What matters here is which frame each
 * call puts on the wire and which Core it is addressed to — a write that went
 * anywhere but the owning Core would be a write the rest of the fleet never
 * sees.
 */

class FakeSocket implements PanelLinkSocketLike {
  static last: FakeSocket | null = null;

  readyState = 0;
  readonly sent: PanelLinkClientFrame[] = [];
  private handlers = new Map<string, Array<(arg: never) => void>>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as PanelLinkClientFrame);
  }
  close() {}
  addEventListener(type: string, cb: (arg: never) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  private fire(type: string, arg?: unknown) {
    for (const cb of this.handlers.get(type) ?? []) (cb as (a: unknown) => void)(arg);
  }
  accept() {
    this.readyState = 1;
    this.fire("open");
  }
  push(frame: PanelLinkServerFrame) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
}

/** A live bridge plus the socket underneath it, ready to answer one request. */
function bridged() {
  const link = new PanelLinkClient({
    url: "ws://panel.test/panel-link",
    createSocket: (url) => new FakeSocket(url),
    requestTimeoutMs: 1_000,
  });
  const socket = FakeSocket.last!;
  socket.accept();
  return { bridge: createPanelBridge(link), socket };
}

/** The frame the bridge just sent, and the reqId it is waiting on. */
function lastRequest(socket: FakeSocket) {
  const frame = socket.sent.at(-1)!;
  if (frame.t !== "core") throw new Error("expected a core frame");
  return { coreId: frame.coreId, frame: frame.frame as Record<string, unknown> };
}

describe("panel bridge — writes", () => {
  it("sends a session mutation and hands back the Core's snapshot", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.mutateSession("core_a", {
      op: "create",
      title: "restock",
      agent: "claude-code",
    });
    const sent = lastRequest(socket);
    expect(sent.coreId).toBe("core_a");
    expect(sent.frame).toMatchObject({ type: "sessionsMutate", mutation: { op: "create" } });

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "sessionsMutateResult",
        reqId: sent.frame.reqId as string,
        session: {
          sessionId: "session_9",
          title: "restock",
          titleManuallySet: false,
          claudeSessionId: null,
          agent: "claude-code",
          status: "ready",
          pinned: false,
          archived: false,
          icon: null,
          updatedAt: 3,
        },
      },
    });
    await expect(pending).resolves.toMatchObject({ sessionId: "session_9" });
  });

  it("surfaces a Core rejection as a failed call, not a result to inspect", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.mutateSession("core_a", {
      op: "update",
      sessionId: "session_9",
      title: "restock",
    });
    const sent = lastRequest(socket);
    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "error", reqId: sent.frame.reqId as string, message: "Session not found" },
    });

    await expect(pending).rejects.toThrow("Session not found");
  });
});

/**
 * The Archived view's read path (ADR 0019). Two calls, two frames: the active
 * list answers with a count of archived rows and none of them, and the rows
 * come back only when something asks for them by name.
 */
describe("panel bridge — the archived read path", () => {
  const ARCHIVED = {
    sessionId: "session_old",
    title: "last winter's stocktake",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "done",
    pinned: false,
    archived: true,
    icon: null,
    updatedAt: 1,
  };

  it("hands back the archived count alongside the active rows", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listSessionRows("core_a");
    const sent = lastRequest(socket);
    expect(sent.frame).toMatchObject({ type: "sessionRowsList" });
    expect(sent.frame).not.toHaveProperty("projectId");

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "sessionRowsListResult",
        reqId: sent.frame.reqId as string,
        sessions: [{ ...ARCHIVED, sessionId: "session_1", archived: false, status: "running" }],
        archivedCount: 4,
      },
    });
    await expect(pending).resolves.toEqual({
      sessions: [expect.objectContaining({ sessionId: "session_1" })],
      archivedCount: 4,
    });
  });

  it("fetches the archived rows over their own frame", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listArchivedSessions("core_a");
    const sent = lastRequest(socket);
    expect(sent.coreId).toBe("core_a");
    expect(sent.frame).toMatchObject({ type: "archivedSessionRowsList" });
    expect(sent.frame).not.toHaveProperty("projectId");

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "archivedSessionRowsListResult",
        reqId: sent.frame.reqId as string,
        sessions: [ARCHIVED],
      },
    });
    await expect(pending).resolves.toEqual([ARCHIVED]);
  });

  it("surfaces an unreachable Core as a failed call, like the active list does", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listArchivedSessions("core_gone");
    const sent = lastRequest(socket);
    socket.push({
      t: "core",
      coreId: "core_gone",
      frame: {
        type: "error",
        reqId: sent.frame.reqId as string,
        message: "core_gone is unreachable",
      },
    });

    await expect(pending).rejects.toThrow("core_gone is unreachable");
  });
});

/**
 * The paged Session list (#960): one page of rows with the cursor for the next
 * and the true total, and an older Core — one that refuses or ignores `limit`
 * — still lists, everything in one answer.
 */
describe("panel bridge — paged Session rows", () => {
  const ROW = {
    sessionId: "session_1",
    title: "t",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 1,
  };

  it("asks for one page with the filters and hands back nextCursor and total", async () => {
    const { bridge, socket } = bridged();
    const pending = bridge.listSessionRows("core_a", { limit: 25, cursor: "c1", status: "running", q: "fix" });
    const sent = lastRequest(socket);
    expect(sent.frame).toMatchObject({ type: "sessionRowsList", limit: 25, cursor: "c1", status: "running", q: "fix" });
    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "sessionRowsListResult",
        reqId: sent.frame.reqId as string,
        sessions: [ROW],
        archivedCount: 2,
        nextCursor: "c2",
        total: 60,
      },
    });
    await expect(pending).resolves.toEqual({ sessions: [ROW], archivedCount: 2, nextCursor: "c2", total: 60 });
  });

  it("treats a Core that answers without a total as complete: every row, no next page", async () => {
    const { bridge, socket } = bridged();
    const pending = bridge.listSessionRows("core_a", { limit: 25 });
    const sent = lastRequest(socket);
    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "sessionRowsListResult", reqId: sent.frame.reqId as string, sessions: [ROW, { ...ROW, sessionId: "session_2" }], archivedCount: 0 },
    });
    await expect(pending).resolves.toEqual({
      sessions: [ROW, { ...ROW, sessionId: "session_2" }],
      archivedCount: 0,
      nextCursor: null,
      total: 2,
    });
  });

  it("falls back to the plain frame when an older Core refuses the paging fields", async () => {
    const { bridge, socket } = bridged();
    const pending = bridge.listSessionRows("core_a", { limit: 25 });
    const first = lastRequest(socket);
    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "error", reqId: first.frame.reqId as string, message: 'sessionRowsList does not take "limit": a Session belongs to the Core' },
    });
    await vi.waitFor(() => expect(lastRequest(socket).frame.reqId).not.toBe(first.frame.reqId));
    const second = lastRequest(socket);
    expect(second.frame).toEqual({ type: "sessionRowsList", reqId: second.frame.reqId });
    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "sessionRowsListResult", reqId: second.frame.reqId as string, sessions: [ROW], archivedCount: 0 },
    });
    await expect(pending).resolves.toEqual({ sessions: [ROW], archivedCount: 0, nextCursor: null, total: 1 });
  });

  it("does not hide a real failure behind that fallback", async () => {
    const { bridge, socket } = bridged();
    const pending = bridge.listSessionRows("core_a", { limit: 25, cursor: "bad" });
    const sent = lastRequest(socket);
    socket.push({ t: "core", coreId: "core_a", frame: { type: "error", reqId: sent.frame.reqId as string, message: "invalid cursor" } });
    await expect(pending).rejects.toThrow("invalid cursor");
  });
});
