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
  type CoreMutationPort,
} from "@actana/core/pty-core-link-server";
import { createDirectory, listDirectory } from "@actana/core/directory-browse";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import type { PtyCore } from "@actana/core/pty-manager";
import type {
  CoreLinkEvent,
  CoreLinkProjectSnapshot,
  CoreLinkTaskSnapshot,
} from "@actana/sdk/core-link-frames";
import type { PanelLinkClientFrame, PanelLinkServerFrame } from "~/shared/panel-link";

/**
 * The write path, end to end: a browser tab creates a project, starts a
 * session, pins and renames and re-icons things, and browses folders — all as
 * frames on one panel link, across the router, down a real mTLS core-link, to
 * a Core that owns the rows and the disk.
 *
 * Two claims are worth the setup. First, the Panel writes nothing: what comes
 * back is what the Core recorded. Second, a second tab sees the same
 * answers, because there is only one place the state lives.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-link-write-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../../api-router");
const { closePanelDb, getPanelDb } = await import("../../panel-db");
const { operatorSessionCookie } = await import("../../__tests__/_operator-session");
const { attachPanelLink } = await import("../ws-server");
const { coreLinkManager } = await import("../../services/core-link-manager");
const { registerCoreFromCredential } = await import("../../services/cores");
const { PANEL_LINK_PATH, PANEL_LINK_PROTOCOL_VERSION, PANEL_LINK_VERSION_PARAM } = await import(
  "~/shared/panel-link"
);

// Each test pairs a Core over real TLS and drives two WebSocket hops. That is
// comfortably under a second idle, and several seconds on a machine running the
// rest of the suite beside it — the default 5s budget is about the core, not
// about anything this file asserts.
vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "http://panel.example.test";
const BEARER_SECRET = "panel-link-write-test-secret-32-b";

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

  send(frame: PanelLinkClientFrame): void {
    this.ws.send(JSON.stringify(frame));
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
    await vi.waitFor(() => expect(find()).toBeDefined(), 15_000);
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

/** An in-memory event log, appended to by the server as mutations land. */
function eventLog(): EventLogPort {
  const events: CoreLinkEvent[] = [];
  return {
    appendEvent(kind, payload, opts) {
      const event: CoreLinkEvent = {
        eventId: events.length + 1,
        ts: events.length + 1,
        kind,
        ptyId: opts?.ptyId ?? null,
        taskId: opts?.taskId ?? null,
        payload,
      };
      events.push(event);
      return event.eventId;
    },
    getLastEventId: () => events.length,
    readEventTail: (afterEventId) => events.filter((e) => e.eventId > afterEventId),
  };
}

/**
 * A Core's project/task tables, standing in for its SQLite. It validates the
 * project path against the real filesystem the same way the store does — that
 * is the point of the write living here rather than in the Panel.
 */
