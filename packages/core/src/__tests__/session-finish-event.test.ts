import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import {
  configureCoreMutationStore,
  coreMutationStore,
  disposeCoreMutationStore,
} from "../core-mutation-store";
import {
  configureCoreQueryStore,
  coreQueryStore,
  disposeCoreQueryStore,
} from "../core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "../event-log-store";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";

// A Session finishing on a Core, end to end inside the Core: a `tasksMutate`
// frame patches the row's status through the real mutation store, and the real
// event log is what the Panel would read back. Nothing here hand-writes an
// event — the point is that a Core *produces* `session:finished`, which it
// never did (issue 20).

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  on(event: string, cb: Listener): void {
    (this.listeners[event] ??= []).push(cb);
  }
  removeAllListeners(): void {
    this.listeners = {};
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
  /** Deliver a frame from the Panel. */
  receive(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
}

class FakeWebSocketServer {
  private connCb: ((ws: WebSocketLike) => void) | null = null;

  connect(ws: FakeWebSocket): void {
    this.connCb?.(ws as unknown as WebSocketLike);
  }
  close(): void {}
  on(event: string, cb: Listener): void {
    if (event === "connection") this.connCb = cb as (ws: WebSocketLike) => void;
  }
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

/** The real event-log store, as the Core wires it in core-entry. */
const realEventLog: EventLogPort = { appendEvent, getLastEventId, readEventTail };

describe("session:finished is emitted by the Core (issue 20)", () => {
  let userDataDir: string;
  let server: PtyCoreLinkServer;
  let ws: FakeWebSocket;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-finish-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);

    const wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: realEventLog,
      queryPort: coreQueryStore,
      mutationPort: coreMutationStore,
      liveEventPollMs: 5,
    });
    ws = new FakeWebSocket();
    wss.connect(ws);

    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p1",
      name: "Warehouse",
      path: userDataDir,
    });
    coreMutationStore.mutateTask({
      op: "create",
      taskId: "t1",
      projectId: "p1",
      title: "Rebuild the picker",
      agent: "claude-code",
      status: "running",
    });
  });

  afterEach(() => {
    server.close();
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  /** Patch a task through the core-link, as the Panel's exit handler does. */
  async function patchStatus(taskId: string, status: string, reqId: string): Promise<void> {
    ws.receive({ type: "tasksMutate", reqId, mutation: { op: "update", taskId, status } });
    await vi.waitFor(() =>
      expect(
        ws.sent.some((raw) => (JSON.parse(raw) as { reqId?: string }).reqId === reqId),
      ).toBe(true),
    );
  }

  function finishEvents(): CoreLinkEvent[] {
    return readEventTail(0).filter((e) => e.kind === "session:finished");
  }

  it("appends session:finished when a task transitions to finished", async () => {
    await patchStatus("t1", "finished", "r1");

    const finishes = finishEvents();
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.taskId).toBe("t1");
    expect(JSON.parse(finishes[0]!.payload)).toMatchObject({
      id: "t1",
      projectId: "p1",
      projectName: "Warehouse",
      taskTitle: "Rebuild the picker",
    });
  });

  it("keeps emitting task:updated alongside the finish event", async () => {
    await patchStatus("t1", "finished", "r1");

    const kinds = readEventTail(0).map((e) => e.kind);
    expect(kinds).toContain("task:updated");
    expect(kinds).toContain("session:finished");
  });

  it("does not emit a second finish when an already-finished task is re-patched", async () => {
    await patchStatus("t1", "finished", "r1");
    await patchStatus("t1", "finished", "r2");

    expect(finishEvents()).toHaveLength(1);
  });

  it("does not emit a second finish for an archived task either", async () => {
    // An archived row is invisible to `listTasks` / `listSessions`, so a prior
    // status read through either would come back empty and let the re-patch
    // through. The row still exists, and it is still finished.
    await patchStatus("t1", "finished", "r1");
    coreMutationStore.mutateTask({ op: "update", taskId: "t1", archived: true });
    await patchStatus("t1", "finished", "r2");

    expect(finishEvents()).toHaveLength(1);
  });

  it("emits nothing for a status change that is not a finish", async () => {
    await patchStatus("t1", "needs-input", "r1");

    expect(finishEvents()).toHaveLength(0);
  });

  it("emits again when a task is restarted and finishes a second time", async () => {
    await patchStatus("t1", "finished", "r1");
    await patchStatus("t1", "running", "r2");
    await patchStatus("t1", "finished", "r3");

    expect(finishEvents()).toHaveLength(2);
  });

  it("streams the finish to a subscribed Panel as an event frame", async () => {
    ws.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });
    await patchStatus("t1", "finished", "r1");

    await vi.waitFor(() => {
      const frames = ws.sent
        .map((raw) => JSON.parse(raw) as { type: string; event?: CoreLinkEvent })
        .filter((f) => f.type === "event" && f.event?.kind === "session:finished");
      expect(frames).toHaveLength(1);
    });
  });
});
