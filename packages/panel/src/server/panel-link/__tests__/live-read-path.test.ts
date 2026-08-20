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
  type CoreQueryPort,
} from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import type { PtyCore } from "@actana/core/pty-manager";
import { CORE_LINK_PROTOCOL_VERSION } from "@actana/sdk/core-link-frames";
import type {
  CoreLinkEvent,
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";

/**
 * The live read path, end to end: a real Core behind mTLS, the Panel service
 * dialing it, and a browser holding one panel link.
 *
 * Everything here is driven the way a tab drives it — frames on a WebSocket —
 * so "the Fleet view sees this Core's tasks" means the query actually crossed
 * two hops and came back, not that a fake resolved.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-link-live-"));
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
const BEARER_SECRET = "panel-link-live-test-secret-32-by";

// ─── The Panel service's HTTP server, with the panel link on it ──────────────

const panel = http.createServer((_req, res) => res.end("ok"));
attachPanelLink(panel);
await new Promise<void>((resolve) => panel.listen(0, "127.0.0.1", resolve));
const panelPort = (panel.address() as { port: number }).port;

// ─── A browser tab ───────────────────────────────────────────────────────────

/** One tab's panel link, with the handful of affordances the tests need. */
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

  send(frame: PanelLinkClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Ask one Core something and wait for the answer to that request. */
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

  subscribe(coreId: string, lastEventId: number): void {
    this.send({
      t: "core",
      coreId,
      frame: { type: "subscribe", reqId: `s${++this.seq}`, lastEventId },
    });
  }

  events(coreId: string): CoreLinkEvent[] {
    return this.received.flatMap((f) =>
      f.t === "core" && f.coreId === coreId && f.frame.type === "event" ? [f.frame.event] : [],
    );
  }

  close(): void {
    this.ws.close();
  }
}

// ─── A real Core on a real wss:// port ────────────────────────────────────

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

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: async () => ({ ptyCount: 0 }),
    findByTask: () => ({ ptyId: null }),
    // Which Session a `write`/`kill` would touch (issue 144) — the lookup
    // the Core's Session-lock gate resolves a ptyId through.
    taskIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
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

/** An event log a test can append to, standing in for the Core's own. */
function growableEventLog(): EventLogPort & { push(kind: string): number } {
  const events: CoreLinkEvent[] = [];
  return {
    push(kind) {
      const event: CoreLinkEvent = {
        eventId: events.length + 1,
        ts: Date.now(),
        kind,
        ptyId: null,
        taskId: null,
        payload: "{}",
      };
      events.push(event);
      return event.eventId;
    },
    appendEvent: () => 0,
    getLastEventId: () => events.length,
    readEventTail: (afterEventId) => events.filter((e) => e.eventId > afterEventId),
  };
}

const PROJECT: CoreLinkProjectSnapshot = {
  projectId: "proj_1",
  name: "warehouse",
  path: "/srv/warehouse",
  icon: "folder",
  iconColor: "#3b6ea5",
  pinned: false,
  rememberHarnessSettings: false,
  savedHarness: null,
  savedSkipPermissions: false,
  savedBareSession: false,
  defaultGridView: false,
  updatedAt: 1,
};

const TASK: CoreLinkTaskSnapshot = {
  taskId: "task_1",
  projectId: "proj_1",
  title: "restock the shelves",
  titleManuallySet: false,
  claudeSessionId: null,
  icon: null,
  agent: "claude-code",
  status: "running",
  archived: false,
  pinned: false,
  updatedAt: 2,
};

const ARCHIVED_TASK: CoreLinkTaskSnapshot = {
  taskId: "task_old",
  projectId: "proj_1",
  title: "last winter's stocktake",
  titleManuallySet: false,
  claudeSessionId: null,
  icon: null,
  agent: "claude-code",
  status: "done",
  archived: true,
  pinned: false,
  updatedAt: 1,
};

function queryPort(): CoreQueryPort {
  const scoped = (projectId: string | undefined) =>
    projectId && projectId !== PROJECT.projectId;
  return {
    listProjects: () => [PROJECT],
    listTasks: (projectId) => (scoped(projectId) ? [] : [TASK]),
    listArchivedTasks: (projectId) => (scoped(projectId) ? [] : [ARCHIVED_TASK]),
    countArchivedTasks: (projectId) => (scoped(projectId) ? 0 : 1),
    getTask: (taskId) => (taskId === TASK.taskId ? TASK : null),
  };
}

type CoreFixture = { server: PtyCoreLinkServer; blob: string; log: ReturnType<typeof growableEventLog> };

async function startCore(label: string, protocolVersion?: string): Promise<CoreFixture> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const bound = { port: await freePort() };
  const log = growableEventLog();
  const server = new PtyCoreLinkServer(mockCore(), {
    eventLog: log,
    queryPort: queryPort(),
    port: bound.port,
    host: "127.0.0.1",
    createServer: tlsCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer) => verifyBearer(bearer, BEARER_SECRET),
    protocolVersion,
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
  return { server, blob, log };
}

const running: PtyCoreLinkServer[] = [];
const tabs: Tab[] = [];
const paired: string[] = [];

/** Pair a Core the way the operator does — one paste — and wait for the dial. */
async function pair(
  label = "prod-vm-1",
  opts: { protocolVersion?: string; settlesAt?: string } = {},
): Promise<{ coreId: string; core: CoreFixture }> {
  const core = await startCore(label, opts.protocolVersion);
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
    expect(cores.find((c) => c.id === coreId)?.dial.state).toBe(opts.settlesAt ?? "connected");
  }, 10_000);
  return { coreId, core };
}