function mutationPort(): CoreMutationPort {
  const projects = new Map<string, CoreLinkProjectSnapshot>();
  const tasks = new Map<string, CoreLinkTaskSnapshot>();
  let seq = 0;
  return {
    mutateProject(mutation) {
      if (mutation.op === "create") {
        if (!fs.existsSync(mutation.path) || !fs.statSync(mutation.path).isDirectory()) {
          throw new Error(`Not a folder on this machine: ${mutation.path}`);
        }
        const projectId = mutation.projectId ?? `proj_${++seq}`;
        const snapshot: CoreLinkProjectSnapshot = {
          projectId,
          name: mutation.name,
          path: mutation.path,
          icon: mutation.icon ?? "PR",
          iconColor: mutation.iconColor ?? "#3b6ea5",
          pinned: mutation.pinned ?? false,
          rememberHarnessSettings: false,
          savedHarness: null,
          savedSkipPermissions: false,
          savedBareSession: false,
          defaultGridView: false,
          updatedAt: ++seq,
        };
        projects.set(projectId, snapshot);
        return snapshot;
      }
      const existing = projects.get(mutation.projectId);
      if (!existing) return null;
      const next: CoreLinkProjectSnapshot = {
        ...existing,
        ...(mutation.op === "rename" ? { name: mutation.name } : {}),
        ...(mutation.op === "pin" ? { pinned: mutation.pinned } : {}),
        updatedAt: ++seq,
      };
      if (mutation.op === "archive") {
        projects.delete(mutation.projectId);
        return existing;
      }
      projects.set(next.projectId, next);
      return next;
    },
    mutateTask(mutation) {
      if (mutation.op === "create") {
        const taskId = mutation.taskId ?? `task_${++seq}`;
        const snapshot: CoreLinkTaskSnapshot = {
          taskId,
          projectId: mutation.projectId,
          title: mutation.title,
          titleManuallySet: false,
          claudeSessionId: null,
          agent: mutation.agent,
          status: mutation.status ?? "ready",
          pinned: false,
          archived: false,
          icon: mutation.icon ?? null,
          updatedAt: ++seq,
        };
        tasks.set(taskId, snapshot);
        return snapshot;
      }
      const existing = tasks.get(mutation.taskId);
      if (!existing) return null;
      if (mutation.op === "delete") {
        tasks.delete(mutation.taskId);
        return existing;
      }
      const next: CoreLinkTaskSnapshot = {
        ...existing,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.pinned === undefined ? {} : { pinned: mutation.pinned }),
        ...(mutation.icon === undefined ? {} : { icon: mutation.icon }),
        ...(mutation.status === undefined ? {} : { status: mutation.status }),
        updatedAt: ++seq,
      };
      tasks.set(next.taskId, next);
      return next;
    },
    listSessions: () =>
      [...tasks.values()].map((t) => ({
        taskId: t.taskId,
        ptyId: null,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
  };
}

type CoreCredential = Parameters<typeof registerCoreFromCredential>[0];
type CoreFixture = { server: PtyCoreLinkServer; credential: CoreCredential; disk: string };

/** The folder tree this Core owns — the one the picker will walk. */
function coreDisk(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "vm-home-")));
  fs.mkdirSync(path.join(home, "Documents"));
  fs.mkdirSync(path.join(home, "projects", "warehouse"), { recursive: true });
  fs.mkdirSync(path.join(home, ".hidden"));
  return home;
}

/**
 * Cert material is generated once for the file. Every Core here presents the
 * same CA and accepts the same client cert; what makes them distinct Cores is
 * the port they listen on and the disk they own. Regenerating keys per test is
 * seconds of CPU that prove nothing this suite is about.
 */
let sharedMaterial: Awaited<ReturnType<typeof generateCertMaterial>> | null = null;
async function certMaterial() {
  sharedMaterial ??= await generateCertMaterial({ hosts: ["127.0.0.1"] });
  return sharedMaterial;
}

