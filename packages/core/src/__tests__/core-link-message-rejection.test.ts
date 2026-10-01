import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PtyCoreLinkServer,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";

// The `message` handler does not await `onMessage` (#600). A reply that throws
// — here a socket whose `readyState` read throws — rejected that promise with
// nobody listening, and Node ends the process on an unhandled rejection.

type Listener = (...args: unknown[]) => void;

class ThrowingSocket {
  broken = false;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};
  get readyState(): number {
    if (this.broken) throw new Error("socket exploded");
    return 1;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
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
}

describe("a reply that throws does not become an unhandled rejection (#600)", () => {
  let server: PtyCoreLinkServer | null = null;

  afterEach(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  it("logs the failure and keeps the process alive", async () => {
    let connCb: ((ws: WebSocketLike) => void) | null = null;
    const wss = {
      close() {},
      on(event: string, cb: (ws: WebSocketLike) => void) {
        if (event === "connection") connCb = cb;
      },
    };
    server = new PtyCoreLinkServer({ setEmitTarget() {}, killAll() {} } as unknown as PtyCore, {
      port: 0,
      createServer: () => wss as unknown as WebSocketServerLike,
    });
    const ws = new ThrowingSocket();
    connCb!(ws as unknown as WebSocketLike);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ws.broken = true;
      // Not a frame: the "invalid frame" reply is the write that throws.
      ws.emit("message", "not json");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[core]",
      "core-link.message.unhandled",
      { error: "socket exploded" },
    );
  });
});
