import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import { Server } from "node:net";
import WebSocket from "ws";
import {
  PtyCoreLinkServer,
  type WebSocketServerLike,
  type WebSocketLike,
  type EventLogPort,
} from "@actana/core/pty-core-link-server";
import { sliceReplayWindow } from "@actana/core/pty-replay-window";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import type { PtyCore } from "@actana/core/pty-manager";
import type { CoreLinkEvent, CoreLinkPtySpawnOptions } from "@actana/sdk/core-link-frames";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";
import { PanelLinkClient, type PanelLinkSocketLike } from "~/lib/panel-link-client";
import { corePtyBridgeFor } from "~/lib/core-pty-bridge";
import { createPtyStreamRouter } from "~/lib/pty-stream-router";

/**
 * Terminals in the browser, end to end: a tab spawns a PTY on a real Core
 * across its panel link, types into it, watches the output come back, and — the
 * part that only a whole path can prove — survives losing the link mid-session
 * and picks the session back up with nothing repeated and nothing missing.
 *
 * The Core here runs the real core-link server behind real mTLS; what stands
 * in is the PTY itself, because a test that shells out to a login shell asserts
 * the operating system, not this code. The stand-in keeps a bounded ring with
 * per-chunk seqs and answers `replay` through the Core's own slicing, so the
 * replay contract under test is the shipped one.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-link-terminals-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../../api-router");
const { closePanelDb, getPanelDb } = await import("../../panel-db");
const { operatorSessionCookie } = await import("../../__tests__/_operator-session");
const { attachPanelLink } = await import("../ws-server");
const { PANEL_LINK_PATH, PANEL_LINK_PROTOCOL_VERSION, PANEL_LINK_VERSION_PARAM } = await import(
  "~/shared/panel-link"
);

const ORIGIN = "http://panel.example.test";
const BEARER_SECRET = "panel-link-term-test-secret-32-b";

const panel = http.createServer((_req, res) => res.end("ok"));
attachPanelLink(panel);
await new Promise<void>((resolve) => panel.listen(0, "127.0.0.1", resolve));
const panelPort = (panel.address() as { port: number }).port;

// ─── A browser tab ───────────────────────────────────────────────────────────

class Tab {
  private readonly ws: WebSocket;
  readonly received: PanelLinkServerFrame[] = [];
  private seq = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => this.received.push(JSON.parse(String(raw)) as PanelLinkServerFrame));
  }

  static open(): Promise<Tab> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${panelPort}${PANEL_LINK_PATH}?${PANEL_LINK_VERSION_PARAM}=${PANEL_LINK_PROTOCOL_VERSION}`,
      { headers: { cookie: operatorSessionCookie() } },
    );
    const tab = new Tab(ws);
    return new Promise((resolve, reject) => {
      ws.on("open", () => resolve(tab));
      ws.on("error", reject);
    });
  }

  async ask(coreId: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reqId = `t${++this.seq}`;
    this.send({ t: "core", coreId, frame: { ...frame, reqId } } as PanelLinkClientFrame);
    const find = (): Record<string, unknown> | undefined => {
      for (const f of this.received) {
        if (f.t !== "core") continue;
        const answer = f.frame as unknown as Record<string, unknown>;
        if (answer.reqId === reqId) return answer;
      }
      return undefined;
    };
    await vi.waitFor(() => expect(find()).toBeDefined(), 5_000);
    return find()!;
  }

  send(frame: PanelLinkClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Watch a Core — what the PTY bridge does when a terminal opens on it. */
  watch(coreId: string): void {
    this.send({
      t: "core",
      coreId,
      frame: { type: "subscribe", reqId: `s${++this.seq}`, lastEventId: 0 },
    });
  }

  /** Everything this tab has painted for one pty, in arrival order. */
  output(coreId: string, ptyId: string): string {
    return this.received
      .flatMap((f) =>
        f.t === "core" && f.coreId === coreId && f.frame.type === "data" && f.frame.ptyId === ptyId
          ? [f.frame.data]
          : [],
      )
      .join("");
  }

  /** The highest seq this tab has seen for a pty — its reattach cursor. */
  cursor(coreId: string, ptyId: string): number {
    let seq = -1;
    for (const f of this.received) {
      if (f.t !== "core" || f.coreId !== coreId) continue;
      if (f.frame.type === "data" && f.frame.ptyId === ptyId && f.frame.seq > seq) {
        seq = f.frame.seq;
      }
    }
    return seq;
  }

  exits(coreId: string, ptyId: string): number[] {
    return this.received.flatMap((f) =>
      f.t === "core" && f.coreId === coreId && f.frame.type === "exit" && f.frame.ptyId === ptyId
        ? [f.frame.exitCode]
        : [],
    );
  }

  close(): void {
    this.ws.close();
  }
}

