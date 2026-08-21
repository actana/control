// The Core stamps a delivery in its event log (#289 A).
//
// The mechanism the whole ticket hangs off: a client that is about to wait for
// the turn a write starts needs to know *where in the log the write landed*,
// because the only other question available — "is this Session settled?" —
// answers with the status the Session was already sitting at before the write.
//
// What is asserted here is the Core's half of that, against the real event-log
// store rather than a fake: a stamped write appends one `session:delivered`
// carrying the Task id and answers with its event id; an unstamped write
// appends nothing; and neither a refused write nor a PTY with no Task behind it
// produces a cursor, because a cursor for a delivery that did not happen is
// worse than none.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
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
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";
import { SESSION_DELIVERED_EVENT_KIND } from "@actana/sdk/core-link-frames";

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

/**
 * One live PTY belonging to `t1`, and a second belonging to nothing.
 *
 * The second is not an exotic case: a VM shell Session and a PTY whose Task row
 * has gone are both PTYs the Core can write to and cannot name a Task for.
 */
const writes: string[] = [];
function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: (ptyId: string, data: string) => {
      if (ptyId === "pty-gone") return false;
      writes.push(data);
      return true;
    },
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: "pty-1" }),
    taskIdForPty: (ptyId: string) => (ptyId === "pty-1" ? "t1" : null),
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

const realEventLog: EventLogPort = { appendEvent, getLastEventId, readEventTail };

describe("the Core stamps an accepted write it was asked to stamp (#289 A)", () => {
  let userDataDir: string;
  let server: PtyCoreLinkServer;
  let ws: FakeWebSocket;

  beforeEach(() => {
    writes.length = 0;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-delivered-"));
    bootstrapCoreDb(userDataDir);
    configureEventLogStore(userDataDir);

    const wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: realEventLog,
      liveEventPollMs: 5,
    });
    ws = new FakeWebSocket();
    wss.connect(ws);
  });

  afterEach(() => {
    server.close();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  /** Send a `write` frame and read the `writeResult` it answers with. */
  async function write(
    reqId: string,
    frame: { ptyId: string; data: string; stamp?: boolean },
  ): Promise<{ ok: boolean; deliveryEventId?: number }> {
    ws.receive({ type: "write", reqId, ...frame });
    let answer: { ok: boolean; deliveryEventId?: number } | undefined;
    await vi.waitFor(() => {
      answer = ws.sent
        .map((raw) => JSON.parse(raw) as { reqId?: string; ok?: boolean; deliveryEventId?: number })
        .find((msg) => msg.reqId === reqId) as typeof answer;
      expect(answer).toBeDefined();
    });
    return answer!;
  }

  function deliveries(): CoreLinkEvent[] {
    return readEventTail(0).filter((e) => e.kind === SESSION_DELIVERED_EVENT_KIND);
  }

  it("appends one delivery event carrying the task id, and answers with its event id", async () => {
    const answer = await write("w1", { ptyId: "pty-1", data: "carry on", stamp: true });

    expect(answer.ok).toBe(true);
    const appended = deliveries();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.taskId).toBe("t1");
    expect(appended[0]!.ptyId).toBe("pty-1");
    // The id on the wire *is* the id in the log. A cursor that named a
    // different row than the one appended would be a cursor into somebody
    // else's history.
    expect(answer.deliveryEventId).toBe(appended[0]!.eventId);
    // And the bytes went in unchanged — the stamp is a record of a write, not
    // an instruction added to one (ADR 0026).
    expect(writes).toEqual(["carry on"]);
  });

  it("carries the length and not the text, because the log is read by everyone", async () => {
    await write("w1", { ptyId: "pty-1", data: "the password is hunter2", stamp: true });

    const payload = JSON.parse(deliveries()[0]!.payload) as Record<string, unknown>;
    expect(payload).toEqual({ taskId: "t1", ptyId: "pty-1", characters: 23 });
    expect(JSON.stringify(payload)).not.toContain("hunter2");
  });

  it("stamps nothing for a write that did not ask — which is every keystroke", async () => {
    // An attached terminal writes a frame per keypress and this log is
    // append-only for the life of the Core. Stamping unasked would trade a
    // usable log for a field nobody in that path reads.
    const answer = await write("w1", { ptyId: "pty-1", data: "j" });

    expect(answer.ok).toBe(true);
    expect(answer.deliveryEventId).toBeUndefined();
    expect(deliveries()).toHaveLength(0);
  });

  it("stamps nothing for a write the PTY refused", async () => {
    const answer = await write("w1", { ptyId: "pty-gone", data: "anyone there", stamp: true });

    expect(answer.ok).toBe(false);
    expect(answer.deliveryEventId).toBeUndefined();
    // A cursor here would have a caller waiting for the end of a turn that no
    // harness was ever told to start.
    expect(deliveries()).toHaveLength(0);
  });

  it("stamps nothing for a PTY it cannot name a Task for", async () => {
    // The wait is per Session, and the events it counts against carry a task
    // id. A stamp with none could never be compared with anything.
    const answer = await write("w1", { ptyId: "pty-shell", data: "ls\r", stamp: true });

    expect(answer.ok).toBe(true);
    expect(answer.deliveryEventId).toBeUndefined();
    expect(deliveries()).toHaveLength(0);
  });

  it("stamps each accepted write of a multi-write delivery, in order", async () => {
    // `send --enter` is two writes to one PTY — the text, then the carriage
    // return — and the turn starts at the return. A caller waits from the later
    // stamp, so both have to be stamped and they have to be ordered.
    const text = await write("w1", { ptyId: "pty-1", data: "run the tests", stamp: true });
    const enter = await write("w2", { ptyId: "pty-1", data: "\r", stamp: true });

    expect(deliveries()).toHaveLength(2);
    expect(enter.deliveryEventId!).toBeGreaterThan(text.deliveryEventId!);
  });
});
