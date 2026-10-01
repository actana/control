import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreLinkEvent } from "@actana/sdk/core";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import type { asCore } from "../core-identity";
import { appendEvent, configureEventLogStore, disposeEventLogStore, getLastEventId, readEventTail } from "../event-log-store";
import {
  PtyCoreLinkServer,
  type WebSocketLike,
  type WebSocketServerLike,
} from "../pty-core-link-server";
import type { PtyCore } from "../pty-manager";
import {
  isEventPath,
  parseSharedChange,
  SHARED_CHANGED_EVENT_KIND,
  startSharedFolder,
  type SharedFolder,
} from "../shared-folder-feed";

// The Shared folder's change feed, end to end (#561): the real event-log store on a
// real SQLite file, the real watcher on a real folder, and the real core-link server
// pushing to a connected client. Only the socket is a fake, as in the other
// core-link suites.

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
  receive(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((f) => f.type === type);
  }
  /** Every `shared:changed` event this client has been sent, live or replayed, in order. */
  sharedEvents(): Array<{ eventId: number; payload: { path: string; size: number; mtime: number; deleted: boolean } }> {
    return this.frames("event")
      .map((f) => f.event as CoreLinkEvent)
      .filter((e) => e.kind === SHARED_CHANGED_EVENT_KIND)
      .map((e) => ({ eventId: e.eventId, payload: JSON.parse(e.payload) }));
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

async function until(pred: () => boolean, ms = 5_000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

let tmp: string;
let home: string;
let shared: string;
let feed: SharedFolder | null;
let server: PtyCoreLinkServer | null;

const fast = { debounceMs: 30, fallbackScanMs: 100 };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-feed-"));
  home = path.join(tmp, "home");
  shared = path.join(home, "shared");
  fs.mkdirSync(home);
  const userData = path.join(tmp, "data");
  fs.mkdirSync(userData);
  bootstrapCoreDb(userData);
  configureEventLogStore(userData);
  feed = null;
  server = null;
});
afterEach(() => {
  feed?.stop();
  server?.close();
  disposeEventLogStore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connectClient(lastEventId: number): { ws: FakeWebSocket } {
  const wss = new FakeWebSocketServer();
  server = new PtyCoreLinkServer({ setEmitTarget: () => {}, killAll: () => {} } as unknown as PtyCore, {
    port: 0,
    createServer: () => wss as unknown as WebSocketServerLike,
    eventLog: { appendEvent, readEventTail, getLastEventId },
    liveEventPollMs: 5,
    shared: feed?.capability ?? undefined,
  });
  const ws = new FakeWebSocket();
  wss.connect(ws);
  ws.receive({ type: "subscribe", reqId: "s1", lastEventId });
  return { ws };
}

describe("boot: the Shared folder is never missing", () => {
  it("is created at boot when it is missing, and the Core says what it keeps", async () => {
    expect(fs.existsSync(shared)).toBe(false);
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    expect(fs.statSync(shared).isDirectory()).toBe(true);
    expect(feed.capability).toEqual({ version: 1, backend: "local" });
  });

  it("is created again at the next boot after it was deleted, with the old files gone", async () => {
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    fs.writeFileSync(path.join(shared, "x"), "1");
    feed.stop();
    fs.rmSync(shared, { recursive: true });

    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    expect(fs.statSync(shared).isDirectory()).toBe(true);
    expect(fs.readdirSync(shared)).toEqual([]);
  });

  it("is made again while the Core runs, if it is deleted under it", async () => {
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    fs.rmSync(shared, { recursive: true });
    await until(() => fs.existsSync(shared), 5_000, "the folder to come back");
  });

  it("leaves what is in an existing folder alone, and reports none of it", async () => {
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "old.md"), "before");
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.readFileSync(path.join(shared, "old.md"), "utf8")).toBe("before");
    expect(readEventTail(0).filter((e) => e.kind === SHARED_CHANGED_EVENT_KIND)).toEqual([]);
  });

  it("announces nothing, and does not crash the boot, when the folder cannot be one", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, shared);
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    expect(feed.capability).toBeNull();
  });
});

