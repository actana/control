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
// The gate's mechanics are exercised through the constructor seam with a
// stand-in type, so they stay readable independently of whichever real frames
// happen to be registered. The real ones — `ptySubscribe` / `ptyUnsubscribe`
// from #142 — are covered further down, including the fallback a capability-less
// Core gets and the ready-before-authOk ordering the reconnect resend needs.
// The Session lock's `claim` / `release` / `forceTakeover` (issue 144, D3–D7)
// joined them, with the same consult-the-gate-and-degrade shape — covered at
// the bottom of this file.

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
    it("holds exactly the PTY subscription frames and the Session lock's three", () => {
      // Exact membership, not a superset check: this set is the whole statement
      // of what this build refuses to send to a single-connection Core, so a
      // type appearing here without the ticket that owns it, or one quietly
      // dropping out, is the thing to notice. `claim` / `release` /
      // `forceTakeover` (D3–D7) joined when the Session lock landed (issue 144)
      // — a Core that evicts every client but one has nothing for a lock to
      // arbitrate between, and no table to put a claim in.
      expect([...MULTI_CONNECTION_ONLY_FRAME_TYPES].sort()).toEqual([
        "claim",
        "forceTakeover",
        "ptySubscribe",
        "ptyUnsubscribe",
        "release",
      ]);
    });
  });

  /**
   * The fallback a capability-less Core gets (ADR 0024 D11, review of #173).
   *
   * #142 put `.catch(() => {})` on every `ptySubscribe` call site, so a gated
   * refusal is invisible and the pane paints anyway — but only because a
   * pre-#142 Core fans every PTY out to every connection. That is the right
   * behaviour arriving by accident, through a swallowed error. Here it is the
   * decision: the client asks whether this Core can answer, and against one
   * that cannot it sends nothing and resolves, because the bytes are already
   * coming.
   */
  describe("the single-connection fallback for PTY subscriptions", () => {
    beforeEach(() => {
      client = makeClient();
    });

    it("puts no ptySubscribe on the wire for a Core that never announced it", async () => {
      readyWithout();
      await expect(client.ptySubscribe("pty_1", { catchUp: true })).resolves.toBeUndefined();
      expect(socket.framesOfType("ptySubscribe")).toEqual([]);
    });

    it("resolves rather than rejecting — the caller is already receiving that PTY", async () => {
      readyWithout();
      // The distinction that matters: not a rejection anyone has to swallow.
      // A caller that got a rejection here would be right to treat the pane as
      // broken, and it is not.
      await expect(client.ptySubscribe("pty_1")).resolves.toBeUndefined();
      await expect(client.ptyUnsubscribe("pty_1")).resolves.toBeUndefined();
      expect(socket.framesOfType("ptyUnsubscribe")).toEqual([]);
    });

    it("still paints the pane — the Core fans that PTY out unasked", async () => {
      readyWithout();
      const seen: { ptyId: string; data: string }[] = [];
      client.onData((msg) => seen.push({ ptyId: msg.ptyId, data: msg.data }));

      await client.ptySubscribe("pty_1", { catchUp: true });
      // A single-connection Core streams every PTY to every connection without
      // being asked. This is the whole reason the fallback is silence.
      socket.receive({ type: "data", ptyId: "pty_1", data: "hello", seq: 1 });

      expect(seen).toEqual([{ ptyId: "pty_1", data: "hello" }]);
      expect(socket.framesOfType("ptySubscribe")).toEqual([]);
    });

    it("asks for real once that Core comes back announcing the capability", () => {
      // Why the want is remembered even when no frame goes out. The Core is
      // upgraded and restarts; the same client reconnects. Nothing else
      // remembers this pane — the router binds a Core once, not once per
      // reconnect — so if the fallback had dropped the want, this Core would
      // now fan out to subscribers only and the pane would go dark.
      readyWithout();
      void client.ptySubscribe("pty_1");
      expect(socket.framesOfType("ptySubscribe")).toEqual([]);

      socket.close();
      socket.open();
      readyWithCapability();

      expect(socket.framesOfType("ptySubscribe")).toMatchObject([
        { ptyId: "pty_1", catchUp: false },
      ]);
    });

    it("does not re-ask for a pty released while the Core could not hear it", () => {
      readyWithout();
      void client.ptySubscribe("pty_1");
      void client.ptyUnsubscribe("pty_1");

      socket.close();
      socket.open();
      readyWithCapability();

      expect(socket.framesOfType("ptySubscribe")).toEqual([]);
    });
  });

  /**
   * The resend fires from `authOk` and is gated on a capability recorded by
   * `ready`. Nothing in the client enforces that order — it holds because the
   * Core sends `ready` as frame one. Pinned here, because if it ever stopped
   * holding the resend would read "unknown" as "absent", take the fallback, and
   * silently unsubscribe every held pane on a Core that does announce it.
   */
  describe("the reconnect resend and the ready/authOk ordering", () => {
    function makeAuthedClient(): PtyCoreLinkClient {
      socket = new FakeWebSocket();
      const c = new PtyCoreLinkClient({
        url: "ws://127.0.0.1:0",
        createSocket: () => socket as unknown as ClientWebSocketLike,
        reconnectInitialMs: 10_000,
        reconnectMaxMs: 10_000,
        storage: memoryStorage(),
        bearer: "bearer-for-the-auth-path",
      });
      socket.open();
      return c;
    }

    it("re-asks on authOk, because ready has already answered the capability", () => {
      client = makeAuthedClient();
      readyWithCapability();
      socket.receive({ type: "authOk", coreId: "core_1", exp: Date.now() + 60_000 });
      fireAndForget(client.ptySubscribe("pty_1"));
      expect(socket.framesOfType("ptySubscribe")).toHaveLength(1);

      socket.close();
      socket.open();
      // Frame one on the new connection, exactly as the Core sends it — then
      // the auth answer that triggers the resend.
      readyWithCapability();
      socket.receive({ type: "authOk", coreId: "core_1", exp: Date.now() + 60_000 });

      expect(socket.framesOfType("ptySubscribe")).toMatchObject([
        { ptyId: "pty_1", catchUp: false },
        { ptyId: "pty_1", catchUp: false },
      ]);
    });

    it("self-refuses if authOk ever arrives first — the ordering is the guard", () => {
      // Not a wish for this order, a demonstration of what the order buys. A
      // Core that answered `auth` before it said `ready` would leave the resend
      // with no capability to read, and the fallback would eat every held pane.
      client = makeAuthedClient();
      readyWithCapability();
      socket.receive({ type: "authOk", coreId: "core_1", exp: Date.now() + 60_000 });
      fireAndForget(client.ptySubscribe("pty_1"));

      socket.close();
      socket.open();
      socket.receive({ type: "authOk", coreId: "core_1", exp: Date.now() + 60_000 });
      expect(socket.framesOfType("ptySubscribe")).toHaveLength(1);

      // And it recovers on the next connection that observes the real order,
      // because the want outlived the connection that could not express it.
      socket.close();
      socket.open();
      readyWithCapability();
      socket.receive({ type: "authOk", coreId: "core_1", exp: Date.now() + 60_000 });
      expect(socket.framesOfType("ptySubscribe")).toHaveLength(2);
    });
  });
  /**
   * The Session lock over the gate (issue 144, ADR 0024 D3–D7, D10).
   *
   * `claim` / `release` / `forceTakeover` are multi-connection-only in the
   * strictest sense of the phrase: a single-connection Core evicts every client
   * but one, so it has nothing for a lock to arbitrate between and no table to
   * put a claim in. The frames are in the gated set, and the three methods
   * consult the gate themselves rather than reaching the backstop rejection —
   * because a caller asking "may I write this Session?" has a real answer
   * waiting for it on such a Core, and that answer is "yes, there is no lock
   * here", which an exception cannot carry.
   */
  describe("the Session lock's frames", () => {
    beforeEach(() => {
      client = makeClient();
    });

    it("puts claim, release and forceTakeover on the wire for a Core that announces it", async () => {
      readyWithCapability();

      const claim = client.claim("task_1");
      const claimFrame = socket.framesOfType("claim").at(-1)!;
      socket.receive({ type: "claimResult", reqId: claimFrame.reqId, taskId: "task_1", granted: true });
      await expect(claim).resolves.toEqual({ supported: true, granted: true });

      const release = client.release("task_1");
      const releaseFrame = socket.framesOfType("release").at(-1)!;
      socket.receive({
        type: "releaseResult",
        reqId: releaseFrame.reqId,
        taskId: "task_1",
        released: true,
      });
      await expect(release).resolves.toEqual({ supported: true, released: true });

      const takeover = client.forceTakeover("task_1");
      const takeoverFrame = socket.framesOfType("forceTakeover").at(-1)!;
      socket.receive({
        type: "forceTakeoverResult",
        reqId: takeoverFrame.reqId,
        taskId: "task_1",
        takenFrom: "another-connection",
      });
      await expect(takeover).resolves.toEqual({
        supported: true,
        takenFrom: "another-connection",
      });
    });

    it("carries a denied claim back as an answer, not as a rejection", async () => {
      // The Session being held by another client is the answer to the question
      // asked. Only a *mutation* refused for the lock throws, and that arrives
      // as an `error` frame carrying `session-locked`.
      readyWithCapability();
      const claim = client.claim("task_1");
      const frame = socket.framesOfType("claim").at(-1)!;
      socket.receive({ type: "claimResult", reqId: frame.reqId, taskId: "task_1", granted: false });
      await expect(claim).resolves.toEqual({ supported: true, granted: false });
    });

    it("sends nothing at all to a Core that never announced the capability", async () => {
      readyWithout();

      await expect(client.claim("task_1")).resolves.toEqual({
        supported: false,
        granted: false,
      });
      await expect(client.release("task_1")).resolves.toEqual({
        supported: false,
        released: false,
      });
      await expect(client.forceTakeover("task_1")).resolves.toEqual({
        supported: false,
        takenFrom: "nobody",
      });

      expect(socket.framesOfType("claim")).toHaveLength(0);
      expect(socket.framesOfType("release")).toHaveLength(0);
      expect(socket.framesOfType("forceTakeover")).toHaveLength(0);
    });

    it("distinguishes 'no lock on this Core' from 'someone else holds it'", async () => {
      // The one confusion that would matter downstream: `supported: false` and
      // `granted: false` both carry a false, and reading them the same way
      // renders a single-connection Core permanently read-only to the operator
      // who is in fact its only client.
      readyWithout();
      const unsupported = await client.claim("task_1");

      client = makeClient();
      readyWithCapability();
      const denied = client.claim("task_1");
      const frame = socket.framesOfType("claim").at(-1)!;
      socket.receive({ type: "claimResult", reqId: frame.reqId, taskId: "task_1", granted: false });

      expect(unsupported).toEqual({ supported: false, granted: false });
      await expect(denied).resolves.toEqual({ supported: true, granted: false });
    });

    it("closes the gate again when the link drops, so nothing queues past a reconnect", async () => {
      // Same reason `ptySubscribe` re-reads it: between a drop and the next
      // `ready` the answer is unknown, and a stale yes would let a lock frame
      // onto the reconnect queue, which the reopen drains unconditionally —
      // before the new `ready` says whether this Core can answer it.
      readyWithCapability();
      socket.close();

      await expect(client.claim("task_1")).resolves.toEqual({
        supported: false,
        granted: false,
      });
      expect(socket.framesOfType("claim")).toHaveLength(0);
    });
  });
});