async function openTab(): Promise<Tab> {
  const tab = await Tab.open();
  tabs.push(tab);
  return tab;
}

afterEach(async () => {
  for (const tab of tabs.splice(0)) tab.close();
  // Forget each Core the way the operator would. The service's links (and the
  // router that watches them) live for the whole process here, exactly as they
  // do in production — tearing the manager down between tests would leave the
  // router holding a manager nobody dials through any more.
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

describe("the live read path, browser to Core", () => {
  it("answers a project query from the Core itself", async () => {
    const { coreId } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, { type: "projectsList" });

    expect(answer).toMatchObject({
      type: "projectsListResult",
      projects: [expect.objectContaining({ projectId: "proj_1", name: "warehouse" })],
    });
  });

  it("answers a task query, scoped to a project", async () => {
    const { coreId } = await pair();
    const tab = await openTab();

    const mine = await tab.ask(coreId, { type: "tasksList", projectId: "proj_1" });
    const theirs = await tab.ask(coreId, { type: "tasksList", projectId: "proj_other" });

    expect(mine.tasks).toEqual([expect.objectContaining({ taskId: "task_1" })]);
    expect(theirs.tasks).toEqual([]);
  });

  // ADR 0019: the tab learns how many archived Sessions a project holds
  // without a single archived row travelling the active answer. The rows come
  // back only when it asks for them, over their own frame.
  it("answers a task query with the archived count but never an archived row", { timeout: 20_000 }, async () => {
    const { coreId } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, { type: "tasksList", projectId: "proj_1" });

    const rows = answer.tasks as Array<{ archived: boolean }>;
    expect(rows).toEqual([expect.objectContaining({ taskId: "task_1" })]);
    expect(rows.every((t) => !t.archived)).toBe(true);
    expect(answer.archivedCount).toBe(1);
  });

  it("answers an archived task query, scoped to a project", { timeout: 20_000 }, async () => {
    const { coreId } = await pair();
    const tab = await openTab();

    const mine = await tab.ask(coreId, { type: "archivedTasksList", projectId: "proj_1" });
    const theirs = await tab.ask(coreId, { type: "archivedTasksList", projectId: "proj_other" });

    expect(mine).toMatchObject({ type: "archivedTasksListResult" });
    expect(mine.tasks).toEqual([expect.objectContaining({ taskId: "task_old", archived: true })]);
    expect(theirs.tasks).toEqual([]);
  });

  it("carries one tab's queries to several Cores over the one link", async () => {
    const first = await pair("vm-a");
    const second = await pair("vm-b");
    const tab = await openTab();

    const a = await tab.ask(first.coreId, { type: "projectsList" });
    const b = await tab.ask(second.coreId, { type: "projectsList" });

    expect(a.type).toBe("projectsListResult");
    expect(b.type).toBe("projectsListResult");
  });

  it("answers for a Core it cannot reach rather than leaving the tab waiting", async () => {
    const tab = await openTab();

    const answer = await tab.ask("core_nonexistent", { type: "projectsList" });

    expect(answer).toMatchObject({ type: "error", message: expect.stringContaining("connected") });
  });

  it("streams a change made on the Core to a watching tab", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();
    tab.subscribe(coreId, 0);

    core.log.push("task:statusChanged");

    await vi.waitFor(
      () => expect(tab.events(coreId).map((e) => e.kind)).toContain("task:statusChanged"),
      10_000,
    );
  });

  it("gives two tabs the same live view of one Core", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const one = await openTab();
    const two = await openTab();
    one.subscribe(coreId, 0);
    two.subscribe(coreId, 0);

    core.log.push("task:created");

    await vi.waitFor(() => {
      expect(one.events(coreId)).toHaveLength(1);
      expect(two.events(coreId)).toHaveLength(1);
    }, 10_000);
  });

  it("replays what a tab missed while its link was down", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair();
    const before = await openTab();
    before.subscribe(coreId, 0);
    core.log.push("task:created");
    await vi.waitFor(() => expect(before.events(coreId)).toHaveLength(1), 5_000);
    before.close();

    // Off the air while the fleet keeps working.
    core.log.push("task:statusChanged");
    core.log.push("session:finished");
    await vi.waitFor(() => expect(core.log.getLastEventId()).toBe(3));

    const after = await openTab();
    after.subscribe(coreId, 1);

    await vi.waitFor(
      () =>
        expect(after.events(coreId).map((e) => e.eventId)).toEqual(
          expect.arrayContaining([2, 3]),
        ),
      10_000,
    );
    expect(after.events(coreId).map((e) => e.eventId)).not.toContain(1);
  });
});