describe("a file written under the folder reaches a connected client", () => {
  it("as a shared:changed event within a bound, over the real log and server", async () => {
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    const { ws } = connectClient(0);
    expect(ws.frames("ready")[0]!.shared).toEqual({ version: 1, backend: "local" });

    const wrote = Date.now();
    fs.writeFileSync(path.join(shared, "report.md"), "hello world");
    await until(() => ws.sharedEvents().length > 0, 5_000, "the shared:changed event");
    const elapsed = Date.now() - wrote;

    const [event] = ws.sharedEvents();
    expect(event!.payload).toMatchObject({ path: "report.md", size: 11, deleted: false });
    expect(typeof event!.payload.mtime).toBe("number");
    // The kind is part of the wire contract: spelled out, not read back from the constant.
    expect(SHARED_CHANGED_EVENT_KIND).toBe("shared:changed");
    expect(readEventTail(0).some((e) => e.kind === "shared:changed")).toBe(true);
    expect(event!.eventId).toBeGreaterThan(0);
    // "Within seconds": debounce 30 ms plus a push poll of 5 ms leaves wide room.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("as deleted: true when the file is deleted", async () => {
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    fs.writeFileSync(path.join(shared, "gone.md"), "x");
    const { ws } = connectClient(0);
    await until(() => ws.sharedEvents().some((e) => e.payload.path === "gone.md"), 5_000, "the create");
    fs.rmSync(path.join(shared, "gone.md"));
    await until(() => ws.sharedEvents().some((e) => e.payload.deleted), 5_000, "the delete");
    expect(ws.sharedEvents().find((e) => e.payload.deleted)!.payload).toMatchObject({
      path: "gone.md",
      deleted: true,
    });
  });
});

describe("replay by cursor", () => {
  it("gives a client that was away exactly what it missed, in order, then eventsReplayed", async () => {
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    fs.writeFileSync(path.join(shared, "a.txt"), "a");
    await until(() => readEventTail(0).some((e) => e.kind === SHARED_CHANGED_EVENT_KIND), 5_000, "event a");
    const first = readEventTail(0).find((e) => e.kind === SHARED_CHANGED_EVENT_KIND)!;
    fs.writeFileSync(path.join(shared, "b.txt"), "bb");
    await until(
      () => readEventTail(0).filter((e) => e.kind === SHARED_CHANGED_EVENT_KIND).length === 2,
      5_000,
      "event b",
    );

    // Away after `a`: only `b` is replayed.
    const caughtUp = connectClient(first.eventId).ws;
    await until(() => caughtUp.frames("eventsReplayed").length > 0, 5_000, "the replay to end");
    expect(caughtUp.sharedEvents().map((e) => e.payload.path)).toEqual(["b.txt"]);

    // A fresh client from cursor 0 gets both, `a` first.
    server!.close();
    const fresh = connectClient(0).ws;
    await until(() => fresh.frames("eventsReplayed").length > 0, 5_000, "the full replay");
    expect(fresh.sharedEvents().map((e) => e.payload.path)).toEqual(["a.txt", "b.txt"]);
    const ids = fresh.sharedEvents().map((e) => e.eventId);
    expect(ids[0]!).toBeLessThan(ids[1]!);
  });

  it("gives nothing for a cursor already at the tip", async () => {
    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    fs.writeFileSync(path.join(shared, "a.txt"), "a");
    await until(() => readEventTail(0).some((e) => e.kind === SHARED_CHANGED_EVENT_KIND), 5_000, "event a");
    const { ws } = connectClient(getLastEventId()!);
    await until(() => ws.frames("eventsReplayed").length > 0, 5_000, "the replay to end");
    expect(ws.sharedEvents()).toEqual([]);
  });
});

describe("nothing outside the folder is reported", () => {
  it("makes no event for a symlink out of the folder, or for what is written behind it", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
    fs.mkdirSync(shared);
    fs.symlinkSync(outside, path.join(shared, "escape"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(shared, "secret-link.txt"));

    feed = await startSharedFolder({ home, appendEvent, watchOptions: fast });
    const { ws } = connectClient(0);
    fs.writeFileSync(path.join(outside, "secret.txt"), "changed behind the link");
    fs.writeFileSync(path.join(outside, "new.txt"), "new behind the link");
    fs.writeFileSync(path.join(shared, "inside.txt"), "ok");
    await until(() => ws.sharedEvents().some((e) => e.payload.path === "inside.txt"), 5_000, "the inside file");
    await new Promise((r) => setTimeout(r, 300));

    expect(ws.sharedEvents().map((e) => e.payload.path)).toEqual(["inside.txt"]);
  });
});

// ─── the container: the watcher is a child that runs as `core` ───────────────

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  exit(status: number): void {
    this.exitCode = status;
    this.emit("close", status);
  }
}

const identityEnv = { AC_CORE_HOME: "/home/core", AC_CORE_UID: "1000", AC_CORE_GID: "1000" };

function containerFeed(children: FakeChild[], extra: Record<string, unknown> = {}) {
  const specs: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const promise = startSharedFolder({
    home: "/home/core",
    appendEvent,
    identityEnv,
    wrap: ((spec: unknown) => spec) as typeof asCore,
    helperPath: "/opt/actana/app/core-shared-watch.cjs",
    killOptions: { identityEnv: {} },
    spawnChild: (spec) => {
      specs.push(spec);
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    },
    readyTimeoutMs: 2_000,
    restartMinMs: 20,
    ...extra,
  });
  return { promise, specs };
}

