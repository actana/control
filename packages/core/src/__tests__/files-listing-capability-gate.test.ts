// A Core without the file surface is never asked to list (#166, F9).
//
// The done-when clause is about a *client*, and the client this Core answers
// does not exist yet — `project.files.list` on the SDK is #167, running beside
// this ticket. What exists is the gate it consumes, and the gate is the whole
// mechanism: `files: { version: 1 }` on the `ready` frame, read by
// `readFilesCapability`, which is what `CoreClient.canUseFileRoutes()` returns
// the answer of. So this suite asserts the two halves that are here —
//
//   1. a Core that serves the listing route announces the capability, and a
//      Core that does not, announces nothing at all;
//   2. a client that consults the gate before making a request makes **no
//      request** against the second kind of Core,
//
// — with the second measured at the Core, by counting what arrives on its HTTP
// surface. The "client" below is four lines long on purpose: it is exactly the
// gate every real client has to write, and the assertion is about what does not
// reach the wire rather than about the client's own return value.
//
// What this file deliberately does not do is stand up an `@actana/sdk`
// `CoreClient` — the socket rig for one lives in that package's own tests, and
// both mismatch directions are already covered there (`files-capability.test.ts`
// in `packages/sdk`). The reader used here is the one that client is built on.
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFilesCapability, type CoreLinkEvent } from "@actana/sdk/core-link-frames";
import { createCoreFilesRequestHandler, type CoreFilesPort } from "../core-files-routes";
import {
  PtyCoreLinkServer,
  type EventLogPort,
  type PtyCoreLinkServerOptions,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore, PtyCoreEvent } from "../pty-manager";
import { cleanupTrees, makeTree } from "./files-fixture";

type Listener = (...args: unknown[]) => void;

/** Just enough socket to collect the `ready` frame a real server sends. */
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
  ready(): Record<string, unknown> {
    const frames = this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === "ready");
    expect(frames).toHaveLength(1);
    return frames[0]!;
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

