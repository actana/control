import { describe, it, expect, beforeEach } from "vitest";
import {
  MULTI_CONNECTION_ONLY_FRAME_TYPES,
  PtyCoreLinkClient,
  type CoreLinkCursorStorage,
  type WebSocketLike as ClientWebSocketLike,
} from "../client";
import {
  CORE_LINK_PROTOCOL_VERSION,
  type CoreLinkRequestFrame,
} from "@actana/shared/core-link-frames";

// The Panel records `multiConnection` per Core and gates on it (issue 143,
// ADR 0024 D11).
//
// Two properties, and the second is the one with teeth:
//
//  1. The capability is read off every `ready`, per connection, and never
//     remembered across one — a Core can be downgraded while the Panel is away.
//  2. Against a Core that does not announce it, a multi-connection-only frame
//     is not sent AT ALL. Not sent-and-tolerate-the-error: nothing reaches the
//     socket, so the Core never has to answer for a frame it does not know.
//
// The frames that will populate the gate do not exist yet — `claim` is the lock
// ticket's and the PTY subscription is #142's, which owns its name. So the gate
// is exercised through the constructor seam with a stand-in type. When those
// frames land, their types join MULTI_CONNECTION_ONLY_FRAME_TYPES and inherit
// everything asserted here.

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 0;
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
  receive(obj: unknown): void {
    this.emit("message", JSON.stringify(obj));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  framesOfType(type: string): Record<string, unknown>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type);
  }
}

function memoryStorage(): CoreLinkCursorStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

/** The stand-in for a frame only a multi-connection Core understands. */
const GATED = "claimStandIn";

/**
 * Fire a request and swallow its settlement. These tests assert on what reached
 * the socket, never on the answer — and a frame still in flight when the
 * connection drops rejects by design.
 */