// ─── A browser running the real client stack ────────────────────────────────
//
// `Tab` above speaks frames by hand, which is the right instrument for what the
// service does with them. It cannot prove what the *browser* does, though —
// what a tab re-sends when its socket comes back is a decision that lives in
// `PanelLinkClient`, so the reconnect test drives the shipped client, the
// shipped PTY bridge and the shipped stream router, and asserts on what a pane
// would have painted.

type Browser = {
  link: PanelLinkClient;
  /** Kill the socket and refuse the retries, the way a closed lid does. */
  offline(): void;
  /** Let the client's next attempt through. */
  online(): void;
};

function adaptBrowserSocket(ws: WebSocket): PanelLinkSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    addEventListener: (type: string, cb: (arg: never) => void) => {
      if (type === "message") {
        ws.on("message", (raw) =>
          (cb as unknown as (event: { data: unknown }) => void)({ data: String(raw) }),
        );
        return;
      }
      ws.on(type, () => (cb as unknown as () => void)());
    },
  } as PanelLinkSocketLike;
}

function openBrowser(): Browser {
  let socket: WebSocket | null = null;
  // The outage is held open rather than timed: the client retries as fast as it
  // is told to, and a test that raced its backoff would assert on whichever
  // side of the reconnect it happened to look at.
  let offline = false;
  const link = new PanelLinkClient({
    url: `ws://127.0.0.1:${panelPort}${PANEL_LINK_PATH}?${PANEL_LINK_VERSION_PARAM}=${PANEL_LINK_PROTOCOL_VERSION}`,
    reconnectInitialMs: 20,
    reconnectMaxMs: 20,
    createSocket: (url) => {
      if (offline) throw new Error("the tab is offline");
      socket = new WebSocket(url, { headers: { cookie: operatorSessionCookie() } });
      return adaptBrowserSocket(socket);
    },
  });
  browsers.push(link);
  return {
    link,
    offline: () => {
      offline = true;
      socket?.terminate();
    },
    online: () => {
      offline = false;
    },
  };
}

// ─── A Core whose PTYs are scripted ───────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = new Server();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") s.close(() => resolve(addr.port));
      else {
        s.close();
        reject(new Error("no port"));
      }
    });
  });
}

type ScriptedPty = {
  id: string;
  taskId: string;
  shellSession: boolean;
  ring: Array<{ seq: number; data: string }>;
  nextSeq: number;
  size: { cols: number; rows: number };
  input: string[];
};

type ScriptedCore = PtyCore & {
  ptys: Map<string, ScriptedPty>;
  spawned: CoreLinkPtySpawnOptions[];
  /** The PTY emits — what a real one does when its process writes. */
  emit(ptyId: string, data: string): void;
  /** Drop the oldest ring chunks, as a real ring does under pressure. */
  forgetBefore(ptyId: string, seq: number): void;
};

