// `CoreClient` against a real Core (issue 153, #129 D1/D2/D6).
//
// Every test here drives the Core's own `PtyCoreLinkServer` — including its
// bearer auth gate, which refuses any frame that arrives before `auth` and closes
// the socket. That gate is why the ordering assertions below are not
// bookkeeping: get it wrong and a real Core hangs up on you.

import { describe, it, expect, vi, afterEach } from "vitest";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { CORE_LINK_PROTOCOL_VERSION, SESSION_LOCKED_ERROR_CODE } from "../core-link-frames";
import {
  CoreClient,
  CoreLinkAuthError,
  CoreLinkRequestError,
  unwrapResponse,
} from "../core-client";
import { coreConnectionFromBlob } from "../core-registration-blob";
import { FakeSocketPair, startCoreRig, type CoreRig } from "./fake-core-link";

const SECRET = "core-client-suite-secret-32-bytes-x";

function bearerFor(coreId = "core_test", ttlMs = 60_000): string {
  return signBearer({ coreId, exp: Date.now() + ttlMs }, SECRET);
}

describe("CoreClient", () => {
  let rig: CoreRig | null = null;
  let client: CoreClient | null = null;

  afterEach(() => {
    client?.close();
    client = null;
    rig?.close();
    rig = null;
  });

  /** A Core with the remote shape: mTLS is elsewhere, the auth gate is here. */
  function authenticatingRig(): CoreRig {
    rig = startCoreRig({ authVerifier: (bearer) => verifyBearer(bearer, SECRET) });
    return rig;
  }

  async function connected(
    core: CoreRig,
    opts: { bearer?: string | null } = {},
  ): Promise<{ client: CoreClient; dial: ReturnType<CoreRig["dialer"]> }> {
    const dial = core.dialer();
    const bearer = opts.bearer === undefined ? bearerFor() : opts.bearer;
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer,
      createSocket: dial.createSocket,
    });
    await client.connect();
    return { client, dial };
  }

  it("resolves connect() with what the Core said on ready and authOk", async () => {
    const core = authenticatingRig();
    const dial = core.dialer();
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer: bearerFor("core_abc"),
      createSocket: dial.createSocket,
    });

    const info = await client.connect();

    expect(info).toEqual({
      protocolVersion: CORE_LINK_PROTOCOL_VERSION,
      compatible: true,
      multiConnection: { version: 1 },
      // This rig's Core announces no `files` capability (#165 F9) — it serves
      // no HTTP surface for one to point at. Null rather than absent: the field
      // is always reported, and "this Core has no file routes" is an answer.
      files: null,
      coreId: "core_abc",
      bearerExpiresAt: expect.any(Number),
    });
    expect(client.isAuthenticated()).toBe(true);
    expect(client.isConnected()).toBe(true);
  });

  it("sends auth as the first frame on the wire, before anything it was asked to do", async () => {
    const core = authenticatingRig();
    const dial = core.dialer();
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer: bearerFor(),
      createSocket: dial.createSocket,
    });

    // A request issued before the socket is even open. A Core answers
    // `not-authenticated` and closes on a frame that arrives ahead of `auth`, so
    // this must queue behind it rather than race it.
    const early = client.replay("pty-1");
    await client.connect();
    await expect(early).resolves.toEqual({ data: "scrollback", nextSeq: 7, from: undefined });

    const types = dial.last().client.frames().map((f) => f.type);
    expect(types[0]).toBe("auth");
    expect(types.filter((t) => t === "auth")).toHaveLength(1);
  });

  it("surfaces the Core's unsolicited ready frame — nothing asked for it", async () => {
    const core = authenticatingRig();
    const dial = core.dialer();
    const ready = vi.fn();
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer: bearerFor(),
      createSocket: dial.createSocket,
    });
    client.onReady(ready);
    await client.connect();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0]![0]).toMatchObject({
      protocolVersion: CORE_LINK_PROTOCOL_VERSION,
      compatible: true,
    });
    // The client never asked: `ready` carries no reqId and answers no request.
    const sentBeforeReady = dial.last().server.framesOfType("ready");
    expect(sentBeforeReady).toHaveLength(1);
    expect(sentBeforeReady[0]!.reqId).toBeUndefined();
  });

  it("rejects connect() with the reason when the Core refuses the bearer", async () => {
    const core = authenticatingRig();
    const dial = core.dialer();
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer: signBearer({ coreId: "core_x", exp: Date.now() - 1_000 }, SECRET),
      createSocket: dial.createSocket,
      connectTimeoutMs: 2_000,
    });

    const err = await client.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreLinkAuthError);
    expect((err as CoreLinkAuthError).reason).toBe("expired");
    expect(client.isAuthenticated()).toBe(false);
  });

  it("correlates concurrent requests by reqId", async () => {
    const core = authenticatingRig();
    const { client: c, dial } = await connected(core);

    const [spawned, found, replayed] = await Promise.all([
      c.spawn({ taskId: "t1", cwd: "/tmp", command: "claude", agent: "claude-code" }),
      c.findByTask("t1"),
      c.replay("pty-1", 3),
    ]);

    expect(spawned).toEqual({ ptyId: "pty-1" });
    expect(found).toEqual({ ptyId: "pty-1" });
    expect(replayed).toEqual({ data: "scrollback", nextSeq: 7, from: undefined });
    // Three questions, three distinct ids, and the Core answered each with the
    // id it was asked under.
    const asked = dial
      .last()
      .client.frames()
      .filter((f) => f.type === "spawn" || f.type === "findByTask" || f.type === "replay")
      .map((f) => f.reqId);
    expect(new Set(asked).size).toBe(3);
  });

  it("turns the Core's error frame into a rejection a caller can read", async () => {
    // A Core whose write path refuses the mutation. The server turns a thrown
    // mutation into an `error` frame carrying its message, which is the failure
    // shape every write on this link can produce.
    rig = startCoreRig({
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
      mutationPort: {
        mutateProject: () => {
          throw new Error("Folder not found");
        },
        mutateTask: () => {
          throw new Error("no such task");
        },
        listSessions: () => [],
      },
    });
    const { client: c } = await connected(rig);

    const err = await c
      .tasksMutate({ op: "update", taskId: "t1", title: "x" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreLinkRequestError);
    expect((err as Error).message).toBe("no such task");
    // No `code` on this frame, and none invented: a reader takes the code when
    // it is there and falls back to the message when it is not.
    expect((err as CoreLinkRequestError).code).toBeUndefined();
    await expect(c.projectsMutate({ op: "rename", projectId: "p1", name: "n" })).rejects.toThrow(
      "Folder not found",
    );
  });

  it("carries a coded error frame's code onto the rejection", () => {
    // The code is what lets a caller tell a Session another client holds — worth
    // retrying after a claim — from every other failure, without reading prose.
    const err = (() => {
      try {
        unwrapResponse({
          type: "error",
          reqId: "r1",
          message: "session is held by another connection",
          code: SESSION_LOCKED_ERROR_CODE,
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CoreLinkRequestError);
    expect((err as CoreLinkRequestError).code).toBe(SESSION_LOCKED_ERROR_CODE);
  });

  it("hands a router the raw response frame, error frames included", async () => {
    const core = authenticatingRig();
    const { client: c } = await connected(core);

    const frame = await c.request({ type: "write", reqId: "caller-owns-this", ptyId: "p", data: "x" });
    expect(frame).toMatchObject({ type: "writeResult", ok: true });
    // The caller's own reqId never reaches the wire — correlation belongs to the
    // one client that owns the socket.
    expect((frame as { reqId: string }).reqId).not.toBe("caller-owns-this");
  });

  it("surfaces data and exit frames as frames, parsed once", async () => {
    const core = authenticatingRig();
    const { client: c } = await connected(core);
    const data = vi.fn();
    const exit = vi.fn();
    c.onData(data);
    c.onExit(exit);

    // A Core fans a PTY out only to the connections that asked for it (ADR 0024
    // D2), so the subscription is what makes this client a recipient at all.
    await c.ptySubscribe("pty-9");
    core.ptyCore.emitEvent({ type: "data", ptyId: "pty-9", data: "hello", seq: 4 });
    core.ptyCore.emitEvent({ type: "exit", ptyId: "pty-9", exitCode: 3, signal: 9 });

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(data).toHaveBeenCalledWith({ type: "data", ptyId: "pty-9", data: "hello", seq: 4 });
    expect(exit).toHaveBeenCalledWith({ type: "exit", ptyId: "pty-9", exitCode: 3, signal: 9 });
  });

  it("presents its Core client id for reaping on connect", async () => {
    const core = authenticatingRig();
    const dial = core.dialer();
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer: bearerFor(),
      createSocket: dial.createSocket,
      clientId: "sdk-fixed-id",
    });
    const reclaimed = vi.fn();
    client.onReclaimed(reclaimed);
    await client.connect();

    await vi.waitFor(() => expect(reclaimed).toHaveBeenCalled());
    expect(dial.last().client.framesOfType("reclaim")[0]).toMatchObject({
      clientId: "sdk-fixed-id",
    });
    expect(reclaimed).toHaveBeenCalledWith({ replaced: false, taskIds: [] });
  });

  it("does not reconnect: a dropped socket is the end of a one-shot client", async () => {
    const core = authenticatingRig();
    const { client: c, dial } = await connected(core);
    const disconnected = vi.fn();
    c.onDisconnected(disconnected);

    dial.last().server.close();

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
    // 50ms is longer than any backoff a durable client would use, and this one
    // has none: no second dial, ever.
    await new Promise((r) => setTimeout(r, 50));
    expect(dial.pairs).toHaveLength(1);
    expect(c.isConnected()).toBe(false);
  });

  it("fails in-flight requests the moment the socket dies, not on their deadline", async () => {
    const core = authenticatingRig();
    const { client: c, dial } = await connected(core);

    // The Core stops reading — a machine gone to sleep mid-request. The frame is
    // genuinely in flight and its answer is never coming.
    dial.last().server.removeAllListeners();
    const pending = c.replay("pty-1");
    const settled = expect(pending).rejects.toThrow(/connection lost/);
    dial.last().server.close();
    await settled;
  });

  it("rejects everything outstanding on close()", async () => {
    const core = authenticatingRig();
    const { client: c, dial } = await connected(core);

    dial.last().server.removeAllListeners();
    const pending = c.replay("pty-1");
    const settled = expect(pending).rejects.toThrow(/client closed/);
    c.close();
    await settled;
  });

  it("times out a request the Core never answers", async () => {
    const core = authenticatingRig();
    const { client: c, dial } = await connected(core);

    dial.last().server.removeAllListeners();
    await expect(c.request({ type: "replay", reqId: "", ptyId: "pty-1" }, 20)).rejects.toThrow(
      /timed out/,
    );
  });

  it("refuses a multi-connection-only frame against a Core that announces nothing", async () => {
    rig = startCoreRig({
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
      announceMultiConnection: false,
    });
    const { client: c } = await connected(rig);

    expect(c.canSendMultiConnectionFrames()).toBe(false);
    expect(c.multiConnectionCapability()).toBeNull();
    // The gate degrades where a caller has somewhere to degrade to…
    await expect(c.claim("t1")).resolves.toEqual({ supported: false, granted: false });
    await expect(c.ptySubscribe("pty-1")).resolves.toBeUndefined();
    // …and refuses the frame outright for a caller that asked without checking.
    await expect(
      c.request({ type: "forceTakeover", reqId: "", taskId: "t1" }),
    ).rejects.toThrow(/multiConnection capability/);
  });

  it("reports an incompatible Core rather than half-using it", async () => {
    rig = startCoreRig({
      authVerifier: (bearer) => verifyBearer(bearer, SECRET),
      protocolVersion: "0.1.0",
    });
    const { client: c } = await connected(rig);

    expect(c.connectionInfo()).toMatchObject({ protocolVersion: "0.1.0", compatible: false });
  });

  it("dials with the endpoint, cert material and bearer off a registration blob", async () => {
    const core = authenticatingRig();
    const dial = core.dialer();
    const bearer = bearerFor("core_from_blob");
    const blob = {
      endpoint: "wss://core.test:9444",
      caCert: "CA-PEM",
      clientCert: "CLIENT-PEM",
      clientKey: "KEY-PEM",
      bearer,
    };

    // What a blob unpacks into — the endpoint AND the material, exposed rather
    // than only dialed with (#129's phase-3 guardrail).
    expect(coreConnectionFromBlob(blob)).toEqual({
      url: "wss://core.test:9444",
      httpsBaseUrl: "https://core.test:9444",
      tls: { ca: "CA-PEM", cert: "CLIENT-PEM", key: "KEY-PEM" },
      bearer,
    });

    client = CoreClient.fromRegistrationBlob(blob, { createSocket: dial.createSocket });
    const info = await client.connect();
    expect(info.coreId).toBe("core_from_blob");
    expect(client.url).toBe("wss://core.test:9444");
  });

  it("needs somewhere to dial", () => {
    expect(() => new CoreClient({})).toThrow(/url or a registration blob/);
  });

  it("dials again after a failed connect instead of replaying the rejection", async () => {
    // `connect()` is memoized so two callers racing share one socket. The memo
    // must not outlive the attempt: a client that failed once — a Core still
    // starting up, a laptop that had not joined the network yet — would
    // otherwise hand every later caller that same rejection for the rest of the
    // process, with no way back short of building another client.
    const core = authenticatingRig();
    const pairs: FakeSocketPair[] = [];
    const createSocket = () => {
      const pair = new FakeSocketPair();
      pairs.push(pair);
      if (pairs.length === 1) {
        // Nothing listening yet: the socket dies without ever opening.
        queueMicrotask(() => pair.client.close());
      } else {
        core.wss.accept(pair.server);
        queueMicrotask(() => pair.open());
      }
      return pair.client.asClientSocket();
    };
    client = new CoreClient({
      url: "wss://core.test:9444",
      bearer: bearerFor(),
      createSocket,
    });
    const c = client;

    await expect(c.connect()).rejects.toThrow(/core-link closed/);
    await expect(c.connect()).resolves.toMatchObject({ compatible: true });

    expect(pairs).toHaveLength(2);
    expect(c.isConnected()).toBe(true);
  });

  it("answers a connect() made on a live link without dialing a second one", async () => {
    const core = authenticatingRig();
    const { client: c, dial } = await connected(core);

    await expect(c.connect()).resolves.toMatchObject({ coreId: "core_test" });

    expect(dial.pairs).toHaveLength(1);
  });

  it("holds a queued caller request behind what the connection owed the Core", async () => {
    // The loopback shape, and the ordering that only shows up there: with no
    // bearer the link is writable the instant the socket opens, which can be
    // *before* the Core has said `ready`. Flushing the queue on writability
    // alone would put this caller's `replay` on the wire ahead of the `reclaim`
    // the connection owes — the opposite of what `onConnectionEstablished`
    // promises, and the same ordering assumption the establishment race had.
    rig = startCoreRig();
    const core = rig;
    const pair = new FakeSocketPair();
    const createSocket = () => {
      // Open first; the Core accepts — and so speaks its `ready` — only after.
      queueMicrotask(() => pair.open());
      setTimeout(() => core.wss.accept(pair.server), 5);
      return pair.client.asClientSocket();
    };
    client = new CoreClient({ url: "wss://core.test:9444", bearer: null, createSocket });
    const c = client;

    // Asked for before there is any link at all, so it is queued rather than sent.
    const pending = c.replay("pty-1");
    await c.connect();
    await pending;

    const ordered = pair.client
      .frames()
      .map((f) => f.type)
      .filter((t) => t === "reclaim" || t === "replay");
    expect(ordered).toEqual(["reclaim", "replay"]);
  });

  it("holds a request issued between writability and ready — the other door", async () => {
    // The sibling of the test above, at the moment the queue never sees. A
    // request asked for *before* there is a link is queued and flushed in order;
    // this one is asked for in the window where the socket is already writable
    // and `ready` has not landed, so it reaches `dispatch` with a writable
    // transport and would go straight out — ahead of the `reclaim` this
    // connection owes the Core, and out of a connection that is not established.
    // Same ordering property as note 2 of the #153 review, a different door
    // (#156).
    rig = startCoreRig();
    const core = rig;
    const pair = new FakeSocketPair();
    const createSocket = () => {
      queueMicrotask(() => pair.open());
      // Long enough that the window below is the test's, not a race with it.
      setTimeout(() => core.wss.accept(pair.server), 50);
      return pair.client.asClientSocket();
    };
    client = new CoreClient({ url: "wss://core.test:9444", bearer: null, createSocket });
    const c = client;

    const connecting = c.connect();
    // One tick: the socket opened, and with no bearer that is writability. The
    // Core has not been handed the connection yet, so no `ready` exists.
    await Promise.resolve();
    expect(c.isConnected()).toBe(true);

    const pending = c.replay("pty-1");
    // Held, not sent: nothing of this caller's is on the wire yet.
    expect(pair.client.framesOfType("replay")).toHaveLength(0);

    await connecting;
    await pending;

    const ordered = pair.client
      .frames()
      .map((f) => f.type)
      .filter((t) => t === "reclaim" || t === "replay");
    expect(ordered).toEqual(["reclaim", "replay"]);
  });

  it("authenticates nothing and is writable at once against a loopback Core", async () => {
    // No `authVerifier` on the Core, no bearer on the client: the trusted
    // loopback shape, where `auth` is a no-op and there is no `authOk` coming.
    rig = startCoreRig();
    const { client: c, dial } = await connected(rig, { bearer: null });

    expect(dial.last().client.framesOfType("auth")).toHaveLength(0);
    expect(c.isConnected()).toBe(true);
    await expect(c.write("pty-1", "ls\n")).resolves.toBe(true);
  });
});