function fakeEventLog(): EventLogPort {
  const events: CoreLinkEvent[] = [];
  return {
    appendEvent: (kind, payload, opts) => {
      const eventId = events.length + 1;
      events.push({ eventId, ts: eventId, kind, payload, ptyId: opts?.ptyId ?? null, taskId: opts?.taskId ?? null });
      return eventId;
    },
    readEventTail: (afterEventId, limit = 1_000) => events.filter((e) => e.eventId > afterEventId).slice(0, limit),
    getLastEventId: () => events.length,
  };
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: (_fn: ((event: PtyCoreEvent) => void) | null) => {},
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

/** Every request that reached the Core's HTTP surface, gate or no gate. */
let arrived: string[] = [];
let httpServer: http.Server;
let base: string;
let projects: Record<string, string> = {};
let linkServer: PtyCoreLinkServer | null = null;

const filesPort: CoreFilesPort = { projectRoot: (id) => projects[id] ?? null };

beforeEach(async () => {
  arrived = [];
  projects = { p1: makeTree({ "a.txt": "a", "src/b.txt": "b" }) };
  const routes = createCoreFilesRequestHandler({ filesPort });
  httpServer = http.createServer();
  httpServer.on("request", (req, res) => {
    arrived.push(`${req.method ?? "?"} ${req.url ?? ""}`);
    if (routes.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  linkServer?.close();
  linkServer = null;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  cleanupTrees();
});

/** The `ready` frame a real `PtyCoreLinkServer` sends, in either configuration. */
function readyFrameFrom(opts: Partial<PtyCoreLinkServerOptions>): Record<string, unknown> {
  const wss = new FakeWebSocketServer();
  linkServer = new PtyCoreLinkServer(mockCore(), {
    port: 0,
    createServer: () => wss as unknown as WebSocketServerLike,
    eventLog: fakeEventLog(),
    liveEventPollMs: 5,
    ...opts,
  });
  const ws = new FakeWebSocket();
  wss.connect(ws);
  return ws.ready();
}

/**
 * A client, reduced to the part #166 is about.
 *
 * Reads `ready`, consults the capability, and only then goes near the HTTPS
 * origin. `readFilesCapability` is the same reader `CoreClient.canUseFileRoutes`
 * answers from, so this is the shape of the gate rather than an imitation of
 * it — the affordance is withheld, and withheld *before* a request exists.
 */
async function listIfOffered(
  ready: Record<string, unknown>,
  projectId: string,
): Promise<{ asked: boolean; reason?: string; status?: number; body?: string }> {
  if (readFilesCapability(ready.files) === null) {
    return { asked: false, reason: "this Core announces no file surface on `ready`" };
  }
  const res = await fetch(`${base}/v1/projects/${projectId}/files/list`);
  return { asked: true, status: res.status, body: await res.text() };
}

const fileRoutes = (): ReturnType<typeof createCoreFilesRequestHandler> =>
  createCoreFilesRequestHandler({ filesPort });

describe("a Core that serves the listing route", () => {
  it("announces the capability on `ready`", () => {
    expect(readyFrameFrom({ httpRoutes: fileRoutes() }).files).toEqual({ version: 1 });
  });

  it("is asked, and answers the listing", async () => {
    const result = await listIfOffered(readyFrameFrom({ httpRoutes: fileRoutes() }), "p1");

    expect(result.asked).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain('"path":"a.txt"');
    expect(arrived).toEqual(["GET /v1/projects/p1/files/list"]);
  });

  it("announces version 1 for listing too, because no Core has ever shipped a version 1 without it", () => {
    // #165's routes and this ticket's listing ride the same unreleased train
    // (`beta/0.3.0`), so there is no Core anywhere announcing `files: {version:
    // 1}` that answers `GET /files` and 404s `GET /files/list`. Bumping to
    // version 2 would describe a Core that does not exist, and would make every
    // client that checks for 1 stop using a surface that works.
    expect(readFilesCapability(readyFrameFrom({ httpRoutes: fileRoutes() }).files)).toEqual({ version: 1 });
  });
});

describe("a Core with no file surface — every Core that shipped before this", () => {
  it("announces nothing, rather than a capability at version 0 or false", () => {
    const frame = readyFrameFrom({});
    expect("files" in frame).toBe(false);
    expect(readFilesCapability(frame.files)).toBe(null);
  });

  it("is not asked: the client withholds the affordance and issues no request at all", async () => {
    const result = await listIfOffered(readyFrameFrom({}), "p1");

    expect(result.asked).toBe(false);
    // The assertion the clause is actually about. Not "the request was refused"
    // — there was no request. A client that called and read the 404 as an
    // outage is the failure this gate exists to prevent (ADR 0028 D4).
    expect(arrived).toEqual([]);
  });

  it("gives a reason, so the affordance is missing rather than mysteriously broken", async () => {
    const result = await listIfOffered(readyFrameFrom({}), "p1");

    expect(result.reason).toContain("no file surface");
  });

  it("is not asked even though this Core's routes would in fact have answered", async () => {
    // The routes are mounted on the HTTP server this test stands up, so the
    // request would have succeeded. It is still not made: the client believes
    // `ready`, which is the contract, and a client that probes anyway is one
    // that has stopped feature-detecting.
    const result = await listIfOffered(readyFrameFrom({}), "p1");

    expect(result.asked).toBe(false);
    expect(arrived).toEqual([]);

    const proof = await fetch(`${base}/v1/projects/p1/files/list`);
    expect(proof.status).toBe(200);
  });
});

describe("a capability version this build has never seen", () => {
  it("is read as no file surface, so a client stays off the routes rather than guessing at a superset", async () => {
    const result = await listIfOffered({ type: "ready", files: { version: 7 } }, "p1");

    expect(result.asked).toBe(false);
    expect(arrived).toEqual([]);
  });
});
