// @vitest-environment jsdom
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "@actana/core/pty-core-link-server";
import { bootstrapCoreDb } from "@actana/core/core-db-bootstrap";
import {
  configureCoreMutationStore,
  coreMutationStore,
  disposeCoreMutationStore,
} from "@actana/core/core-mutation-store";
import {
  configureCoreQueryStore,
  coreQueryStore,
  disposeCoreQueryStore,
} from "@actana/core/core-query-store";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
} from "@actana/core/event-log-store";
import type { PtyCore } from "@actana/core/pty-manager";
import type { CoreLinkEvent } from "@actana/sdk/core-link-frames";

// The notification a real Core raises. ADR 0008 assumed `session:finished`
// already crossed the core-link; it never did, and the suite next door proves
// nothing about that because it hand-writes the frame (issue 20). Here the
// event is produced the only way it happens in production: a Panel patches a
// Session's exit status over the core-link, a Core writes its own SQLite,
// appends to its own event log, and streams the tail back. Whatever comes off
// that wire is what the hook is fed.

const h = vi.hoisted(() => ({
  fleetHandler: null as ((msg: unknown) => void) | null,
  settings: {} as Record<string, unknown>,
  mcToastCustom: vi.fn((..._args: unknown[]) => undefined),
  playDing: vi.fn((..._args: unknown[]) => undefined),
  showOsNotification: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("~/queries", () => ({ useSettings: () => ({ data: h.settings }) }));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [{ id: "core-a", label: "Warehouse VM" }] }),
}));
vi.mock("~/lib/use-events", () => ({ useServerEvents: () => undefined }));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    watchCore: () => () => {},
    onEvent: (cb: (msg: unknown) => void) => {
      h.fleetHandler = cb;
      return () => {
        h.fleetHandler = null;
      };
    },
  }),
}));
vi.mock("~/lib/mc-toast", () => ({
  mcToastCustom: (...args: unknown[]) => h.mcToastCustom(...args),
  McToastActions: () => null,
  McToastCloseButton: () => null,
}));
vi.mock("~/lib/notification-sound", () => ({
  playNotificationDing: (...args: unknown[]) => h.playDing(...args),
}));
vi.mock("~/lib/os-notifications", () => ({
  showSessionFinishOsNotification: (...args: unknown[]) => h.showOsNotification(...args),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));

const {
  __resetSessionFinishDedupForTests,
  useSessionFinishNotifications,
} = await import("../use-session-finish-notifications");
const { loadSessionFinishNotifications } = await import("../session-notification-store");

// ─── A real Core, reachable over a fake socket ──────────────────────────────

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
  /** The event frames the Core has streamed, in order. */
  events(): CoreLinkEvent[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type: string; event?: CoreLinkEvent })
      .flatMap((f) => (f.type === "event" && f.event ? [f.event] : []));
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

function mockPtyCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    // Which Session a `write`/`kill` would touch (issue 144) — the lookup
    // the Core's Session-lock gate resolves a ptyId through.
    taskIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

const realEventLog: EventLogPort = { appendEvent, getLastEventId, readEventTail };

describe("a Session finishing on a Core notifies the Panel (issue 20)", () => {
  let userDataDir: string;
  let server: PtyCoreLinkServer;
  let ws: FakeWebSocket;

  beforeEach(() => {
    window.localStorage.clear();
    __resetSessionFinishDedupForTests();
    h.settings = {};
    h.fleetHandler = null;
    vi.clearAllMocks();

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-finish-notify-"));
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
    configureEventLogStore(userDataDir);

    const wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockPtyCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      eventLog: realEventLog,
      queryPort: coreQueryStore,
      mutationPort: coreMutationStore,
      liveEventPollMs: 5,
    });
    ws = new FakeWebSocket();
    wss.connect(ws);
    ws.receive({ type: "subscribe", reqId: "s1", lastEventId: 0 });

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
    vi.restoreAllMocks();
  });

  /** Patch a Session's status over the core-link, as the exit handler does. */
  async function finishOnCore(taskId = "t1", status = "finished"): Promise<void> {
    const before = ws.events().length;
    ws.receive({
      type: "tasksMutate",
      reqId: `m-${taskId}-${status}`,
      mutation: { op: "update", taskId, status },
    });
    // Let the Core's live-event poll push whatever the mutation appended.
    await vi.waitFor(() => expect(ws.events().length).toBeGreaterThan(before));
  }

  /** Feed every event the Core has streamed to the Panel's fleet listener. */
  function deliverToPanel(from = 0): number {
    const events = ws.events().slice(from);
    act(() => {
      for (const event of events) h.fleetHandler?.({ coreId: "core-a", event });
    });
    return from + events.length;
  }

  it("raises one notification carrying the real project, Session, and Core alias", async () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    await finishOnCore();
    deliverToPanel();

    expect(h.mcToastCustom).toHaveBeenCalledTimes(1);
    expect(h.playDing).toHaveBeenCalledTimes(1);

    const stored = loadSessionFinishNotifications();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "t1",
      projectId: "p1",
      projectName: "Warehouse",
      taskTitle: "Rebuild the picker",
      coreId: "core-a",
      coreAlias: "Warehouse VM",
    });
    expect(hook.result.current.notifications).toHaveLength(1);
    hook.unmount();
  });

  it("replays the tail to a Panel that was asleep, without doubling a live event", async () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    await finishOnCore();
    deliverToPanel();

    // The Panel reconnects and re-subscribes from the cursor it had before the
    // finish; the Core streams the same event again.
    ws.receive({ type: "subscribe", reqId: "s2", lastEventId: 0 });
    await vi.waitFor(() => expect(ws.events().length).toBeGreaterThan(2));
    act(() => {
      hook.rerender();
      for (const event of ws.events()) h.fleetHandler?.({ coreId: "core-a", event });
    });

    expect(h.mcToastCustom).toHaveBeenCalledTimes(1);
    expect(loadSessionFinishNotifications()).toHaveLength(1);
    hook.unmount();
  });

  it("stays silent when an already-finished Session is patched again", async () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    await finishOnCore();
    const seen = deliverToPanel();

    await finishOnCore();
    deliverToPanel(seen);

    expect(h.mcToastCustom).toHaveBeenCalledTimes(1);
    expect(loadSessionFinishNotifications()).toHaveLength(1);
    hook.unmount();
  });

  it("stays silent for a status change that is not a finish", async () => {
    const hook = renderHook(() => useSessionFinishNotifications());
    await finishOnCore("t1", "needs-input");
    deliverToPanel();

    expect(h.mcToastCustom).not.toHaveBeenCalled();
    expect(loadSessionFinishNotifications()).toHaveLength(0);
    hook.unmount();
  });
});