function scriptedCore(): ScriptedCore {
  const ptys = new Map<string, ScriptedPty>();
  const spawned: CoreLinkPtySpawnOptions[] = [];
  let emitTarget:
    | ((
        event:
          | { type: "data"; ptyId: string; data: string; seq: number }
          | { type: "exit"; ptyId: string; exitCode: number; signal?: number },
      ) => void)
    | null = null;
  let nextId = 0;

  const core = {
    ptys,
    spawned,
    setEmitTarget: (target: typeof emitTarget) => {
      emitTarget = target;
    },
    spawn: async (opts: CoreLinkPtySpawnOptions) => {
      spawned.push(opts);
      const id = `pty-${++nextId}`;
      ptys.set(id, {
        id,
        taskId: opts.taskId,
        shellSession: opts.shellSession === true,
        ring: [],
        nextSeq: 0,
        size: { cols: opts.cols ?? 80, rows: opts.rows ?? 24 },
        input: [],
      });
      return { ptyId: id };
    },
    emit: (ptyId: string, data: string) => {
      const p = ptys.get(ptyId);
      if (!p) return;
      const seq = p.nextSeq++;
      p.ring.push({ seq, data });
      emitTarget?.({ type: "data", ptyId, data, seq });
    },
    forgetBefore: (ptyId: string, seq: number) => {
      const p = ptys.get(ptyId);
      if (!p) return;
      p.ring = p.ring.filter((chunk) => chunk.seq >= seq);
    },
    write: (ptyId: string, data: string) => {
      const p = ptys.get(ptyId);
      if (!p) return false;
      p.input.push(data);
      // A shell echoes what you type; that echo is how the tab sees its own
      // keystroke land on the far machine.
      core.emit(ptyId, data);
      return true;
    },
    resize: (ptyId: string, cols: number, rows: number) => {
      const p = ptys.get(ptyId);
      if (!p) return false;
      p.size = { cols, rows };
      return true;
    },
    kill: (ptyId: string) => {
      if (!ptys.delete(ptyId)) return false;
      emitTarget?.({ type: "exit", ptyId, exitCode: 0 });
      return true;
    },
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: async () => ({ ptyCount: 0 }),
    findByTask: (taskId: string) => {
      for (const p of ptys.values()) {
        if (p.taskId === taskId && !p.shellSession) return { ptyId: p.id };
      }
      return { ptyId: null };
    },
    // The inverse (issue 144): which Session a `write`/`kill` would be
    // touching, which is what the Core resolves before consulting the Session
    // lock. Unlike `findByTask` it answers for every PTY, VM Shell Sessions
    // included.
    taskIdForPty: (ptyId: string) => ptys.get(ptyId)?.taskId ?? null,
    replay: (ptyId: string, sinceSeq?: number) => {
      const p = ptys.get(ptyId);
      if (!p) return { data: "", nextSeq: 0 };
      return sliceReplayWindow(p.ring, p.nextSeq, sinceSeq);
    },
    killAll: () => ptys.clear(),
  };
  return core as unknown as ScriptedCore;
}

function tlsCreateServer(bound: { port: number }) {
  return (opts: { port: number; host: string; tls?: any }): WebSocketServerLike => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebSocketServer } = require("ws") as typeof import("ws");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const https = require("node:https") as typeof import("node:https");
    const tlsServer = https.createServer({
      cert: opts.tls.serverCert,
      key: opts.tls.serverKey,
      ca: opts.tls.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    });
    tlsServer.listen(opts.port, opts.host, () => {
      const addr = tlsServer.address();
      if (addr && typeof addr === "object") bound.port = addr.port;
    });
    const wss = new WebSocketServer({ server: tlsServer });
    const live = new Set<import("ws").WebSocket>();
    return {
      close: (cb) => {
        for (const ws of live) ws.terminate();
        live.clear();
        wss.close(() => tlsServer.close(cb));
      },
      on: (event, cb) => {
        if (event === "connection") {
          wss.on("connection", (ws: import("ws").WebSocket) => {
            live.add(ws);
            ws.on("close", () => live.delete(ws));
            (cb as (ws: WebSocketLike) => void)(adapt(ws));
          });
        } else if (event === "error") {
          wss.on("error", (err: Error) => (cb as (err: Error) => void)(err));
        }
      },
    };
  };
}