async function startCore(label: string): Promise<CoreFixture> {
  const material = await certMaterial();
  const bound = { port: await freePort() };
  const disk = coreDisk();
  const server = new PtyCoreLinkServer(mockCore(), {
    eventLog: eventLog(),
    mutationPort: mutationPort(),
    directoryPort: {
      list: (requested) => listDirectory(requested, { home: disk }),
      create: (parent, name) => createDirectory(parent, name),
    },
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
  const credential = {
    endpoint: `wss://127.0.0.1:${bound.port}`,
    label,
    caCert: material.ca.cert,
    clientCert: material.client.cert,
    clientKey: material.client.key,
    bearer: signBearer({ coreId: "core_fixture", exp: Date.now() + 600_000 }, BEARER_SECRET),
  };
  return { server, credential, disk };
}

const running: PtyCoreLinkServer[] = [];
const tabs: Tab[] = [];
const paired: string[] = [];

async function pair(label = "prod-vm-1"): Promise<{ coreId: string; core: CoreFixture }> {
  const core = await startCore(label);
  running.push(core.server);
  // Registered through the service and dialled — the two calls the pairing
  // controller makes once a code has been redeemed. There is no `POST
  // /api/cores` to paste a blob at any more (#287). `operatorSessionCookie`
  // first because the registry row's foreign key points at the Operator, which
  // an HTTP registration used to create on the way past.
  operatorSessionCookie();
  const coreId = registerCoreFromCredential(core.credential).id;
  coreLinkManager().dial(coreId);
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

async function openTab(): Promise<Tab> {
  const tab = await Tab.open();
  tabs.push(tab);
  return tab;
}

afterEach(async () => {
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

describe("writing to a Core from the browser", () => {
  it("creates a project at a path the Core accepts", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "projectsMutate",
      mutation: {
        op: "create",
        name: "warehouse",
        path: path.join(core.disk, "projects", "warehouse"),
      },
    });

    expect(answer).toMatchObject({
      type: "projectsMutateResult",
      project: expect.objectContaining({ name: "warehouse" }),
    });
  });

  it("refuses a path that machine says is not a folder, with the Core's own words", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "projectsMutate",
      mutation: { op: "create", name: "ghost", path: path.join(core.disk, "nowhere") },
    });

    expect(answer.type).toBe("error");
    expect(String(answer.message)).toContain("Not a folder on this machine");
  });

  it("starts a session and hands back the row the Core recorded", async () => {
    const { coreId } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "tasksMutate",
      mutation: { op: "create", projectId: "proj_1", title: "restock", agent: "claude-code" },
    });

    expect(answer).toMatchObject({
      type: "tasksMutateResult",
      task: expect.objectContaining({ title: "restock", agent: "claude-code", status: "ready" }),
    });
  });

  it("shows a pin, a rename and an icon made in one tab to a second tab", async () => {
    const { coreId, core } = await pair();
    const author = await openTab();
    const observer = await openTab();

    const created = (
      await author.ask(coreId, {
        type: "projectsMutate",
        mutation: {
          op: "create",
          name: "warehouse",
          path: path.join(core.disk, "projects", "warehouse"),
        },
      })
    ).project as CoreLinkProjectSnapshot;
    const task = (
      await author.ask(coreId, {
        type: "tasksMutate",
        mutation: {
          op: "create",
          projectId: created.projectId,
          title: "restock",
          titleManuallySet: false,
          claudeSessionId: null,
          agent: "claude-code",
        },
      })
    ).task as CoreLinkTaskSnapshot;

    await author.ask(coreId, {
      type: "projectsMutate",
      mutation: { op: "pin", projectId: created.projectId, pinned: true },
    });
    await author.ask(coreId, {
      type: "projectsMutate",
      mutation: { op: "rename", projectId: created.projectId, name: "depot" },
    });
    await author.ask(coreId, {
      type: "tasksMutate",
      mutation: { op: "update", taskId: task.taskId, icon: "rocket" },
    });

    // The second tab asks the same Core and gets the same answers — there is
    // only one copy of this state and neither tab is holding it.
    const sessions = await observer.ask(coreId, { type: "sessionsList" });
    expect(sessions.sessions).toEqual([expect.objectContaining({ taskId: task.taskId })]);

    const renamed = await observer.ask(coreId, {
      type: "projectsMutate",
      mutation: { op: "pin", projectId: created.projectId, pinned: true },
    });
    expect(renamed.project).toMatchObject({ name: "depot", pinned: true });

    const reIconed = await observer.ask(coreId, {
      type: "tasksMutate",
      mutation: { op: "update", taskId: task.taskId, title: "restock" },
    });
    expect(reIconed.task).toMatchObject({ icon: "rocket" });
  });

  it("deletes a session on the Core and tells a watching tab it is gone", async () => {
    const { coreId } = await pair();
    const tab = await openTab();
    tab.subscribe(coreId, 0);

    const task = (
      await tab.ask(coreId, {
        type: "tasksMutate",
        mutation: { op: "create", projectId: "proj_1", title: "restock", agent: "claude-code" },
      })
    ).task as CoreLinkTaskSnapshot;

    const removed = await tab.ask(coreId, {
      type: "tasksMutate",
      mutation: { op: "delete", taskId: task.taskId },
    });

    // The Core answers with the row it removed, and it is out of the sessions
    // list the next read returns.
    expect(removed).toMatchObject({
      type: "tasksMutateResult",
      task: expect.objectContaining({ taskId: task.taskId, title: "restock" }),
    });
    expect((await tab.ask(coreId, { type: "sessionsList" })).sessions).toEqual([]);

    await vi.waitFor(() => {
      expect(tab.events(coreId).map((e) => e.kind)).toContain("task:deleted");
    }, 5_000);
  });

  it("reports a delete of a session the Core does not have as a null row", async () => {
    const { coreId } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "tasksMutate",
      mutation: { op: "delete", taskId: "task_gone" },
    });

    expect(answer).toMatchObject({ type: "tasksMutateResult", task: null });
  });

  it("tells a watching tab which kind of change happened", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();
    tab.subscribe(coreId, 0);

    const created = (
      await tab.ask(coreId, {
        type: "projectsMutate",
        mutation: {
          op: "create",
          name: "warehouse",
          path: path.join(core.disk, "projects", "warehouse"),
        },
      })
    ).project as CoreLinkProjectSnapshot;
    await tab.ask(coreId, {
      type: "projectsMutate",
      mutation: { op: "pin", projectId: created.projectId, pinned: true },
    });

    await vi.waitFor(() => {
      expect(tab.events(coreId).map((e) => e.kind)).toEqual(
        expect.arrayContaining(["project:created", "project:pinnedChanged"]),
      );
    }, 5_000);
  });
});

