import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreLinkSharedMountStatus } from "@actana/sdk/core";
import {
  PtyCoreLinkServer,
  type CoreSharedPort,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";

// The three Shared-folder frames the controller pushes, as the core-link server answers
// them (#562). Each gets exactly one `sharedStatus` carrying its reqId, whatever happens,
// and the key in a frame is never logged or sent back.

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
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
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

const mockCore = (): PtyCore => ({ setEmitTarget: () => {}, killAll: () => {} }) as unknown as PtyCore;

const SECRET = "SECRET-ACCESS-KEY-VALUE";
const TOKEN = "SESSION-TOKEN-VALUE";
const attach = {
  type: "sharedAttach",
  reqId: "r-attach",
  endpoint: "http://s3.test",
  bucket: "b",
  prefix: "cores/core-a",
  region: "us-east-1",
  credentials: { accessKeyId: "AK", secretAccessKey: SECRET, sessionToken: TOKEN },
  expiresAt: "2026-10-01T13:00:00Z",
};

describe("Shared-folder frames on the core link (#562)", () => {
  let server: PtyCoreLinkServer;
  let ws: FakeWebSocket;
  let output: string[];

  function start(sharedPort?: CoreSharedPort): void {
    const wss = new FakeWebSocketServer();
    server = new PtyCoreLinkServer(mockCore(), {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
      liveEventPollMs: 5,
      ...(sharedPort ? { sharedPort } : {}),
    });
    ws = new FakeWebSocket();
    wss.connect(ws);
  }

  const statusFor = async (reqId: string): Promise<CoreLinkSharedMountStatus> => {
    await vi.waitFor(() => expect(ws.frames().some((f) => f.type === "sharedStatus" && f.reqId === reqId)).toBe(true));
    return ws.frames().find((f) => f.type === "sharedStatus" && f.reqId === reqId)!.status as CoreLinkSharedMountStatus;
  };

  beforeEach(() => {
    output = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    }
  });
  afterEach(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("hands each frame to the sync and answers with its status and the frame's reqId", async () => {
    const seen: string[] = [];
    start({
      handle: async (frame) => {
        seen.push(frame.type);
        return frame.type === "sharedDetach"
          ? { state: "detached", keptLocalCopy: true }
          : { state: "attached", expiresAt: "2026-10-01T13:00:00.000Z" };
      },
    });
    ws.emit("message", JSON.stringify(attach));
    expect(await statusFor("r-attach")).toEqual({ state: "attached", expiresAt: "2026-10-01T13:00:00.000Z" });
    ws.emit("message", JSON.stringify({ ...attach, type: "sharedCredentials", reqId: "r-creds" }));
    expect(await statusFor("r-creds")).toMatchObject({ state: "attached" });
    ws.emit("message", JSON.stringify({ type: "sharedDetach", reqId: "r-detach", keepLocalCopy: true }));
    expect(await statusFor("r-detach")).toEqual({ state: "detached", keptLocalCopy: true });
    expect(seen).toEqual(["sharedAttach", "sharedCredentials", "sharedDetach"]);
  });

  it("answers an invalid frame with a sharedStatus error, not a bare error, and never echoes it", async () => {
    start({ handle: async () => ({ state: "attached", expiresAt: "x" }) });
    ws.emit("message", JSON.stringify({ ...attach, credentials: { accessKeyId: "AK", secretAccessKey: SECRET } }));
    const status = await statusFor("r-attach");
    expect(status).toMatchObject({ state: "error", code: "invalid-frame" });
    expect(ws.sent.join("\n")).not.toContain(SECRET);
    expect(output.join("\n")).not.toContain(SECRET);
  });

  it("answers mount-failed on a Core with no sync", async () => {
    start();
    ws.emit("message", JSON.stringify(attach));
    expect(await statusFor("r-attach")).toMatchObject({ state: "error", code: "mount-failed" });
  });

  it("answers mount-failed, with no secret in it, when the sync throws", async () => {
    start({
      handle: async () => {
        throw new Error(`boom with ${SECRET} and ${TOKEN}`);
      },
    });
    ws.emit("message", JSON.stringify(attach));
    const status = await statusFor("r-attach");
    expect(status).toMatchObject({ state: "error", code: "mount-failed" });
    expect(JSON.stringify(ws.frames())).not.toContain(SECRET);
    expect(output.join("\n")).not.toContain(SECRET);
  });
});