function adapt(ws: import("ws").WebSocket): WebSocketLike {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      if (event === "message") ws.on("message", (d: unknown) => (cb as (d: unknown) => void)(d));
      else if (event === "close") ws.on("close", () => (cb as () => void)());
      else if (event === "error") ws.on("error", (e: Error) => (cb as (e: Error) => void)(e));
    },
    removeAllListeners: () => ws.removeAllListeners(),
  };
}

function eventLog(): EventLogPort & { all(): CoreLinkEvent[] } {
  const events: CoreLinkEvent[] = [];
  return {
    all: () => events,
    appendEvent: (
      kind: string,
      payload: string,
      keys?: { ptyId?: string | null; taskId?: string | null },
    ) => {
      const stored: CoreLinkEvent = {
        eventId: events.length + 1,
        ts: Date.now(),
        kind,
        ptyId: keys?.ptyId ?? null,
        taskId: keys?.taskId ?? null,
        payload,
      };
      events.push(stored);
      return stored.eventId;
    },
    getLastEventId: () => events.length,
    readEventTail: (afterEventId) => events.filter((e) => e.eventId > afterEventId),
  } as EventLogPort & { all(): CoreLinkEvent[] };
}

type CoreFixture = {
  server: PtyCoreLinkServer;
  blob: string;
  core: ScriptedCore;
  log: ReturnType<typeof eventLog>;
};

async function startCore(label: string): Promise<CoreFixture> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const bound = { port: await freePort() };
  const core = scriptedCore();
  const log = eventLog();
  const server = new PtyCoreLinkServer(core, {
    eventLog: log,
    port: bound.port,
    host: "127.0.0.1",
    createServer: tlsCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer) => verifyBearer(bearer, BEARER_SECRET),
  });
  await vi.waitFor(() => expect(bound.port).toBeGreaterThan(0));
  const blob = encodeRegistrationBlob({
    endpoint: `wss://127.0.0.1:${bound.port}`,
    label,
    caCert: material.ca.cert,
    clientCert: material.client.cert,
    clientKey: material.client.key,
    bearer: signBearer({ coreId: "core_fixture", exp: Date.now() + 600_000 }, BEARER_SECRET),
  });
  return { server, blob, core, log };
}

const running: PtyCoreLinkServer[] = [];
const tabs: Tab[] = [];
const browsers: PanelLinkClient[] = [];
const paired: string[] = [];