function fireAndForget(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

describe("the Panel's multiConnection capability (issue 143, ADR 0024 D11)", () => {
  let socket: FakeWebSocket;
  let client: PtyCoreLinkClient;

  function makeClient(opts: { gated?: ReadonlySet<string> } = {}): PtyCoreLinkClient {
    socket = new FakeWebSocket();
    const c = new PtyCoreLinkClient({
      url: "ws://127.0.0.1:0",
      createSocket: () => socket as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000, // no auto-reconnect mid-test
      reconnectMaxMs: 10_000,
      storage: memoryStorage(),
      multiConnectionOnlyFrameTypes: opts.gated,
    });
    socket.open();
    return c;
  }

  function readyWithCapability(): void {
    socket.receive({
      type: "ready",
      version: CORE_LINK_PROTOCOL_VERSION,
      multiConnection: { version: 1 },
    });
  }

  function readyWithout(): void {
    socket.receive({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION });
  }

  describe("recording the capability", () => {
    beforeEach(() => {
      client = makeClient();
    });

    it("is closed before ready lands — the answer is unknown, not yes", () => {
      expect(client.canSendMultiConnectionFrames()).toBe(false);
      expect(client.multiConnectionCapability()).toBe(null);
    });

    it("records it when the Core announces it", () => {
      readyWithCapability();
      expect(client.canSendMultiConnectionFrames()).toBe(true);
      expect(client.multiConnectionCapability()).toEqual({ version: 1 });
    });

    it("records its absence as absence, not as an error", () => {
      readyWithout();
      expect(client.canSendMultiConnectionFrames()).toBe(false);
      expect(client.multiConnectionCapability()).toBe(null);
    });

    it("treats a version it does not know as absent, falling back to single-connection", () => {
      socket.receive({
        type: "ready",
        version: CORE_LINK_PROTOCOL_VERSION,
        multiConnection: { version: 2 },
      });
      expect(client.canSendMultiConnectionFrames()).toBe(false);
    });

    it("does not carry a capability across a reconnect — it is re-read on the new ready", () => {
      readyWithCapability();
      expect(client.canSendMultiConnectionFrames()).toBe(true);

      // The Core comes back downgraded (rolled back, or a different build on
      // the same endpoint). A remembered `true` here would send frames it
      // cannot answer.
      socket.close();
      socket.open();
      expect(client.canSendMultiConnectionFrames()).toBe(false);
      readyWithout();
      expect(client.canSendMultiConnectionFrames()).toBe(false);
    });

    it("closes the moment the link drops, not when the next one opens", () => {
      readyWithCapability();
      expect(client.canSendMultiConnectionFrames()).toBe(true);

      // The window the reconnect backoff lives in: closed, not yet reopened.
      // The Core on the other end is gone and the next one may be a downgraded
      // build, so the answer here is unknown — which is `false`, not the
      // previous connection's `true`.
      socket.close();
      expect(client.canSendMultiConnectionFrames()).toBe(false);
      expect(client.multiConnectionCapability()).toBe(null);
    });

    it("picks the capability back up when an upgraded Core reconnects", () => {
      readyWithout();
      socket.close();
      socket.open();
      readyWithCapability();
      expect(client.canSendMultiConnectionFrames()).toBe(true);
    });
  });

  describe("gating frames that only a multi-connection Core understands", () => {
    beforeEach(() => {
      client = makeClient({ gated: new Set([GATED]) });
    });

    it("does not put the frame on the wire at all against a capability-less Core", async () => {
      readyWithout();
      await expect(
        client.request({ type: GATED } as unknown as CoreLinkRequestFrame),
      ).rejects.toThrow(/multiConnection capability/);
      // The property that matters: nothing was written. The Core is never asked
      // to answer for a frame it does not know, so there is no error to tolerate.
      expect(socket.framesOfType(GATED)).toHaveLength(0);
    });

    it("does not send it before ready either — an unknown answer is not permission", async () => {
      await expect(
        client.request({ type: GATED } as unknown as CoreLinkRequestFrame),
      ).rejects.toThrow(/multiConnection capability/);
      expect(socket.framesOfType(GATED)).toHaveLength(0);
    });

    it("does not queue it for a later flush — a refused frame is gone, not deferred", async () => {
      readyWithout();
      await expect(
        client.request({ type: GATED } as unknown as CoreLinkRequestFrame),
      ).rejects.toThrow(/multiConnection capability/);
      // A queued frame would go out when the socket next opens. Reconnect to a
      // Core that DOES announce the capability and confirm nothing flushes.
      socket.close();
      socket.open();
      readyWithCapability();
      expect(socket.framesOfType(GATED)).toHaveLength(0);
    });

    it("refuses it in the drop window, and nothing flushes when the socket reopens", async () => {
      readyWithCapability();
      // The link drops. Nothing has re-announced anything yet, so a frame asked
      // for now must be refused outright — if the stale `true` let it past the
      // gate it would land on the queue, and the reopen drain writes the queue
      // to the socket unconditionally, before that connection's `ready`.
      socket.close();
      const refused = client.request({ type: GATED } as unknown as CoreLinkRequestFrame);
      fireAndForget(refused);

      // Reconnect to a Core that DOES announce the capability: the frame would
      // be allowed if asked for now, so nothing about the new connection can
      // explain a GATED frame on the wire. Only a flush of the queue could —
      // which is why this assertion comes before the rejection one. A frame
      // that slipped past the gate is still pending here, not rejected, so
      // asserting the rejection first would fail as a timeout and say nothing
      // about the wire.
      socket.open();
      readyWithCapability();
      expect(socket.framesOfType(GATED)).toHaveLength(0);

      await expect(refused).rejects.toThrow(/multiConnection capability/);
    });

    it("sends it once the Core announces the capability", () => {
      readyWithCapability();
      fireAndForget(client.request({ type: GATED } as unknown as CoreLinkRequestFrame));
      expect(socket.framesOfType(GATED)).toHaveLength(1);
    });

    it("stops sending it again if the Core comes back downgraded", async () => {
      readyWithCapability();
      fireAndForget(client.request({ type: GATED } as unknown as CoreLinkRequestFrame));
      expect(socket.framesOfType(GATED)).toHaveLength(1);

      socket.close();
      socket.open();
      readyWithout();
      await expect(
        client.request({ type: GATED } as unknown as CoreLinkRequestFrame),
      ).rejects.toThrow(/multiConnection capability/);
      expect(socket.framesOfType(GATED)).toHaveLength(1);
    });
  });

  describe("a Core without the capability is a Core like any other", () => {
    beforeEach(() => {
      client = makeClient({ gated: new Set([GATED]) });
    });

    it("reports the connection compatible — a missing capability is not drift", () => {
      const seen: { version: string | null; compatible: boolean }[] = [];
      client.onProtocolVersion((msg) => seen.push(msg));
      readyWithout();
      expect(seen).toEqual([{ version: CORE_LINK_PROTOCOL_VERSION, compatible: true }]);
    });

    it("still sends every ordinary frame — the gate touches nothing else", () => {
      readyWithout();
      fireAndForget(client.request({ type: "tasksList" } as unknown as CoreLinkRequestFrame));
      fireAndForget(client.request({ type: "projectsList" } as unknown as CoreLinkRequestFrame));
      expect(socket.framesOfType("tasksList")).toHaveLength(1);
      expect(socket.framesOfType("projectsList")).toHaveLength(1);
    });

    it("still spawns a Session — the surface an operator touches is untouched", async () => {
      readyWithout();
      const spawn = client.spawn({
        taskId: "t1",
        cwd: "/tmp",
        command: "claude",
        agent: "claude-code",
      });
      const sent = socket.framesOfType("spawn");
      expect(sent).toHaveLength(1);
      socket.receive({ type: "spawned", reqId: sent[0]!.reqId, ptyId: "pty-1" });
      await expect(spawn).resolves.toMatchObject({ ptyId: "pty-1" });
    });
  });

  describe("the gate's frame registry", () => {
    it("is empty in this build — the claim and PTY-subscribe frames are not here yet", () => {
      // Not a placeholder assertion: an empty set is what makes this ticket a
      // no-op on the wire. If a frame type appears here without the ticket that
      // owns it, that is the thing to notice.
      expect([...MULTI_CONNECTION_ONLY_FRAME_TYPES]).toEqual([]);
    });
  });
});