// The version gate, with a real Core that has drifted. Nothing is faked but
// the Core's own advertised version: the Panel dials it over mTLS, reads its
// `ready` frame, and decides — before any query — that this Core is a chore.
describe("a Core speaking a protocol this Panel does not", () => {
  it("settles as needs-update, naming both versions and staying reachable", { timeout: 20_000 }, async () => {
    const { coreId } = await pair("stale-vm", {
      protocolVersion: "0.1.0",
      settlesAt: "needs-update",
    });

    const listing = await handleApiRequest(
      new Request(`${ORIGIN}/api/cores`, { headers: { cookie: operatorSessionCookie() } }),
    );
    const { cores } = (await listing!.json()) as {
      cores: { id: string; dial: { state: string; coreVersion?: string; panelVersion?: string } }[];
    };
    const dial = cores.find((c) => c.id === coreId)!.dial;
    expect(dial.state).toBe("needs-update");
    expect(dial.coreVersion).toBe("0.1.0");
    expect(dial.panelVersion).toBe(CORE_LINK_PROTOCOL_VERSION);
  });

  it("refuses its queries instead of rendering half a Core", { timeout: 20_000 }, async () => {
    const { coreId } = await pair("stale-vm", {
      protocolVersion: "0.1.0",
      settlesAt: "needs-update",
    });
    const tab = await openTab();

    const projects = await tab.ask(coreId, { type: "projectsList" });
    const tasks = await tab.ask(coreId, { type: "tasksList" });

    expect(projects).toMatchObject({ type: "error", message: expect.stringMatching(/update/i) });
    expect(tasks).toMatchObject({ type: "error", message: expect.stringMatching(/update/i) });
  });

  it("keeps its events off every tab", { timeout: 20_000 }, async () => {
    const { coreId, core } = await pair("stale-vm", {
      protocolVersion: "0.1.0",
      settlesAt: "needs-update",
    });
    const tab = await openTab();
    tab.subscribe(coreId, 0);

    core.log.push("session:finished");

    // Give the push path the same window a live event would have had.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(tab.events(coreId)).toEqual([]);
  });

  it("leaves a matching Core on the same Panel working", async () => {
    const stale = await pair("stale-vm", {
      protocolVersion: "0.1.0",
      settlesAt: "needs-update",
    });
    const current = await pair("current-vm");
    const tab = await openTab();

    const refused = await tab.ask(stale.coreId, { type: "projectsList" });
    const answered = await tab.ask(current.coreId, { type: "projectsList" });

    expect(refused.type).toBe("error");
    expect(answered.type).toBe("projectsListResult");
  });
});
