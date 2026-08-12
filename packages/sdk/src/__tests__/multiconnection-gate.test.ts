// The multiConnection gate, from the client's side (ADR 0024 D11, issue 143).
//
// These are the detectors the Panel's `multiconnection-capability.test.ts` held
// until #156 deleted the class they drove. The code they guard came across to
// this package in #153 and is correct — #195's review read it line by line and
// approved it — so nothing here is a bug report. What went missing is the
// pinning: the capability's lifecycle on a client, and the contents of the
// registry the gate consults, were asserted by nothing in this repo, which made
// a regression in either of them green. Restored against the client the Panel
// actually runs now, per section 2 of that review (issue 153, #156).
//
// Two properties, and the second is the one with teeth:
//
//  1. The capability is read off every `ready`, per connection, and never
//     remembered across one — a Core can be downgraded while a client is away.
//  2. Against a Core that does not announce it, a multi-connection-only frame is
//     not sent AT ALL. Not sent-and-tolerate-the-error: nothing reaches the
//     socket, so the Core never has to answer for a frame it does not know.
//
// Property 2's sharp edge is the *drop window*. A stale `true` would let a
// gated frame past the check and onto the outbound queue, which the next
// established connection drains unconditionally — so the frame would land on a
// Core that never said it could answer it. The deleted client's own comment
// called that edge load-bearing; the two tests that pinned it are below.
//
// Every reconnect here is a real second connection to a real
// `PtyCoreLinkServer`, and a Core that "comes back downgraded" is a second
// server that announces nothing — the one shape that cannot be built that way
// is `authOk` arriving before `ready`, which is hand-driven and says so.

import { describe, it, expect, vi, afterEach } from "vitest";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import type { CoreLinkRequestFrame } from "../core-link-frames";
import {
  CoreLinkRequestError,
  MULTI_CONNECTION_ONLY_FRAME_TYPES,
} from "../core-client";
import type { CoreLinkSocketFactory } from "../core-link-socket";
import { DurableCoreClient } from "../durable-core-client";
import {
  FakeSocketPair,
  handDrivenDialer,
  startCoreRig,
  type CoreRig,
} from "./fake-core-link";

const SECRET = "gate-suite-secret-32-bytes-long-xx";
const URL_A = "wss://core-a.test:9444";

/** The gated frame these tests put on the wire. `release` had no call site under test. */
const RELEASE: CoreLinkRequestFrame = { type: "release", reqId: "", taskId: "task_1" };

/**
 * One real frame per entry in the registry, so the gate is exercised for every
 * type it lists rather than for the two with a degrading call site. The set this
 * covers is asserted against the registry itself in the test that uses it.
 */
const GATED_FRAMES: CoreLinkRequestFrame[] = [
  { type: "ptySubscribe", reqId: "", ptyId: "pty_1", catchUp: false },
  { type: "ptyUnsubscribe", reqId: "", ptyId: "pty_1" },
  { type: "claim", reqId: "", taskId: "task_1" },
  { type: "release", reqId: "", taskId: "task_1" },
  { type: "forceTakeover", reqId: "", taskId: "task_1" },
  { type: "reclaim", reqId: "", clientId: "sdk-some-client" },
];

function bearerFor(coreId = "core_test"): string {
  return signBearer({ coreId, exp: Date.now() + 60_000 }, SECRET);
}

/**
 * Fire a request and swallow its settlement. These tests assert on what reached
 * the socket, never on the answer — and a frame still in flight when the
 * connection drops rejects by design.
 */
