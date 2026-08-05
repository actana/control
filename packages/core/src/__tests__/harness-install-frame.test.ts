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
  type HarnessInstallPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";
import { HARNESS_INSTALL_FAILED_EVENT_KIND } from "@actana/shared/core-link-frames";

// The `harnessInstall` frame, at the Core's edge (issue 83).
//
// The load-bearing property is what the frame does NOT do: it does not hold the
// request open for the install. A vendor installer runs for minutes and the
// Panel's request timeout is 30s, so an answer that waited for the outcome
// would reject a healthy install. The ack goes out at once and the outcome
// travels on the event log.

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
  /** Frames of one type the Core has sent so far. */
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type) as T[];
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

type Ack = { type: string; reqId: string; accepted: boolean; message?: string };

/** An install the test finishes by hand, so "still running" is observable. */
function pendingInstallPort() {
  let settle: (result: { ok: boolean; message?: string }) => void = () => {};
  const calls: string[] = [];
  const port: HarnessInstallPort = {
    installable: (harnessId) => harnessId === "claude-code" || harnessId === "claude",
    install: (harnessId) => {
      calls.push(harnessId);
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
  return {
    port,
    calls,
    finish: (result: { ok: boolean; message?: string }) => settle(result),
  };
}

const realEventLog: EventLogPort = { appendEvent, getLastEventId, readEventTail };

describe("the harnessInstall frame (issue 83)", () => {
  let userDataDir: string;
  let server: PtyCoreLinkServer;
  let ws: FakeWebSocket;
  let install: ReturnType<typeof pendingInstallPort>;

  function startServer(installPort: HarnessInstallPort | undefined): void {
    const wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: realEventLog,
      installPort,
      liveEventPollMs: 5,
    });
    ws = new FakeWebSocket();
    wss.connect(ws);
  }

  function failureEvents() {
    return readEventTail(0)
      .filter((event) => event.kind === HARNESS_INSTALL_FAILED_EVENT_KIND)
      .map((event) => JSON.parse(event.payload) as { harness: string; message: string });
  }

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-harness-install-"));
    bootstrapCoreDb(userDataDir);
    configureEventLogStore(userDataDir);
    install = pendingInstallPort();
    startServer(install.port);
  });

  afterEach(() => {
    server.close();
    disposeEventLogStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("acks before the install finishes, not after", () => {
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });

    // Synchronously, on the same turn the frame arrived: nothing about this
    // answer waits on the installer, so no request timeout can outrun it.
    expect(ws.ofType<Ack>("harnessInstallAck")).toEqual([
      { type: "harnessInstallAck", reqId: "r1", accepted: true },
    ]);
    expect(install.calls).toEqual(["claude-code"]);
    expect(failureEvents()).toEqual([]);
  });

  it("keeps answering other frames while an install runs", async () => {
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });
    ws.receive({ type: "sessionsList", reqId: "r2" });
    ws.receive({ type: "agentsAvailabilityList", reqId: "r3" });

    await vi.waitFor(() => {
      const answered = ws.sent
        .map((raw) => JSON.parse(raw) as { reqId?: string })
        .map((frame) => frame.reqId);
      expect(answered).toContain("r2");
      expect(answered).toContain("r3");
    });
    // …and the install is still going: an in-flight install is not a stalled Core.
    expect(failureEvents()).toEqual([]);
  });

  it("says nothing more when the install succeeds — availability is the answer", async () => {
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });
    install.finish({ ok: true });
    await vi.waitFor(() => expect(install.calls).toHaveLength(1));

    expect(failureEvents()).toEqual([]);
  });

  it("publishes a definitive failure as an event carrying the operator's message", async () => {
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });
    install.finish({ ok: false, message: "Installing Claude Code on this Core failed." });

    await vi.waitFor(() =>
      expect(failureEvents()).toEqual([
        { harness: "claude-code", message: "Installing Claude Code on this Core failed." },
      ]),
    );
    // The failure is an event, never an error answer to the request — the
    // request was already answered, successfully, with the ack.
    expect(ws.ofType("error")).toEqual([]);
  });

  it("publishes a failure even for an install that outlives the request timeout", async () => {
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });
    // Well past the panel link's 30s per-request timeout: the Panel's promise
    // for `r1` resolved long ago on the ack, and this still lands.
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(120_000);
    vi.useRealTimers();
    install.finish({ ok: false, message: "The installer never finished." });

    await vi.waitFor(() => expect(failureEvents()).toHaveLength(1));
  });

  it("refuses an unknown Harness id outright, and starts nothing", () => {
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "banana" });

    const [ack] = ws.ofType<Ack>("harnessInstallAck");
    expect(ack?.accepted).toBe(false);
    expect(ack?.message).toContain("banana");
    expect(install.calls).toEqual([]);
    expect(failureEvents()).toEqual([]);
  });

  it("refuses when the Core has no install path wired", () => {
    server.close();
    startServer(undefined);
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });

    const [ack] = ws.ofType<Ack>("harnessInstallAck");
    expect(ack?.accepted).toBe(false);
    expect(ack?.message).toBeTruthy();
  });

  it("turns a port that rejects into a failure event rather than a stuck row", async () => {
    server.close();
    startServer({
      installable: () => true,
      install: () => Promise.reject(new Error("port blew up")),
    });
    ws.receive({ type: "harnessInstall", reqId: "r1", harness: "claude-code" });

    await vi.waitFor(() => expect(failureEvents()).toHaveLength(1));
    expect(failureEvents()[0]!.message).toContain("port blew up");
  });
});