describe("in the container the daemon cannot read ~/shared, so a child that is core watches it", () => {
  it("starts the watcher bundle with an empty environment and announces once it is ready", async () => {
    const children: FakeChild[] = [];
    const { promise, specs } = containerFeed(children);
    children[0]!.say({ type: "ready", mode: "recursive" });
    feed = await promise;
    expect(feed.capability).toEqual({ version: 1, backend: "local" });
    expect(specs[0]!.args).toEqual(["/opt/actana/app/core-shared-watch.cjs"]);
    expect(specs[0]!.env).toEqual({});
  });

  it("turns each change the child reports into a shared:changed event", async () => {
    const children: FakeChild[] = [];
    const { promise } = containerFeed(children);
    children[0]!.say({ type: "ready", mode: "scan" });
    feed = await promise;
    children[0]!.say({
      type: "changes",
      changes: [
        { path: "reports/r1.md", size: 7, mtime: 1000, deleted: false },
        { path: "old.md", size: 0, mtime: 2000, deleted: true },
      ],
    });
    await until(() => readEventTail(0).filter((e) => e.kind === SHARED_CHANGED_EVENT_KIND).length === 2);
    const events = readEventTail(0).filter((e) => e.kind === SHARED_CHANGED_EVENT_KIND);
    expect(events.map((e) => JSON.parse(e.payload))).toEqual([
      { path: "reports/r1.md", size: 7, mtime: 1000, deleted: false },
      { path: "old.md", size: 0, mtime: 2000, deleted: true },
    ]);
  });

  it("drops a change whose path would leave the folder, and keeps the good ones", async () => {
    const children: FakeChild[] = [];
    const { promise } = containerFeed(children);
    children[0]!.say({ type: "ready", mode: "scan" });
    feed = await promise;
    children[0]!.say({
      type: "changes",
      changes: [
        { path: "../etc/passwd", size: 1, mtime: 1, deleted: false },
        { path: "/etc/passwd", size: 1, mtime: 1, deleted: false },
        { path: "a/../../b", size: 1, mtime: 1, deleted: false },
        { path: "ok.md", size: 1, mtime: 1, deleted: false },
      ],
    });
    await until(() => readEventTail(0).some((e) => e.kind === SHARED_CHANGED_EVENT_KIND));
    await new Promise((r) => setTimeout(r, 50));
    const paths = readEventTail(0)
      .filter((e) => e.kind === SHARED_CHANGED_EVENT_KIND)
      .map((e) => JSON.parse(e.payload).path);
    expect(paths).toEqual(["ok.md"]);
  });

  it("announces nothing when the child dies before it is ready, and starts it again", async () => {
    const children: FakeChild[] = [];
    const { promise } = containerFeed(children);
    children[0]!.exit(1);
    feed = await promise;
    expect(feed.capability).toBeNull();
    await until(() => children.length === 2, 2_000, "the restart");
  });

  it("announces nothing when the child never says ready, rather than hanging the boot", async () => {
    const children: FakeChild[] = [];
    const { promise } = containerFeed(children, { readyTimeoutMs: 80 });
    feed = await promise;
    expect(feed.capability).toBeNull();
  });

  it("stops the child, and does not start it again, on stop()", async () => {
    const children: FakeChild[] = [];
    const { promise } = containerFeed(children);
    children[0]!.say({ type: "ready", mode: "recursive" });
    feed = await promise;
    feed.stop();
    await until(() => children[0]!.signals.length > 0);
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    children[0]!.exit(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(children).toHaveLength(1);
  });

  it("ignores a line that is not JSON", async () => {
    const children: FakeChild[] = [];
    const { promise } = containerFeed(children);
    children[0]!.stdout.write("not json at all\n");
    children[0]!.say({ type: "ready", mode: "scan" });
    feed = await promise;
    expect(feed.capability).not.toBeNull();
  });
});

describe("what the feed will put in an event", () => {
  it("accepts a relative path and nothing that can climb, or is absolute, or has odd bytes", () => {
    for (const ok of ["a", "a/b.txt", "..hidden", "a/..b/c", "with space/ü.md"]) expect(isEventPath(ok)).toBe(true);
    for (const bad of ["", "/a", "../a", "a/..", "a/../b", "./a", "a//b", "a/", "a\\b", "a\0b", 7, null]) {
      expect(isEventPath(bad)).toBe(false);
    }
  });

  it("refuses a change with a bad size, mtime or deleted flag", () => {
    const good = { path: "a", size: 1, mtime: 2, deleted: false };
    expect(parseSharedChange(good)).toEqual(good);
    for (const bad of [
      { ...good, size: -1 },
      { ...good, size: "1" },
      { ...good, mtime: Number.NaN },
      { ...good, deleted: "no" },
      null,
    ]) {
      expect(parseSharedChange(bad)).toBeNull();
    }
  });
});