function fireAndForget(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

describe("the multiConnection gate on a durable Core client", () => {
  const rigs: CoreRig[] = [];
  const clients: DurableCoreClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const rig of rigs.splice(0)) rig.close();
  });

  /** A Core that announces the capability, with the remote shape's auth gate. */
  function coreThatAnnounces(): CoreRig {
    const rig = startCoreRig({ authVerifier: (bearer) => verifyBearer(bearer, SECRET) });
    rigs.push(rig);
    return rig;
  }

  /** The same Core, one release older: it answers `ready` and announces nothing. */
  function coreThatDoesNot(): CoreRig {
    const rig = startCoreRig({
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
      announceMultiConnection: false,
    });
    rigs.push(rig);
    return rig;
  }

  /**
   * Dial a sequence of Cores: the first connection reaches `cores[0]`, the
   * reconnect after it `cores[1]`, and every later one the last entry.
   *
   * That is what "the Core came back downgraded" is here — a second real server
   * on the same endpoint, announcing what that build announces — rather than a
   * `ready` frame written by the test.
   */
  function dialInTurn(cores: CoreRig[]): {
    createSocket: CoreLinkSocketFactory;
    pairs: FakeSocketPair[];
    last(): FakeSocketPair;
  } {
    const pairs: FakeSocketPair[] = [];
    const createSocket: CoreLinkSocketFactory = () => {
      const pair = new FakeSocketPair();
      pairs.push(pair);
      const core = cores[Math.min(pairs.length - 1, cores.length - 1)]!;
      core.wss.accept(pair.server);
      queueMicrotask(() => pair.open());
      return pair.client.asClientSocket();
    };
    return {
      createSocket,
      pairs,
      last: () => {
        const pair = pairs[pairs.length - 1];
        if (!pair) throw new Error("nothing dialed yet");
        return pair;
      },
    };
  }

  function clientOver(
    createSocket: CoreLinkSocketFactory,
    opts: { reconnectMs?: number } = {},
  ): DurableCoreClient {
    const client = new DurableCoreClient({
      url: URL_A,
      bearer: bearerFor(),
      createSocket,
      reconnectInitialMs: opts.reconnectMs ?? 5,
      reconnectMaxMs: opts.reconnectMs ?? 5,
      heartbeat: false,
    });
    clients.push(client);
    return client;
  }

  /** Wait until connection number `n` is up and has been served its replay tail. */
  async function connectionUp(
    client: DurableCoreClient,
    pairs: FakeSocketPair[],
    n: number,
  ): Promise<void> {
    await vi.waitFor(() => expect(pairs).toHaveLength(n));
    await vi.waitFor(() => expect(client.isCaughtUp()).toBe(true));
  }

  /** Every frame of one type this client wrote, across every connection it opened. */
  function sentAcross(pairs: FakeSocketPair[], type: string): Array<Record<string, unknown>> {
    return pairs.flatMap((pair) => pair.client.framesOfType(type));
  }

  describe("the capability's lifecycle on one client", () => {
    it("is closed before ready lands — the answer is unknown, not yes", async () => {
      const core = coreThatAnnounces();
      const pair = new FakeSocketPair();
      const createSocket: CoreLinkSocketFactory = () => {
        queueMicrotask(() => pair.open());
        // Long enough that the window below is the test's, not a race with it.
        setTimeout(() => core.wss.accept(pair.server), 50);
        return pair.client.asClientSocket();
      };
      const client = clientOver(createSocket);

      const connecting = client.connect();
      // One tick: the socket is open and its `auth` frame is out. The Core has
      // not been handed this connection yet, so no `ready` exists — and the gate
      // over an unknown answer is closed, not open.
      await Promise.resolve();
      expect(pair.client.framesOfType("auth")).toHaveLength(1);
      expect(client.canSendMultiConnectionFrames()).toBe(false);
      expect(client.multiConnectionCapability()).toBeNull();

      await connecting;
    });

    it("records the capability the Core announced on ready", async () => {
      const client = clientOver(coreThatAnnounces().dialer().createSocket);

      await client.connect();

      expect(client.canSendMultiConnectionFrames()).toBe(true);
      expect(client.multiConnectionCapability()).toEqual({ version: 1 });
    });

    it("does not carry it across a reconnect — it is re-read on the new ready", async () => {
      const dial = dialInTurn([coreThatAnnounces(), coreThatDoesNot()]);
      const client = clientOver(dial.createSocket);
      await client.connect();
      expect(client.canSendMultiConnectionFrames()).toBe(true);

      // The Core comes back downgraded: rolled back, or a different build on the
      // same endpoint. A remembered `true` here would send frames it cannot
      // answer, on a link that reports itself perfectly healthy.
      dial.last().server.close();
      await connectionUp(client, dial.pairs, 2);

      expect(client.canSendMultiConnectionFrames()).toBe(false);
      expect(client.multiConnectionCapability()).toBeNull();
    });

    it("closes the moment the link drops, not when the next one opens", async () => {
      const dial = coreThatAnnounces().dialer();
      // A backoff longer than this test, so the drop window is the whole of it:
      // what the gate says here is what it says with no Core on the other end.
      const client = clientOver(dial.createSocket, { reconnectMs: 10_000 });
      await client.connect();
      expect(client.canSendMultiConnectionFrames()).toBe(true);

      dial.last().server.close();

      expect(client.canSendMultiConnectionFrames()).toBe(false);
      expect(client.multiConnectionCapability()).toBeNull();
      expect(dial.pairs).toHaveLength(1);
    });

    it("picks it back up when an upgraded Core reconnects", async () => {
      const dial = dialInTurn([coreThatDoesNot(), coreThatAnnounces()]);
      const client = clientOver(dial.createSocket);
      await client.connect();
      expect(client.canSendMultiConnectionFrames()).toBe(false);

      dial.last().server.close();
      await connectionUp(client, dial.pairs, 2);

      expect(client.canSendMultiConnectionFrames()).toBe(true);
      expect(client.multiConnectionCapability()).toEqual({ version: 1 });
    });
  });

  describe("a refused frame is gone, not deferred", () => {
    it("does not queue it for a later flush", async () => {
      const dial = dialInTurn([coreThatDoesNot(), coreThatAnnounces()]);
      const client = clientOver(dial.createSocket);
      await client.connect();

      await expect(client.request(RELEASE)).rejects.toThrow(/multiConnection capability/);

      // A queued frame goes out when the socket next opens. Reconnect to a Core
      // that DOES announce the capability — which is the connection that would
      // carry it — and confirm nothing flushed.
      dial.last().server.close();
      await connectionUp(client, dial.pairs, 2);

      expect(sentAcross(dial.pairs, "release")).toEqual([]);
    });

    it("refuses it in the drop window, and nothing flushes when the socket reopens", async () => {
      const dial = dialInTurn([coreThatAnnounces()]);
      const client = clientOver(dial.createSocket);
      await client.connect();

      // The link drops. Nothing has re-announced anything yet, so a frame asked
      // for now must be refused outright — if a stale `true` let it past the
      // gate it would land on the queue, and the next established connection
      // drains that queue before it knows what this Core can answer.
      dial.last().server.close();
      const refused = client.request(RELEASE);
      fireAndForget(refused);

      // The Core that comes back DOES announce the capability, so the frame
      // would be allowed if it were asked for now: nothing about this connection
      // can explain a `release` on the wire, and only a flush of the queue
      // could. Which is why this assertion comes before the rejection one — a
      // frame that slipped past the gate is still pending rather than rejected,
      // so asserting the rejection first would fail as a timeout and say nothing
      // about the wire.
      await connectionUp(client, dial.pairs, 2);
      expect(sentAcross(dial.pairs, "release")).toEqual([]);

      await expect(refused).rejects.toThrow(/multiConnection capability/);
    });

    it("stops sending it again if the Core comes back downgraded", async () => {
      const dial = dialInTurn([coreThatAnnounces(), coreThatDoesNot()]);
      const client = clientOver(dial.createSocket);
      await client.connect();

      await expect(client.request(RELEASE)).resolves.toMatchObject({ type: "releaseResult" });
      expect(sentAcross(dial.pairs, "release")).toHaveLength(1);

      dial.last().server.close();
      await connectionUp(client, dial.pairs, 2);

      await expect(client.request(RELEASE)).rejects.toThrow(/multiConnection capability/);
      expect(sentAcross(dial.pairs, "release")).toHaveLength(1);
    });
  });

  describe("the gate's frame registry", () => {
    it("holds exactly the PTY subscription frames, the Session lock's three, and reclaim", () => {
      // Exact membership, not a superset check: this set is the whole statement
      // of what this build refuses to send to a single-connection Core, so a
      // type appearing here without the ticket that owns it, or one quietly
      // dropping out, is the thing to notice. `claim` / `release` /
      // `forceTakeover` (D3–D7) joined when the Session lock landed (issue 144)
      // — a Core that evicts every client but one has nothing for a lock to
      // arbitrate between, and no table to put a claim in. `reclaim` (issue 146,
      // D9) joined last: against such a Core the frame asks for the eviction
      // that Core has already performed, out of a lock table it does not have.
      expect([...MULTI_CONNECTION_ONLY_FRAME_TYPES].sort()).toEqual([
        "claim",
        "forceTakeover",
        "ptySubscribe",
        "ptyUnsubscribe",
        "reclaim",
        "release",
      ]);
    });

    it("puts every one of them through the gate, not only the ones with a call site", async () => {
      // `release`, `ptyUnsubscribe` and `reclaim` reach the gate from nowhere
      // else in this suite — their call sites either degrade first or are the
      // client's own — so without this they are in the registry untested.
      expect(new Set(GATED_FRAMES.map((frame) => frame.type))).toEqual(
        new Set(MULTI_CONNECTION_ONLY_FRAME_TYPES),
      );

      const dial = coreThatDoesNot().dialer();
      const client = clientOver(dial.createSocket);
      await client.connect();

      for (const frame of GATED_FRAMES) {
        await expect(client.request(frame)).rejects.toThrow(/multiConnection capability/);
        // The property that matters: nothing was written. The Core is never
        // asked to answer for a frame it does not know.
        expect(dial.last().client.framesOfType(frame.type)).toEqual([]);
      }
    });
  });

  describe("the single-connection fallback for PTY subscriptions", () => {
    it("asks for real once that Core comes back announcing the capability", async () => {
      const dial = dialInTurn([coreThatDoesNot(), coreThatAnnounces()]);
      const client = clientOver(dial.createSocket);
      await client.connect();

      // Nothing on the wire and nothing swallowed: such a Core fans that PTY out
      // to every connection already, so silence is the answer, not a failure.
      await expect(client.ptySubscribe("pty_1")).resolves.toBeUndefined();
      expect(sentAcross(dial.pairs, "ptySubscribe")).toEqual([]);

      dial.last().server.close();
      await connectionUp(client, dial.pairs, 2);

      // Why the want is remembered even when no frame went out. Nothing above
      // this client remembers the pane — a router binds a Core once, not once
      // per reconnect — so a want dropped here is a pane that goes dark against
      // the upgraded Core, which fans out to subscribers and nobody else.
      expect(sentAcross(dial.pairs, "ptySubscribe")).toMatchObject([
        { ptyId: "pty_1", catchUp: false },
      ]);
    });
  });

  describe("the reconnect resend and the ready/authOk ordering", () => {
    it("self-refuses if authOk ever arrives first — the ordering is the guard", async () => {
      // Not a wish for this order, a demonstration of what the order buys. The
      // capability is recorded by `ready` and the connection's opening frames go
      // out when the link becomes writable, which on a bearer link is `authOk`.
      // A Core that answered `auth` before it said `ready` would leave the
      // resend with no capability to read — and reading "unknown" as "absent"
      // would silently unsubscribe every held pane. Establishment waits for both
      // instead, so such a connection sends nothing at all.
      const dial = handDrivenDialer();
      const client = clientOver(dial.createSocket);

      const connecting = client.connect();
      await vi.waitFor(() => expect(dial.last().framesOfType("auth")).toHaveLength(1));
      dial.ready({ multiConnection: { version: 1 } });
      dial.authOk();
      await connecting;

      // Nothing answers this Core's RPCs, so the subscription is asserted on the
      // wire rather than awaited.
      fireAndForget(client.ptySubscribe("pty_1"));
      expect(dial.last().framesOfType("ptySubscribe")).toHaveLength(1);

      // Connection two accepts the bearer and never says who it is.
      dial.drop();
      await vi.waitFor(() => expect(dial.sockets).toHaveLength(2));
      await vi.waitFor(() => expect(dial.last().framesOfType("auth")).toHaveLength(1));
      dial.authOk();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Not one frame of what a connection owes — including the `subscribe`
      // that is not gated on the capability at all, which is what makes this an
      // assertion about establishment rather than about the gate.
      expect(dial.last().framesOfType("subscribe")).toEqual([]);
      expect(dial.last().framesOfType("reclaim")).toEqual([]);
      expect(dial.last().framesOfType("ptySubscribe")).toEqual([]);

      // And it recovers on the next connection that observes the real order,
      // because the want outlived the connection that could not express it.
      dial.drop();
      await vi.waitFor(() => expect(dial.sockets).toHaveLength(3));
      await vi.waitFor(() => expect(dial.last().framesOfType("auth")).toHaveLength(1));
      dial.ready({ multiConnection: { version: 1 } });
      dial.authOk();

      expect(dial.last().framesOfType("subscribe")).toHaveLength(1);
      expect(dial.last().framesOfType("ptySubscribe")).toMatchObject([
        { ptyId: "pty_1", catchUp: false },
      ]);
    });
  });

  describe("the Session lock over the gate", () => {
    it("distinguishes 'no lock on this Core' from 'someone else holds it'", async () => {
      // The one confusion that would matter downstream: `supported: false` and
      // `granted: false` both carry a false, and reading them the same way
      // renders a single-connection Core permanently read-only to the operator
      // who is in fact its only client.
      const announcing = coreThatAnnounces();
      const holder = clientOver(announcing.dialer().createSocket);
      await holder.connect();
      await expect(holder.claim("task_1")).resolves.toEqual({ supported: true, granted: true });

      // A second client on the same Core, asking for a Session that is held.
      const contender = clientOver(announcing.dialer().createSocket);
      await contender.connect();
      await expect(contender.claim("task_1")).resolves.toEqual({
        supported: true,
        granted: false,
      });

      // And a Core with no lock table at all, which is a different answer to a
      // different question — reached without asking it anything.
      const singleDial = coreThatDoesNot().dialer();
      const single = clientOver(singleDial.createSocket);
      await single.connect();
      await expect(single.claim("task_1")).resolves.toEqual({
        supported: false,
        granted: false,
      });
      expect(singleDial.last().client.framesOfType("claim")).toEqual([]);
    });

    it("leaves the code undefined on an error that carries none", async () => {
      // The field is additive and optional: every error that shipped before it
      // arrives without one, so a reader falls back to the message rather than
      // treating an absent code as a code. The coded sibling — a mutation
      // refused because another client holds the Session — is pinned in
      // `core-client.test.ts`.
      const core = coreThatAnnounces();
      // A Core whose kill throws. The server turns any handler failure into an
      // `error` frame carrying its message and nothing else.
      core.ptyCore.kill = vi.fn(() => {
        throw new Error("boom");
      });
      const client = clientOver(core.dialer().createSocket);
      await client.connect();

      const err = await client.kill("pty-1").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CoreLinkRequestError);
      expect((err as Error).message).toBe("boom");
      expect((err as CoreLinkRequestError).code).toBeUndefined();
    });
  });
});
