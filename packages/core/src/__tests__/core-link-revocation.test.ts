// A revoked pairing, from the running Core's side of the link (#283).
//
// `actana pair revoke` runs in another process and stamps a row in the pairing
// store. Nothing about that is enforcement — the certificate is still one this
// Core's CA signed, the bearer still verifies against the same secret, and a
// link that is already open is still carrying frames. These tests are the three
// places the daemon makes it true:
//
//   1. a revoked certificate never becomes a registered connection,
//   2. a revoked bearer never passes the `auth` frame, and
//   3. a link a revoked client already holds is closed rather than left running
//      until a handshake that, for a healthy client, never comes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PtyCoreLinkServer,
  type CoreLinkPeer,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import { PairingRevocations, pairingBearerSubject } from "../core-pairing-revocation";
import type { PairedClient } from "@actana/shared/pairing-store";
import type { PtyCore } from "../pty-manager";

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
  ping(): void {}
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
  ofType<T extends Record<string, unknown>>(type: string): T[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === type) as T[];
  }
}

class FakeWebSocketServer {
  private connCb: ((ws: WebSocketLike, peer?: CoreLinkPeer) => void) | null = null;
  connect(ws: FakeWebSocket, peer?: CoreLinkPeer): void {
    this.connCb?.(ws as unknown as WebSocketLike, peer);
  }
  close(): void {}
  on(event: string, cb: Listener): void {
    if (event === "connection") this.connCb = cb as (ws: WebSocketLike, peer?: CoreLinkPeer) => void;
  }
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1", hooksReportTurnStart: true }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    findByTask: () => ({ ptyId: null }),
    replay: () => ({ data: "", nextSeq: 0, from: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

const NOW = 1_700_000_000_000;
const LIVE_SERIAL = "0a1b2c";
const REVOKED_SERIAL = "ff00ff";

function client(certSerial: string, revokedAt: number | null): PairedClient {
  return {
    certSerial,
    certSubject: `CN=${certSerial}`,
    label: certSerial,
    sessionId: "ps_1",
    pairedAt: NOW,
    certNotAfter: NOW + 1,
    revokedAt,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

let rows: PairedClient[];
let revocations: PairingRevocations;
let wss: FakeWebSocketServer;
let server: PtyCoreLinkServer;

/** A bearer verifier that answers for whichever pairing the test names. */
function verifierFor(serial: string) {
  return () => ({ ok: true as const, coreId: "core-1", exp: NOW + 1, sub: pairingBearerSubject(serial) });
}

type ServerOptions = ConstructorParameters<typeof PtyCoreLinkServer>[1];

function start(opts: Partial<ServerOptions> = {}): void {
  wss = new FakeWebSocketServer();
  server = new PtyCoreLinkServer(mockCore(), {
    port: 0,
    createServer: () => wss as unknown as WebSocketServerLike,
    revocation: revocations,
    ...opts,
  });
}

function connect(peer?: CoreLinkPeer): FakeWebSocket {
  const ws = new FakeWebSocket();
  wss.connect(ws, peer);
  return ws;
}

beforeEach(() => {
  rows = [client(LIVE_SERIAL, null), client(REVOKED_SERIAL, NOW)];
  revocations = new PairingRevocations({ listClients: () => rows });
  revocations.refresh();
});

afterEach(() => {
  server.close();
});

describe("a revoked certificate never becomes a connection", () => {
  it("is closed instead of registered", () => {
    start();
    const ws = connect({ certSerial: REVOKED_SERIAL });
    expect(ws.closed).toBe(true);
    // Not even a `ready`: a client whose certificate was revoked is not owed a
    // conversation by the Core that revoked it.
    expect(ws.sent).toEqual([]);
  });

  it("does not answer frames sent on it anyway", () => {
    start();
    const ws = connect({ certSerial: REVOKED_SERIAL });
    ws.receive({ type: "findByTask", reqId: "a1", taskId: "t1" });
    expect(ws.ofType("findByTaskResult")).toEqual([]);
  });

  it("leaves an unrevoked client alone", () => {
    start();
    const ws = connect({ certSerial: LIVE_SERIAL });
    expect(ws.closed).toBe(false);
    expect(ws.ofType("ready")).toHaveLength(1);
  });

  it("leaves a Core with no pairing surface alone", () => {
    // No `revocation` at all: a loopback Core has no pairing store, so there is
    // nothing on that machine that could have been revoked.
    start({ revocation: undefined });
    const ws = connect({ certSerial: REVOKED_SERIAL });
    expect(ws.closed).toBe(false);
    expect(ws.ofType("ready")).toHaveLength(1);
  });

  it("matches however the peer's serial is spelled", () => {
    start();
    // Node reports the peer certificate's serial in upper case; the store holds
    // whatever `@peculiar/x509` issued.
    expect(connect({ certSerial: REVOKED_SERIAL.toUpperCase() }).closed).toBe(true);
  });
});

describe("a revoked bearer never passes the auth frame", () => {
  it("is refused and the socket closed", () => {
    start({ authVerifier: verifierFor(REVOKED_SERIAL) });
    const ws = connect({ certSerial: null });
    ws.receive({ type: "auth", reqId: "a1", bearer: "whatever" });

    expect(ws.ofType("authOk")).toEqual([]);
    // `expired` rather than a fourth reason: the wire's three live in
    // `@actana/sdk`, and from where the client stands a revoked credential is
    // one whose validity ended. Its reconnect path leads to re-pairing, which
    // is where the operator who revoked it wants it to go.
    expect(ws.ofType<{ reason: string }>("authError")).toEqual([
      { type: "authError", reqId: "a1", reason: "expired" },
    ]);
    expect(ws.closed).toBe(true);
  });

  it("holds everything back that a pre-auth connection is held back from", () => {
    start({ authVerifier: verifierFor(REVOKED_SERIAL) });
    const ws = connect({ certSerial: null });
    ws.receive({ type: "auth", reqId: "a1", bearer: "whatever" });
    ws.receive({ type: "findByTask", reqId: "b1", taskId: "t1" });
    expect(ws.ofType("findByTaskResult")).toEqual([]);
  });

  it("lets an unrevoked pairing's bearer through", () => {
    start({ authVerifier: verifierFor(LIVE_SERIAL) });
    const ws = connect({ certSerial: null });
    ws.receive({ type: "auth", reqId: "a1", bearer: "whatever" });
    expect(ws.ofType("authOk")).toHaveLength(1);
    expect(ws.closed).toBe(false);
  });

  it("says nothing about a bearer that names no pairing at all", () => {
    // Bearers minted before pairing existed carry `{coreId, exp}`. They are
    // governed by their own expiry, not by a list they are not on.
    start({ authVerifier: () => ({ ok: true as const, coreId: "core-1", exp: NOW + 1 }) });
    const ws = connect({ certSerial: null });
    ws.receive({ type: "auth", reqId: "a1", bearer: "whatever" });
    expect(ws.ofType("authOk")).toHaveLength(1);
  });
});

describe("a link a revoked client already holds", () => {
  it("is closed rather than left running until the next handshake", () => {
    start();
    const ws = connect({ certSerial: LIVE_SERIAL });
    expect(ws.closed).toBe(false);

    // What the sweep hands the server one second after `actana pair revoke`.
    expect(server.closeRevoked([LIVE_SERIAL])).toBe(1);
    expect(ws.closed).toBe(true);
  });

  it("stops dispatching that client's frames on the way out", () => {
    start();
    const ws = connect({ certSerial: LIVE_SERIAL });
    server.closeRevoked([LIVE_SERIAL]);
    ws.receive({ type: "findByTask", reqId: "a1", taskId: "t1" });
    expect(ws.ofType("findByTaskResult")).toEqual([]);
  });

  it("closes a link identified only by the bearer it authenticated with", () => {
    // A client behind a terminating proxy presents this Core no certificate.
    // The pairing its bearer names is still the pairing that was revoked.
    start({ authVerifier: verifierFor(LIVE_SERIAL) });
    const ws = connect({ certSerial: null });
    ws.receive({ type: "auth", reqId: "a1", bearer: "whatever" });
    expect(ws.ofType("authOk")).toHaveLength(1);

    expect(server.closeRevoked([LIVE_SERIAL])).toBe(1);
    expect(ws.closed).toBe(true);
  });

  it("leaves every other client connected", () => {
    start();
    const revoked = connect({ certSerial: LIVE_SERIAL });
    const other = connect({ certSerial: "beef" });
    const loopback = connect();

    expect(server.closeRevoked([LIVE_SERIAL])).toBe(1);
    expect(revoked.closed).toBe(true);
    expect(other.closed).toBe(false);
    expect(loopback.closed).toBe(false);
    other.receive({ type: "findByTask", reqId: "b1", taskId: "t1" });
    expect(other.ofType("findByTaskResult")).toHaveLength(1);
  });

  it("closes every link that pairing holds, not just the first", () => {
    start();
    const first = connect({ certSerial: LIVE_SERIAL });
    const second = connect({ certSerial: LIVE_SERIAL });
    expect(server.closeRevoked([LIVE_SERIAL])).toBe(2);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
  });

  it("does nothing for a pairing holding no link", () => {
    start();
    connect({ certSerial: LIVE_SERIAL });
    expect(server.closeRevoked(["nothing-here"])).toBe(0);
  });
});