async function pair(label = "prod-vm-1"): Promise<{ coreId: string; core: CoreFixture }> {
  const core = await startCore(label);
  running.push(core.server);
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/cores`, {
      method: "POST",
      headers: { cookie: operatorSessionCookie(), "content-type": "application/json" },
      body: JSON.stringify({ registrationBlob: core.blob }),
    }),
  );
  const body = (await response!.json()) as { core: { id: string } };
  const coreId = body.core.id;
  paired.push(coreId);
  await vi.waitFor(async () => {
    const listing = await handleApiRequest(
      new Request(`${ORIGIN}/api/cores`, { headers: { cookie: operatorSessionCookie() } }),
    );
    const cores = ((await listing!.json()) as { cores: { id: string; dial: { state: string } }[] })
      .cores;
    expect(cores.find((c) => c.id === coreId)?.dial.state).toBe("connected");
  }, 10_000);
  return { coreId, core };
}

async function openTab(coreId?: string): Promise<Tab> {
  const tab = await Tab.open();
  tabs.push(tab);
  if (coreId) tab.watch(coreId);
  return tab;
}

// `satisfies` rather than a plain object: the reconnect test hands this to the
// real bridge's `spawn`, which is typed, while the hand-rolled `Tab` still
// sends it as a bag of fields.
const HARNESS_SPAWN = {
  taskId: "task_1",
  cwd: "/srv/warehouse",
  command: "claude",
  agent: "claude-code",
  cols: 100,
  rows: 30,
} satisfies CoreLinkPtySpawnOptions;

afterEach(async () => {
  for (const link of browsers.splice(0)) link.close();
  for (const tab of tabs.splice(0)) tab.close();
  for (const coreId of paired.splice(0)) {
    await handleApiRequest(
      new Request(`${ORIGIN}/api/cores/${coreId}`, {
        method: "DELETE",
        headers: { cookie: operatorSessionCookie() },
      }),
    );
  }
  for (const server of running.splice(0)) server.close();
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
});

afterAll(async () => {
  await new Promise<void>((resolve) => panel.close(() => resolve()));
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("terminals in the browser", () => {
  it("spawns an agent session on the Core and streams its output to the tab", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);

    const spawned = await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN });
    expect(spawned.type).toBe("spawned");
    const ptyId = spawned.ptyId as string;

    core.core.emit(ptyId, "Welcome to Claude Code");

    await vi.waitFor(
      () => expect(tab.output(coreId, ptyId)).toBe("Welcome to Claude Code"),
      5_000,
    );
    // The Core sees the spawn size the browser measured, not a default.
    expect(core.core.ptys.get(ptyId)!.size).toEqual({ cols: 100, rows: 30 });
  });

  it("round-trips keystrokes, a resize and a kill", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);
    const ptyId = (await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;

    await tab.ask(coreId, { type: "write", ptyId, data: "ls -la\r" });
    await tab.ask(coreId, { type: "resize", ptyId, cols: 120, rows: 40 });

    expect(core.core.ptys.get(ptyId)!.input).toEqual(["ls -la\r"]);
    expect(core.core.ptys.get(ptyId)!.size).toEqual({ cols: 120, rows: 40 });
    // The echo comes back the same way any output does.
    await vi.waitFor(() => expect(tab.output(coreId, ptyId)).toBe("ls -la\r"), 5_000);

    await tab.ask(coreId, { type: "kill", ptyId });
    await vi.waitFor(() => expect(tab.exits(coreId, ptyId)).toEqual([0]), 5_000);
    expect(core.core.ptys.has(ptyId)).toBe(false);
  });

  it("keeps several terminals apart over the one link", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);

    const first = (await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;
    const second = (
      await tab.ask(coreId, {
        type: "spawn",
        opts: { ...HARNESS_SPAWN, taskId: "task_2" },
      })
    ).ptyId as string;

    core.core.emit(first, "first says hello");
    core.core.emit(second, "second says hi");

    await vi.waitFor(() => {
      expect(tab.output(coreId, first)).toBe("first says hello");
      expect(tab.output(coreId, second)).toBe("second says hi");
    }, 5_000);
  });

  it("reattaches a live agent session by task instead of spawning a second one", async () => {
    const { coreId } = await pair();
    const tab = await openTab(coreId);
    const ptyId = (await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;

    const found = await tab.ask(coreId, { type: "findByTask", taskId: "task_1" });

    expect(found).toMatchObject({ type: "findByTaskResult", ptyId });
  });

  it("opens a VM Shell Session on the Core's own machine", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);

    const spawned = await tab.ask(coreId, {
      type: "spawn",
      opts: { shellSession: true, taskId: "term_vm_1", command: "" },
    });
    const ptyId = spawned.ptyId as string;
    core.core.emit(ptyId, "operator@prod-vm-1:~$ ");

    // No project folder, no agent — and it streams like any other terminal.
    expect(core.core.spawned.at(-1)).toMatchObject({ shellSession: true });
    expect(core.core.ptys.get(ptyId)!.shellSession).toBe(true);
    await vi.waitFor(
      () => expect(tab.output(coreId, ptyId)).toBe("operator@prod-vm-1:~$ "),
      5_000,
    );
    // A VM shell is not agent work: reattach-by-task must not hand it back.
    expect(await tab.ask(coreId, { type: "findByTask", taskId: "term_vm_1" })).toMatchObject({
      ptyId: null,
    });
  });

  it("records the VM shell in the event log so a reconnecting tab can tell it apart", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);

    await tab.ask(coreId, {
      type: "spawn",
      opts: { shellSession: true, taskId: "term_vm_2", command: "" },
    });

    const spawns = core.log.all().filter((e) => e.kind === "pty:spawn");
    expect(JSON.parse(spawns.at(-1)!.payload)).toMatchObject({ shellSession: true });
  });

  it("shows the same session's stream in two tabs at once", async () => {
    const { coreId, core } = await pair();
    const one = await openTab(coreId);
    const two = await openTab(coreId);

    const ptyId = (await one.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;
    core.core.emit(ptyId, "shared output");

    await vi.waitFor(() => {
      expect(one.output(coreId, ptyId)).toBe("shared output");
      expect(two.output(coreId, ptyId)).toBe("shared output");
    }, 5_000);

    // And the second tab can drive it too — the session is not owned by a tab.
    await two.ask(coreId, { type: "write", ptyId, data: "q" });
    expect(core.core.ptys.get(ptyId)!.input).toEqual(["q"]);
  });

  // ─── Panes subscribe for the PTYs they render (issue 142) ───
  //
  // The Core sends a PTY's stream only to the connections that asked. The
  // *service* holds the one connection each Core gets, so what a tab claims and
  // releases has to be refcounted across every tab — otherwise one closing
  // silently blanks the panes of the others.

  it("keeps a pty flowing for the tab still rendering it when another tab closes", async () => {
    const { coreId, core } = await pair();
    const leaving = await openTab(coreId);
    const staying = await openTab(coreId);

    const ptyId = (await leaving.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN }))
      .ptyId as string;
    // Both panes claim the pty, as a mounted TerminalPane does.
    await leaving.ask(coreId, { type: "ptySubscribe", ptyId });
    await staying.ask(coreId, { type: "ptySubscribe", ptyId });

    leaving.close();
    // Give the service its close event before asserting on what survives it.
    await vi.waitFor(() => expect(true).toBe(true));
    core.core.emit(ptyId, "still watching");

    await vi.waitFor(() => expect(staying.output(coreId, ptyId)).toBe("still watching"), 5_000);
  });

  it("stops pulling a pty across the link once the last pane lets it go", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);
    const ptyId = (await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;
    await tab.ask(coreId, { type: "ptySubscribe", ptyId });

    core.core.emit(ptyId, "watched");
    await vi.waitFor(() => expect(tab.output(coreId, ptyId)).toBe("watched"), 5_000);

    const released = await tab.ask(coreId, { type: "ptyUnsubscribe", ptyId });
    expect(released).toMatchObject({ type: "ptyUnsubscribeAck", ptyId, subscribed: false });

    core.core.emit(ptyId, " and then unwatched");
    // The agent keeps running; its output simply stops crossing a link nobody
    // is reading it over — which is the whole point of D2.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tab.output(coreId, ptyId)).toBe("watched");
  });

  it("catches a reattaching pane up before the live stream reaches it", async () => {
    const { coreId, core } = await pair();
    const opener = await openTab(coreId);
    const ptyId = (await opener.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN }))
      .ptyId as string;
    core.core.emit(ptyId, "scrollback\n");

    // A pane opening on a pty it did not spawn: subscribe, then replay from its
    // own cursor. The replay carries the history; anything the pty emits after
    // it arrives live, behind it.
    const arriving = await openTab(coreId);
    await arriving.ask(coreId, { type: "ptySubscribe", ptyId, catchUp: true });
    const replay = await arriving.ask(coreId, { type: "replay", ptyId });
    expect(replay).toMatchObject({ data: "scrollback\n", from: 0 });

    core.core.emit(ptyId, "live\n");
    await vi.waitFor(() => expect(arriving.output(coreId, ptyId)).toBe("live\n"), 5_000);
  });

  it("keeps a claimed pane live when the tab's own link drops and comes back", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const browser = openBrowser();
    const bridge = corePtyBridgeFor(browser.link, coreId);
    const streams = createPtyStreamRouter(bridge);

    const { ptyId } = await bridge.spawn(HARNESS_SPAWN);
    const painted: string[] = [];
    streams.claim(ptyId, { data: (msg) => painted.push(msg.data), exit: () => {} });
    core.core.emit(ptyId, "before the drop\n");
    await vi.waitFor(() => expect(painted.join("")).toContain("before the drop"), 5_000);

    // The tab's socket dies. The service gives back every pty this tab was
    // rendering, and the Core deletes the subscription — the core-link never
    // dropped, so nothing down there re-adds it.
    browser.offline();
    await vi.waitFor(() => expect(browser.link.isConnected()).toBe(false), 10_000);
    await vi.waitFor(() => expect(core.server.ptySubscriptionCount()).toBe(0), 10_000);

    // Coming back has to re-ask. Nothing above the link does: the pane still
    // holds its claim and never noticed the gap, so if the link stays quiet
    // this pty is dead for the rest of the session.
    browser.online();
    await vi.waitFor(() => expect(browser.link.isConnected()).toBe(true), 10_000);
    await vi.waitFor(() => expect(core.server.ptySubscriptionCount()).toBe(1), 10_000);

    core.core.emit(ptyId, "after the tab came back\n");
    await vi.waitFor(() => expect(painted.join("")).toContain("after the tab came back"), 5_000);
  });

  it("reattaches after a dropped link with exactly what the tab missed", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const before = await openTab(coreId);
    const ptyId = (await before.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN }))
      .ptyId as string;

    core.core.emit(ptyId, "painted before the drop\n");
    await vi.waitFor(() => expect(before.output(coreId, ptyId)).toContain("before"), 5_000);
    const cursor = before.cursor(coreId, ptyId);
    before.close();

    // The agent keeps working while the operator's network is down.
    core.core.emit(ptyId, "ran while away\n");
    core.core.emit(ptyId, "still running\n");

    const after = await openTab(coreId);
    const replay = await after.ask(coreId, { type: "replay", ptyId, sinceSeq: cursor + 1 });

    expect(replay).toMatchObject({ type: "replayResult", from: cursor + 1 });
    // Exactly the gap: nothing repeated, nothing lost.
    expect(replay.data).toBe("ran while away\nstill running\n");

    // And the stream resumes live on the new link.
    core.core.emit(ptyId, "after reattach\n");
    await vi.waitFor(
      () => expect(after.output(coreId, ptyId)).toBe("after reattach\n"),
      5_000,
    );
  });

  it("tells a reattaching tab when the Core's buffer no longer covers the gap", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);
    const ptyId = (await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;

    core.core.emit(ptyId, "ancient\n");
    core.core.emit(ptyId, "old\n");
    core.core.emit(ptyId, "recent\n");
    // A long outage under a chatty agent: the ring rolled past the cursor.
    core.core.forgetBefore(ptyId, 2);

    const replay = await tab.ask(coreId, { type: "replay", ptyId, sinceSeq: 1 });

    // `from` past what was asked for is the signal the pane repaints on.
    expect(replay).toMatchObject({ from: 2, data: "recent\n" });
  });

  it("hands a fresh attach the whole scrollback", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const tab = await openTab(coreId);
    const ptyId = (await tab.ask(coreId, { type: "spawn", opts: HARNESS_SPAWN })).ptyId as string;
    core.core.emit(ptyId, "line one\n");
    core.core.emit(ptyId, "line two\n");

    const replay = await tab.ask(coreId, { type: "replay", ptyId });

    expect(replay).toMatchObject({ data: "line one\nline two\n", from: 0 });
  });
});