describe("browsing the Core's filesystem from the browser", () => {
  it("lists the Core's home when the tab names no path", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, { type: "dirList", path: null });

    expect(answer.type).toBe("dirListResult");
    const listing = answer.listing as { path: string; entries: Array<{ name: string }> };
    expect(listing.path).toBe(core.disk);
    // The VM's own folders — dotfolders stay out of the picker.
    expect(listing.entries.map((e) => e.name)).toEqual(["Documents", "projects"]);
  });

  it("drills into a folder on that machine", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "dirList",
      path: path.join(core.disk, "projects"),
    });

    const listing = answer.listing as { entries: Array<{ name: string }>; parent: string };
    expect(listing.entries.map((e) => e.name)).toEqual(["warehouse"]);
    expect(listing.parent).toBe(core.disk);
  });

  it("creates a folder on that machine, then finds it in the next listing", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();
    const parent = path.join(core.disk, "projects");

    const created = await tab.ask(coreId, { type: "dirCreate", parent, name: "atlas" });
    expect(created).toMatchObject({
      type: "dirCreateResult",
      path: path.join(parent, "atlas"),
    });

    const listing = (await tab.ask(coreId, { type: "dirList", path: parent })).listing as {
      entries: Array<{ name: string }>;
    };
    expect(listing.entries.map((e) => e.name)).toEqual(["atlas", "warehouse"]);
  });

  it("says why a listing failed, in words meant for the operator", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "dirList",
      path: path.join(core.disk, "nowhere"),
    });

    expect(answer).toMatchObject({ type: "error", message: "Folder not found" });
  });

  it("refuses a folder name that would escape the parent", async () => {
    const { coreId, core } = await pair();
    const tab = await openTab();

    const answer = await tab.ask(coreId, {
      type: "dirCreate",
      parent: path.join(core.disk, "projects"),
      name: "../escaped",
    });

    expect(answer).toMatchObject({ type: "error", message: "Invalid folder name" });
    expect(fs.existsSync(path.join(core.disk, "escaped"))).toBe(false);
  });
});
