import { describe, expect, it } from "vitest";
import { createPanelBridge } from "../panel-bridge";
import { PanelLinkClient, type PanelLinkSocketLike } from "../panel-link-client";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";
import type { CoreLinkProjectSnapshot } from "@actana/shared/core-link-frames";

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

const PROJECT: CoreLinkProjectSnapshot = {
  projectId: "proj_1",
  name: "warehouse",
  path: "/srv/warehouse",
  icon: "wa",
  iconColor: "#3b6ea5",
  pinned: true,
  rememberHarnessSettings: false,
  savedHarness: null,
  savedSkipPermissions: false,
  savedBareSession: false,
  defaultGridView: false,
  updatedAt: 7,
};

describe("panel bridge — writes", () => {
  it("sends a project mutation to the Core that owns the row", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.mutateProject("core_b", { op: "pin", projectId: "proj_1", pinned: true });
    const sent = lastRequest(socket);
    expect(sent.coreId).toBe("core_b");
    expect(sent.frame).toMatchObject({
      type: "projectsMutate",
      mutation: { op: "pin", projectId: "proj_1", pinned: true },
    });

    socket.push({
      t: "core",
      coreId: "core_b",
      frame: {
        type: "projectsMutateResult",
        reqId: sent.frame.reqId as string,
        project: PROJECT,
      },
    });
    await expect(pending).resolves.toEqual(PROJECT);
  });

  it("sends a task mutation and hands back the Core's snapshot", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.mutateTask("core_a", {
      op: "create",
      projectId: "proj_1",
      title: "restock",
      agent: "claude-code",
    });
    const sent = lastRequest(socket);
    expect(sent.frame).toMatchObject({ type: "tasksMutate", mutation: { op: "create" } });

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "tasksMutateResult",
        reqId: sent.frame.reqId as string,
        task: {
          taskId: "task_9",
          projectId: "proj_1",
          title: "restock",
          agent: "claude-code",
          status: "ready",
          pinned: false,
          archived: false,
          icon: null,
          updatedAt: 3,
        },
      },
    });
    await expect(pending).resolves.toMatchObject({ taskId: "task_9" });
  });

  it("surfaces a Core rejection as a failed call, not a result to inspect", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.mutateProject("core_a", {
      op: "create",
      name: "warehouse",
      path: "/not/a/folder",
    });
    const sent = lastRequest(socket);
    socket.push({
      t: "core",
      coreId: "core_a",
      frame: { type: "error", reqId: sent.frame.reqId as string, message: "Not a folder" },
    });

    await expect(pending).rejects.toThrow("Not a folder");
  });
});

/**
 * The Archived view's read path (ADR 0019). Two calls, two frames: the active
 * list answers with a count of archived rows and none of them, and the rows
 * come back only when something asks for them by name.
 */
describe("panel bridge — the archived read path", () => {
  const ARCHIVED = {
    taskId: "task_old",
    projectId: "proj_1",
    title: "last winter's stocktake",
    agent: "claude-code",
    status: "done",
    pinned: false,
    archived: true,
    icon: null,
    updatedAt: 1,
  };

  it("hands back the archived count alongside the active rows", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listTasks("core_a", "proj_1");
    const sent = lastRequest(socket);
    expect(sent.frame).toMatchObject({ type: "tasksList", projectId: "proj_1" });

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "tasksListResult",
        reqId: sent.frame.reqId as string,
        tasks: [{ ...ARCHIVED, taskId: "task_1", archived: false, status: "running" }],
        archivedCount: 4,
      },
    });
    await expect(pending).resolves.toEqual({
      tasks: [expect.objectContaining({ taskId: "task_1" })],
      archivedCount: 4,
    });
  });

  it("fetches the archived rows over their own frame", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listArchivedTasks("core_a", "proj_1");
    const sent = lastRequest(socket);
    expect(sent.coreId).toBe("core_a");
    expect(sent.frame).toMatchObject({ type: "archivedTasksList", projectId: "proj_1" });

    socket.push({
      t: "core",
      coreId: "core_a",
      frame: {
        type: "archivedTasksListResult",
        reqId: sent.frame.reqId as string,
        tasks: [ARCHIVED],
      },
    });
    await expect(pending).resolves.toEqual([ARCHIVED]);
  });

  it("surfaces an unreachable Core as a failed call, like the active list does", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listArchivedTasks("core_gone", "proj_1");
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

describe("panel bridge — browsing the Core's filesystem", () => {
  it("asks the named Core for a listing, and for its home when given no path", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.listFolders("core_b", null);
    const sent = lastRequest(socket);
    expect(sent.coreId).toBe("core_b");
    expect(sent.frame).toMatchObject({ type: "dirList", path: null });

    socket.push({
      t: "core",
      coreId: "core_b",
      frame: {
        type: "dirListResult",
        reqId: sent.frame.reqId as string,
        listing: {
          path: "/home/op",
          parent: "/home",
          home: "/home/op",
          roots: [{ label: "Home", path: "/home/op" }],
          entries: [{ name: "projects", childCount: 2 }],
          truncated: false,
        },
      },
    });
    await expect(pending).resolves.toMatchObject({ path: "/home/op" });
  });

  it("creates a folder on the Core's machine and resolves to its path", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.createFolder("core_b", "/srv", "warehouse");
    const sent = lastRequest(socket);
    expect(sent.frame).toMatchObject({ type: "dirCreate", parent: "/srv", name: "warehouse" });

    socket.push({
      t: "core",
      coreId: "core_b",
      frame: {
        type: "dirCreateResult",
        reqId: sent.frame.reqId as string,
        path: "/srv/warehouse",
      },
    });
    await expect(pending).resolves.toBe("/srv/warehouse");
  });

  it("surfaces a refused folder creation as a failed call", async () => {
    const { bridge, socket } = bridged();

    const pending = bridge.createFolder("core_b", "/srv", "warehouse");
    const sent = lastRequest(socket);
    socket.push({
      t: "core",
      coreId: "core_b",
      frame: {
        type: "error",
        reqId: sent.frame.reqId as string,
        message: "Something with that name already exists here",
      },
    });

    await expect(pending).rejects.toThrow("Something with that name already exists here");
  });
});
