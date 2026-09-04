// `DurableCoreClient` against a real Core (issue 153, #129 D6).
//
// The durable entry point is the one-shot client plus a heartbeat, a reconnect
// loop, an event cursor and subscribe-then-replay — so every test here is about
// a connection *ending* and what the next one owes the Core. The server is the
// Core's own `PtyCoreLinkServer` with its auth gate armed, and every reconnect
// is a genuinely new connection with its own `ready`, its own `auth` and its own
// subscription state.

import { describe, it, expect, vi, afterEach } from "vitest";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import type { CoreLinkEvent } from "../core-link-frames";
import { DurableCoreClient } from "../durable-core-client";
import {
  coreLinkCursorStorageKey,
  InMemoryCoreLinkCursorStorage,
} from "../core-link-cursor-storage";
import { FakeSocketPair, startCoreRig, type CoreRig } from "./fake-core-link";

const SECRET = "durable-client-suite-secret-32-byte";
const URL_A = "wss://core-a.test:9444";

function bearerFor(coreId = "core_test"): string {
  return signBearer({ coreId, exp: Date.now() + 60_000 }, SECRET);
}

describe("DurableCoreClient", () => {
  let rig: CoreRig | null = null;
  let client: DurableCoreClient | null = null;

  afterEach(() => {
    client?.close();
    client = null;
    rig?.close();
    rig = null;
  });

  function remoteRig(): CoreRig {
    rig = startCoreRig({ authVerifier: (bearer) => verifyBearer(bearer, SECRET) });
    return rig;
  }

  function makeClient(
    core: CoreRig,
    opts: {
      storage?: InMemoryCoreLinkCursorStorage;
      cursorStorageKey?: string;
      pingable?: boolean;
      heartbeat?: { intervalMs?: number; timeoutMs?: number } | false;
    } = {},
  ): { client: DurableCoreClient; dial: ReturnType<CoreRig["dialer"]> } {
    const dial = core.dialer({ pingable: opts.pingable });
    client = new DurableCoreClient({
      url: URL_A,
      bearer: bearerFor(),
      createSocket: dial.createSocket,
      storage: opts.storage ?? new InMemoryCoreLinkCursorStorage(),
      cursorStorageKey: opts.cursorStorageKey,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5,
      heartbeat: opts.heartbeat ?? false,
    });
    return { client, dial };
  }

  it("owes the Core reclaim, then subscribe, then its PTY subscriptions — in that order, after auth", async () => {
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();
    await c.ptySubscribe("pty-7");

    const types = dial.last().client.frames().map((f) => f.type);
    expect(types.slice(0, 3)).toEqual(["auth", "reclaim", "subscribe"]);
    expect(types).toContain("ptySubscribe");
  });

  it("subscribes with the cursor it found in the injected storage", async () => {
    const core = remoteRig();
    const storage = new InMemoryCoreLinkCursorStorage();
    storage.setItem(coreLinkCursorStorageKey(URL_A), "41");
    const { client: c, dial } = makeClient(core, { storage });

    await c.connect();

    expect(c.getLastEventId()).toBe(41);
    expect(dial.last().client.framesOfType("subscribe")[0]).toMatchObject({ lastEventId: 41 });
  });

  it("keeps no cursor of its own when nothing was stored", async () => {
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);

    await c.connect();

    // First connect asks for the whole log, which is what `lastEventId: 0` means.
    expect(dial.last().client.framesOfType("subscribe")[0]).toMatchObject({ lastEventId: 0 });
  });

  it("replays the tail, ends on eventsReplayed, and persists the cursor it reached", async () => {
    const core = remoteRig();
    core.eventLog.appendEvent("task:created", '{"a":1}', { taskId: "t1" });
    core.eventLog.appendEvent("task:updated", '{"a":2}', { taskId: "t1" });
    const storage = new InMemoryCoreLinkCursorStorage();
    const { client: c } = makeClient(core, { storage });

    const seen: CoreLinkEvent[] = [];
    c.onEvent(({ event }) => seen.push(event));
    const replayed = vi.fn();
    c.onEventsReplayed(replayed);

    await c.connect();
    await vi.waitFor(() => expect(c.isCaughtUp()).toBe(true));

    expect(seen.map((e) => e.eventId)).toEqual([1, 2]);
    // `tipEventId` beside the cursor, and equal to it here because the whole
    // log fitted in one tail (#395). The two part company on a log past
    // `EVENT_TAIL_LIMIT`, which is the case the field exists for: the marker is
    // then a receipt for what was sent and the tip is where the log ends.
    expect(replayed).toHaveBeenCalledWith({ lastEventId: 2, tipEventId: 2 });
    expect(c.getLastEventId()).toBe(2);
    expect(storage.getItem(coreLinkCursorStorageKey(URL_A))).toBe("2");
  });

  it("drops an event at or below the cursor rather than delivering it twice", async () => {
    const core = remoteRig();
    core.eventLog.appendEvent("task:created", "{}", { taskId: "t1" });
    const { client: c, dial } = makeClient(core);
    const seen: number[] = [];
    c.onEvent(({ event }) => seen.push(event.eventId));

    await c.connect();
    await vi.waitFor(() => expect(seen).toEqual([1]));

    // A replay overlap, or a re-delivery after a reconnect: the same event again.
    dial.last().client.receive({
      type: "event",
      event: { eventId: 1, ts: 1, kind: "task:created", ptyId: null, taskId: "t1", payload: "{}" },
    });
    expect(seen).toEqual([1]);
  });

  it("advances the cursor on an empty tail, because the marker is authoritative", async () => {
    const core = remoteRig();
    core.eventLog.appendEvent("task:created", "{}", { taskId: "t1" });
    const storage = new InMemoryCoreLinkCursorStorage();
    storage.setItem(coreLinkCursorStorageKey(URL_A), "0");
    const { client: c } = makeClient(core, { storage });
    await c.connect();
    await vi.waitFor(() => expect(c.getLastEventId()).toBe(1));

    // Nothing new happened, and the Core says so with a marker and no events.
    expect(storage.getItem(coreLinkCursorStorageKey(URL_A))).toBe("1");
    expect(c.isCaughtUp()).toBe(true);
  });

  it("reconnects with backoff and restores the timeline it missed", async () => {
    const core = remoteRig();
    const storage = new InMemoryCoreLinkCursorStorage();
    const { client: c, dial } = makeClient(core, { storage });
    const seen: number[] = [];
    c.onEvent(({ event }) => seen.push(event.eventId));
    const disconnected = vi.fn();
    c.onDisconnected(disconnected);

    await c.connect();
    await c.ptySubscribe("pty-7");
    core.eventLog.appendEvent("task:updated", "{}", { taskId: "t1" });
    await vi.waitFor(() => expect(c.getLastEventId()).toBe(1));

    // The Core goes away, and something happens while this client cannot see it.
    dial.last().server.close();
    core.eventLog.appendEvent("session:finished", "{}", { taskId: "t1" });

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
    await vi.waitFor(() => expect(dial.pairs).toHaveLength(2));
    await vi.waitFor(() => expect(c.isCaughtUp()).toBe(true));

    // The gap is closed by the replay, with no double and no hole.
    expect(seen).toEqual([1, 2]);
    expect(c.getLastEventId()).toBe(2);

    // The second connection re-presents everything a connection owes, in order,
    // and asks for the tail past what it had already seen.
    const second = dial.last().client.frames();
    expect(second.map((f) => f.type).slice(0, 3)).toEqual(["auth", "reclaim", "subscribe"]);
    expect(second.find((f) => f.type === "subscribe")).toMatchObject({ lastEventId: 1 });
    // PTY subscriptions are connection state on the Core, so they died with the
    // socket and are re-asked for here — without `catchUp`, which only a caller
    // that will send the matching `replay` may set.
    expect(second.find((f) => f.type === "ptySubscribe")).toMatchObject({
      ptyId: "pty-7",
      catchUp: false,
    });
  });

  it("queues a request made while the link is down and answers it on the next connection", async () => {
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();

    dial.last().server.close();
    // No link, no refusal: the frame waits for one rather than making every call
    // site retry.
    await expect(c.replay("pty-1")).resolves.toEqual({
      data: "scrollback",
      nextSeq: 7,
      from: undefined,
    });
    expect(dial.pairs.length).toBeGreaterThan(1);
  });

  it("stops re-asking for a PTY it released, and re-asks for the rest", async () => {
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();
    await c.ptySubscribe("pty-1");
    await c.ptySubscribe("pty-2");
    await c.ptyUnsubscribe("pty-1");
    // A second ask for a PTY already held is a no-op on the wire.
    await c.ptySubscribe("pty-2");
    expect(dial.last().client.framesOfType("ptySubscribe")).toHaveLength(2);

    dial.last().server.close();
    await vi.waitFor(() => expect(dial.pairs).toHaveLength(2));
    await vi.waitFor(() => expect(c.isCaughtUp()).toBe(true));

    const resent = dial.last().client.framesOfType("ptySubscribe");
    expect(resent.map((f) => f.ptyId)).toEqual(["pty-2"]);
  });

  it("pings an idle link and destroys a half-open one rather than waiting for a FIN", async () => {
    const core = remoteRig();
    const { client: c, dial } = makeClient(core, {
      pingable: true,
      heartbeat: { intervalMs: 10, timeoutMs: 40 },
    });
    await c.connect();
    const first = dial.last();

    // The peer answers nothing — a NAT that reaped the flow, a suspended host.
    await vi.waitFor(() => expect(first.client.pings).toBeGreaterThan(0), { timeout: 2_000 });
    await vi.waitFor(() => expect(first.client.terminated).toBe(true), { timeout: 2_000 });
    // And the reconnect loop takes it from there, which is the whole point of
    // noticing.
    await vi.waitFor(() => expect(dial.pairs.length).toBeGreaterThan(1), { timeout: 2_000 });
  });

  it("keeps a pong-less link alive: a socket that cannot ping is not torn down", async () => {
    const core = remoteRig();
    // No ping surface (a plain browser WebSocket) — the heartbeat does not arm,
    // because a peer that was never pinged has not failed to answer.
    const { client: c, dial } = makeClient(core, {
      pingable: false,
      heartbeat: { intervalMs: 10, timeoutMs: 20 },
    });
    await c.connect();

    await new Promise((r) => setTimeout(r, 80));
    expect(dial.pairs).toHaveLength(1);
    expect(c.isConnected()).toBe(true);
  });

  it("stops reconnecting on close()", async () => {
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();

    c.close();
    dial.last().server.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(dial.pairs).toHaveLength(1);
    expect(c.isConnected()).toBe(false);
  });

  it("says a reconnect is coming, and stops saying it once hung up on (#396)", async () => {
    // The predicate a wait reads to decide whether a drop is worth sitting out.
    // Not the same question as "is a timer armed right now": between the socket
    // dying and the backoff firing there is no timer, and the answer is still
    // yes because this client is what it is. What ends it is `close()` — this
    // client hanging up, after which nothing is coming.
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();

    expect(c.willReconnect()).toBe(true);
    dial.last().server.close();
    expect(c.isConnected()).toBe(false);
    expect(c.willReconnect()).toBe(true);

    c.close();
    expect(c.willReconnect()).toBe(false);
  });

  it("resumes a restarted client's timeline from the store it was given", async () => {
    const core = remoteRig();
    core.eventLog.appendEvent("task:created", "{}", { taskId: "t1" });
    core.eventLog.appendEvent("task:updated", "{}", { taskId: "t1" });
    const storage = new InMemoryCoreLinkCursorStorage();

    const first = makeClient(core, { storage });
    await first.client.connect();
    await vi.waitFor(() => expect(first.client.getLastEventId()).toBe(2));
    first.client.close();

    // A second client — a restarted process — handed the same store. It asks for
    // the tail past what its predecessor saw, not for the whole log.
    core.eventLog.appendEvent("session:finished", "{}", { taskId: "t1" });
    const second = makeClient(core, { storage });
    const seen: number[] = [];
    second.client.onEvent(({ event }) => seen.push(event.eventId));
    await second.client.connect();
    await vi.waitFor(() => expect(second.client.isCaughtUp()).toBe(true));

    expect(second.dial.last().client.framesOfType("subscribe")[0]).toMatchObject({
      lastEventId: 2,
    });
    expect(seen).toEqual([3]);
  });

  it("subscribes on a loopback Core too, whichever of ready and writability lands last", async () => {
    // No auth gate and no bearer: the trusted loopback shape, where there is no
    // `authOk` to hang the connection's opening frames off and writability rides
    // the socket opening instead. Establishment waits for *both* signals rather
    // than assuming an order — a `subscribe` sent against a socket that is not
    // writable yet is dropped, and a client that dropped its subscribe never
    // receives an event again.
    rig = startCoreRig();
    rig.eventLog.appendEvent("task:created", "{}", { taskId: "t1" });
    const dial = rig.dialer();
    client = new DurableCoreClient({
      url: URL_A,
      bearer: null,
      createSocket: dial.createSocket,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5,
      heartbeat: false,
    });
    const durable = client;
    const seen: number[] = [];
    durable.onEvent(({ event }) => seen.push(event.eventId));

    await durable.connect();
    await vi.waitFor(() => expect(durable.isCaughtUp()).toBe(true));

    expect(dial.last().client.framesOfType("auth")).toHaveLength(0);
    expect(dial.last().client.framesOfType("subscribe")).toHaveLength(1);
    expect(seen).toEqual([1]);
  });

  it("sends reclaim and subscribe ahead of a caller's queued request", async () => {
    // The loopback shape again, for the ordering it is the only place to see:
    // writability rides the socket opening, so it can land before `ready`. A
    // queue flushed on writability alone would put this caller's `replay` on the
    // wire first, and the Core would answer it while the Sessions this client is
    // reclaiming still belonged to the socket this one replaced — the ordering
    // `onConnectionEstablished` documents as load-bearing, tested rather than
    // asserted in a comment.
    rig = startCoreRig();
    const core = rig;
    const pair = new FakeSocketPair();
    const createSocket = () => {
      queueMicrotask(() => pair.open());
      setTimeout(() => core.wss.accept(pair.server), 5);
      return pair.client.asClientSocket();
    };
    client = new DurableCoreClient({
      url: URL_A,
      bearer: null,
      createSocket,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5,
      heartbeat: false,
    });
    const durable = client;

    const pending = durable.replay("pty-1");
    await durable.connect();
    await pending;

    const ordered = pair.client
      .frames()
      .map((f) => f.type)
      .filter((t) => t === "reclaim" || t === "subscribe" || t === "replay");
    expect(ordered).toEqual(["reclaim", "subscribe", "replay"]);
  });

  it("answers a connect() made mid-backoff with the connection that comes, not the one that died", async () => {
    // The gap between a socket dying and the backoff opening the next one. A
    // caller that asks to connect in there is asking about the link it is going
    // to have — answering out of the dead connection's state would hand it a
    // `coreId` of null and an incompatible protocol version for a Core that is
    // about to be perfectly reachable.
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();

    dial.last().server.close();
    const duringBackoff = c.connect();

    await expect(duringBackoff).resolves.toMatchObject({ compatible: true, coreId: "core_test" });
    expect(dial.pairs).toHaveLength(2);
  });

  it("stops handing back a rejected connect once the supervisor has reconnected", async () => {
    // The deadline on `connect()` and the supervisor underneath it are separate
    // clocks: the deadline can expire on a Core that is merely slow to come up,
    // and the backoff then reconnects perfectly well a moment later. A memoized
    // rejection would leave every later caller — #156's Panel migration included
    // — being told the client is unusable while its link is up and carrying
    // events.
    rig = startCoreRig();
    const core = rig;
    const pairs: FakeSocketPair[] = [];
    const createSocket = () => {
      const pair = new FakeSocketPair();
      pairs.push(pair);
      if (pairs.length === 1) {
        // The Core is not up yet: this socket dies without ever opening.
        queueMicrotask(() => pair.client.close());
      } else {
        core.wss.accept(pair.server);
        queueMicrotask(() => pair.open());
      }
      return pair.client.asClientSocket();
    };
    client = new DurableCoreClient({
      url: URL_A,
      bearer: null,
      createSocket,
      // A deadline that expires well before the backoff dials again, so the
      // rejection and the recovery are ordered the way the note describes.
      connectTimeoutMs: 1,
      reconnectInitialMs: 40,
      reconnectMaxMs: 40,
      heartbeat: false,
    });
    const durable = client;

    await expect(durable.connect()).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(durable.isConnected()).toBe(true));

    await expect(durable.connect()).resolves.toMatchObject({ compatible: true });
    // The retry read the live link rather than dialing over it.
    expect(pairs).toHaveLength(2);
  });

  it("leaves no orphan socket when a disconnect listener dials on the spot", async () => {
    // The window between a socket dying and the backoff arming. A listener that
    // calls `connect()` in there used to find no transport and no timer, dial a
    // socket of its own, and have it overwritten by the backoff's dial a moment
    // later — a live link plus an orphan nobody holds, which nothing will ever
    // close. The Panel registers disconnect handlers, so this is #156's window
    // rather than a hypothetical one.
    const core = remoteRig();
    const { client: c, dial } = makeClient(core);
    await c.connect();
    c.onDisconnected(() => {
      void c.connect().catch(() => {});
    });

    const first = dial.last();
    first.server.close();
    await vi.waitFor(() => expect(c.isConnected()).toBe(true));

    // One reconnect, one socket: the listener's call waited for the dial that
    // was already coming instead of racing one of its own.
    expect(dial.pairs).toHaveLength(2);
    expect(first.client.readyState).toBe(3);
  });

  it("gives every Core its own cursor key", () => {
    // Two Cores sharing a key would each replay from the other's position, and
    // the one that fell behind would lose the events in between.
    expect(coreLinkCursorStorageKey("wss://host:9444")).not.toBe(
      coreLinkCursorStorageKey("wss://host:9555"),
    );
    expect(coreLinkCursorStorageKey("wss://host:9444")).toBe(
      coreLinkCursorStorageKey("wss://host:9444"),
    );
  });
});
