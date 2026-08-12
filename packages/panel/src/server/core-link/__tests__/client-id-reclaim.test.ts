import { describe, it, expect } from "vitest";
import {
  PtyCoreLinkClient,
  type CoreLinkCursorStorage,
  type WebSocketLike as ClientWebSocketLike,
} from "../client";
import { CORE_LINK_PROTOCOL_VERSION } from "@actana/sdk/core-link-frames";

// The Panel's side of the stable client id (issue 146, ADR 0024 D9).
//
// This link presents one string, on every connection it opens, so that a Core
// can close the socket this connection replaces and hand its Session locks
// over in one step instead of waiting out a 45-second heartbeat.
//
// Three properties, and the first is the whole of the feature:
//
//  1. **The id does not move.** It is the same across every reconnect of this
//     client, because a reconnect is exactly what it exists to span. An id that
//     changed with the socket would reclaim nothing, every time, and the defect
//     would be invisible — the Core would answer politely and the ghost would
//     keep its locks for the full timeout.
//  2. **It is this client's, not the machine's.** Two links mint two ids, which
//     is what keeps the Panel's id from being the CLI's. Deriving it from
//     anything on the registration blob would make every client on a machine
//     one connection, each reconnect reaping the others (D9).
//  3. **It is withheld from a Core that cannot use it**, like every other
//     multi-connection-only frame — and here the degraded behaviour is not a
//     compromise: such a Core evicts the previous connection on connect, which
//     is precisely what the frame asks for.

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
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  framesOfType(type: string): Record<string, unknown>[] {
    return this.frames().filter((frame) => frame.type === type);
  }
  types(): string[] {
    return this.frames().map((frame) => String(frame.type));
  }
}

function memoryStorage(): CoreLinkCursorStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("the Panel's Core client id (issue 146, ADR 0024 D9)", () => {
  let socket: FakeWebSocket;

  function makeClient(opts: { clientId?: string; bearer?: string | null } = {}): PtyCoreLinkClient {
    socket = new FakeWebSocket();
    const client = new PtyCoreLinkClient({
      url: "ws://127.0.0.1:0",
      createSocket: () => socket as unknown as ClientWebSocketLike,
      reconnectInitialMs: 10_000, // no auto-reconnect mid-test
      reconnectMaxMs: 10_000,
      storage: memoryStorage(),
      clientId: opts.clientId,
      bearer: opts.bearer === null ? undefined : (opts.bearer ?? "bearer-for-the-auth-path"),
    });
    socket.open();
    return client;
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

  function authOk(): void {
    socket.receive({ type: "authOk", coreId: "core_1", exp: Date.now() + 60_000 });
  }

  /** Bring a connection all the way up, the way a Core does it. */
  function handshake(): void {
    readyWithCapability();
    authOk();
  }

  describe("presenting it", () => {
    it("puts the id on the wire once the connection is up", () => {
      const client = makeClient();
      handshake();

      expect(socket.framesOfType("reclaim")).toMatchObject([{ clientId: client.clientId }]);
      expect(client.clientId).toMatch(/^panel-/);
    });

    it("sends it before the replay tail and the PTY resend", () => {
      // Ordering with a reason: until this frame lands, the socket it replaces
      // is still holding this link's Sessions and the Core cannot tell it from
      // a live one. `subscribe` and the PTY resend are catching up on what
      // happened while we were away and lose nothing by going second.
      const client = makeClient();
      readyWithCapability();
      void client.ptySubscribe("pty_1").catch(() => {});
      socket.sent.length = 0;
      authOk();

      expect(socket.types()).toEqual(["reclaim", "subscribe", "ptySubscribe"]);
    });

    it("withholds it until the bearer has been accepted", () => {
      // The id is not a credential and the Core does not treat it as one: it
      // refuses `reclaim` before `auth` like every other frame, and drops the
      // connection for asking. Sending it early would cost a reconnect.
      makeClient();
      readyWithCapability();
      expect(socket.framesOfType("reclaim")).toHaveLength(0);

      authOk();
      expect(socket.framesOfType("reclaim")).toHaveLength(1);
    });

    it("presents it on `ready` when no bearer is configured", () => {
      // A loopback Core with no verifier answers no `authOk`, so `ready` is the
      // first — and only — moment the capability is known.
      makeClient({ bearer: null });
      readyWithCapability();
      expect(socket.framesOfType("reclaim")).toHaveLength(1);
    });

    it("carries on when the Core refuses the reclaim", async () => {
      // Fire-and-forget by design: a reclaim that does not land costs the
      // 45-second heartbeat it was shortening — a slower path to the same
      // state, never a wrong one — so nothing above this client waits on it.
      const client = makeClient();
      handshake();
      const reqId = socket.framesOfType("reclaim")[0]!.reqId;
      socket.receive({ type: "error", reqId, message: "nope" });

      const spawn = client.findByTask("task_1");
      const findFrame = socket.framesOfType("findByTask").at(-1)!;
      socket.receive({ type: "findByTaskResult", reqId: findFrame.reqId, ptyId: "pty_1" });
      await expect(spawn).resolves.toMatchObject({ ptyId: "pty_1" });
    });
  });

  describe("the id itself", () => {
    it("is the same string on every reconnect — the property the feature rests on", () => {
      const client = makeClient();
      handshake();
      socket.close();
      socket.open();
      handshake();
      socket.close();
      socket.open();
      handshake();

      const presented = socket.framesOfType("reclaim").map((frame) => frame.clientId);
      expect(presented).toEqual([client.clientId, client.clientId, client.clientId]);
    });

    it("is distinct per Core client — the Panel's id is not the CLI's", () => {
      const first = makeClient();
      const second = makeClient();
      expect(first.clientId).not.toEqual(second.clientId);
    });

    it("is whatever a caller with somewhere durable to keep it passes in", () => {
      // The seam for an id that outlives this process. It must stay per Core
      // client: anything off the registration blob is machine-scoped, and would
      // make every client on that machine one connection reaping the others.
      const client = makeClient({ clientId: "panel-from-somewhere-durable" });
      handshake();

      expect(client.clientId).toBe("panel-from-somewhere-durable");
      expect(socket.framesOfType("reclaim")).toMatchObject([
        { clientId: "panel-from-somewhere-durable" },
      ]);
    });
  });

  describe("against a Core that does not announce multiConnection", () => {
    it("sends nothing, because that Core has already done it", () => {
      // Not a swallowed failure. Such a Core evicts the previous connection the
      // moment this one opens — the reclaim would ask for what has happened —
      // and it has no lock table to transfer anything out of (D11).
      makeClient();
      readyWithout();
      authOk();

      expect(socket.framesOfType("reclaim")).toHaveLength(0);
      // And the rest of the connection comes up exactly as it did before D9.
      expect(socket.types()).toEqual(["auth", "subscribe"]);
    });
  });
});
