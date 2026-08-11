import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "node:net";
import { PtyCoreLinkServer, type WebSocketServerLike, type WebSocketLike } from "@actana/core/pty-core-link-server";
import { generateCertMaterial } from "@actana/core/core-cert-material";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import type { PtyCore } from "@actana/core/pty-manager";
import type { EventLogPort } from "@actana/core/pty-core-link-server";
import type { CoreLinkEvent } from "@actana/shared/core-link-frames";

/**
 * The Cores surface, driven the way a browser drives it: pair a Core by pasting
 * a token, watch the Panel service reach a real Core over mTLS, remove it.
 *
 * The Core here is the real core-link server behind a real TLS socket, so
 * "the dial reached it" means the handshake, the pinned CA, the client cert,
 * and the bearer all actually worked — not that a fake resolved a promise.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cores-api-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const { closePanelDb, getPanelDb } = await import("../panel-db");
const { operatorSessionCookie } = await import("./_operator-session");
const { coreLinkManager, resetCoreLinkManagerForTests } = await import(
  "../services/core-link-manager"
);

const ORIGIN = "http://panel.example.test";
const BEARER_SECRET = "cores-api-test-secret-32-bytes-xxx";

async function call(
  pathname: string,
  init: RequestInit & { json?: unknown; anonymous?: boolean } = {},
): Promise<Response> {
  const { json, anonymous, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  if (!anonymous) headers.cookie = operatorSessionCookie();
  if (json !== undefined) headers["content-type"] = "application/json";
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    }),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
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
    // `wss.close()` only stops new connections; a machine going away takes the
    // established ones with it, so the test has to as well.
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

/**
 * A Core event log holding a fixed set of events, which records the cursor
 * every `subscribe` arrives with. That recording is how a test can see the
 * Panel's stored cursor being *used* — the Core replays from whatever
 * number the Panel sent it.
 */
function fakeEventLog(count: number): EventLogPort & { subscribedFrom: number[] } {
  const events: CoreLinkEvent[] = Array.from({ length: count }, (_, i) => ({
    eventId: i + 1,
    ts: i + 1,
    kind: "task:updated",
    ptyId: null,
    taskId: null,
    payload: "{}",
  }));
  const subscribedFrom: number[] = [];
  return {
    subscribedFrom,
    appendEvent: () => 0,
    getLastEventId: () => events.length,
    readEventTail: (afterEventId) => {
      subscribedFrom.push(afterEventId);
      return events.filter((e) => e.eventId > afterEventId);
    },
  };
}

type CoreFixture = {
  server: PtyCoreLinkServer;
  registrationBlob: string;
  authAttempts: () => number;
  eventLog: ReturnType<typeof fakeEventLog>;
};

async function startCore(label: string, eventCount = 0): Promise<CoreFixture> {
  const material = await generateCertMaterial({ host: "127.0.0.1" });
  const bound = { port: await freePort() };
  // Counted on the Core side: this is what "the Panel actually reached this
  // machine" looks like from the machine, rather than from the Panel's own
  // bookkeeping.
  let authAttempts = 0;
  const eventLog = fakeEventLog(eventCount);
  const server = new PtyCoreLinkServer(mockCore(), {
    eventLog,
    port: bound.port,
    host: "127.0.0.1",
    createServer: tlsCreateServer(bound),
    tls: {
      caCert: material.ca.cert,
      serverCert: material.server.cert,
      serverKey: material.server.key,
    },
    authVerifier: (bearer) => {
      authAttempts++;
      return verifyBearer(bearer, BEARER_SECRET);
    },
  });
  await vi.waitFor(() => expect(bound.port).toBeGreaterThan(0));
  const registrationBlob = encodeRegistrationBlob({
    endpoint: `wss://127.0.0.1:${bound.port}`,
    label,
    caCert: material.ca.cert,
    clientCert: material.client.cert,
    clientKey: material.client.key,
    bearer: signBearer({ coreId: "core_fixture", exp: Date.now() + 600_000 }, BEARER_SECRET),
  });
  return { server, registrationBlob, authAttempts: () => authAttempts, eventLog };
}

const running: PtyCoreLinkServer[] = [];

afterEach(() => {
  resetCoreLinkManagerForTests();
  for (const server of running.splice(0)) server.close();
  const db = getPanelDb();
  db.prepare("DELETE FROM core_secrets").run();
  db.prepare("DELETE FROM cores").run();
});

afterAll(() => {
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function pair(
  label = "prod-vm-1",
  eventCount = 0,
): Promise<{ id: string; blob: string; core: CoreFixture }> {
  const core = await startCore(label, eventCount);
  running.push(core.server);
  const response = await call("/api/cores", { method: "POST", json: { registrationBlob: core.registrationBlob } });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { core: { id: string; label: string } };
  return { id: body.core.id, blob: core.registrationBlob, core };
}

async function dialOf(id: string): Promise<{ state: string; lastSeenAt: number | null }> {
  const body = (await (await call("/api/cores")).json()) as {
    cores: { id: string; dial: { state: string; lastSeenAt: number | null } }[];
  };
  const core = body.cores.find((c) => c.id === id);
  if (!core) throw new Error(`core ${id} not listed`);
  return core.dial;
}

describe("Cores API", () => {
  it("starts empty", async () => {
    expect(await (await call("/api/cores")).json()).toEqual({ cores: [] });
  });

  it("requires an Operator session", async () => {
    expect((await call("/api/cores", { anonymous: true })).status).toBe(401);
    expect((await call("/api/cores", { method: "POST", anonymous: true, json: {} })).status).toBe(401);
    expect((await call("/api/cores/core_x", { method: "DELETE", anonymous: true })).status).toBe(401);
  });

  it("pairs a Core from a token and reaches its Core over mTLS", async () => {
    const { id } = await pair();
    await vi.waitFor(async () => expect((await dialOf(id)).state).toBe("connected"), {
      timeout: 10_000,
    });
    expect((await dialOf(id)).lastSeenAt).toBeGreaterThan(0);
  }, 20_000);

  it("lists the paired Core with its endpoint and label", async () => {
    const { id } = await pair("mac-mini");
    const body = (await (await call("/api/cores")).json()) as {
      cores: { id: string; label: string; endpoint: string; lastEventId: number }[];
    };
    expect(body.cores).toHaveLength(1);
    expect(body.cores[0]).toMatchObject({ id, label: "mac-mini", lastEventId: 0 });
    expect(body.cores[0]!.endpoint).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);

  it("never returns the Core's secrets", async () => {
    const { id } = await pair();
    const raw = await (await call("/api/cores")).text();
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain("BEGIN CERTIFICATE");
    expect(raw).toContain(id);
  }, 20_000);

  it("shows a Core whose Core is gone as unreachable, with a last-seen time", async () => {
    const { id } = await pair();
    await vi.waitFor(async () => expect((await dialOf(id)).state).toBe("connected"), {
      timeout: 10_000,
    });
    const seenAt = (await dialOf(id)).lastSeenAt;
    for (const server of running.splice(0)) server.close();
    await vi.waitFor(async () => expect((await dialOf(id)).state).toBe("unreachable"), {
      timeout: 10_000,
    });
    expect((await dialOf(id)).lastSeenAt).toBe(seenAt);
  }, 30_000);

  it("dials its Cores at boot with no browser in the picture", async () => {
    const { core } = await pair();
    await vi.waitFor(() => expect(core.authAttempts()).toBeGreaterThan(0), { timeout: 10_000 });
    const before = core.authAttempts();

    // The service restarts. Nobody logs in, no request is made, no tab is open
    // — and the Core still gets dialed.
    resetCoreLinkManagerForTests();
    coreLinkManager().start();
    await vi.waitFor(() => expect(core.authAttempts()).toBeGreaterThan(before), {
      timeout: 10_000,
    });
  }, 30_000);

  describe("the Panel-owned cursor", () => {
    it("advances in the registry as the Core replays its events", async () => {
      const { id } = await pair("prod-vm-1", 3);
      await vi.waitFor(
        () =>
          expect(
            (
              getPanelDb().prepare("SELECT last_event_id AS n FROM cores WHERE id = ?").get(id) as {
                n: number;
              }
            ).n,
          ).toBe(3),
        { timeout: 10_000 },
      );
    }, 30_000);

    it("is what the Core replays from on the next connection", async () => {
      const { id, core } = await pair("prod-vm-1", 3);
      await vi.waitFor(() => expect(core.eventLog.subscribedFrom).toEqual([0]), {
        timeout: 10_000,
      });
      await vi.waitFor(
        () =>
          expect(
            (
              getPanelDb().prepare("SELECT last_event_id AS n FROM cores WHERE id = ?").get(id) as {
                n: number;
              }
            ).n,
          ).toBe(3),
        { timeout: 10_000 },
      );

      // The service restarts. The Core must be asked for the tail after 3,
      // not for the whole log again.
      resetCoreLinkManagerForTests();
      coreLinkManager().start();
      await vi.waitFor(() => expect(core.eventLog.subscribedFrom).toEqual([0, 3]), {
        timeout: 10_000,
      });
    }, 30_000);
  });

  describe("a token the Panel won't take", () => {
    it("rejects garbage with a message and registers nothing", async () => {
      const response = await call("/api/cores", { method: "POST", json: { registrationBlob: "nonsense" } });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: string }).toEqual({
        error: expect.stringContaining("pairing token"),
      });
      expect(await (await call("/api/cores")).json()).toEqual({ cores: [] });
    });

    it("rejects a missing token", async () => {
      expect((await call("/api/cores", { method: "POST", json: {} })).status).toBe(400);
      expect(await (await call("/api/cores")).json()).toEqual({ cores: [] });
    });

    it("rejects a truncated paste and registers nothing", async () => {
      const { blob } = await pair();
      const response = await call("/api/cores", {
        method: "POST",
        json: { registrationBlob: blob.slice(0, blob.length - 40) },
      });
      expect(response.status).toBe(400);
      const body = (await (await call("/api/cores")).json()) as { cores: unknown[] };
      expect(body.cores).toHaveLength(1);
    }, 20_000);

    it("refuses to pair the same Core twice", async () => {
      const { blob } = await pair();
      const response = await call("/api/cores", { method: "POST", json: { registrationBlob: blob } });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("already registered");
      const body = (await (await call("/api/cores")).json()) as { cores: unknown[] };
      expect(body.cores).toHaveLength(1);
    }, 20_000);
  });

  describe("renaming a Core", () => {
    it("renames in place and shows the new alias in the list", async () => {
      const { id } = await pair("prod-vm-1");
      const response = await call(`/api/cores/${id}`, { method: "PATCH", json: { label: "build-box" } });
      expect(response.status).toBe(200);
      expect((await response.json()) as { core: { label: string } }).toMatchObject({
        core: { id, label: "build-box" },
      });
      const body = (await (await call("/api/cores")).json()) as { cores: { label: string }[] };
      expect(body.cores[0]?.label).toBe("build-box");
    }, 20_000);

    it("normalizes the way pairing does — trimmed, capped, host when empty", async () => {
      const { id } = await pair();
      const labelAfter = async (label: string): Promise<string> => {
        const res = await call(`/api/cores/${id}`, { method: "PATCH", json: { label } });
        return ((await res.json()) as { core: { label: string } }).core.label;
      };
      expect(await labelAfter("  spaced out  ")).toBe("spaced out");
      expect(await labelAfter("x".repeat(200))).toBe("x".repeat(120));
      expect(await labelAfter("   ")).toBe("127.0.0.1");
    }, 20_000);

    it("leaves the link alone — renaming is a Panel-local write", async () => {
      const { id } = await pair();
      await vi.waitFor(async () => expect((await dialOf(id)).state).toBe("connected"), {
        timeout: 10_000,
      });
      const seenAt = (await dialOf(id)).lastSeenAt;
      expect((await call(`/api/cores/${id}`, { method: "PATCH", json: { label: "build-box" } })).status).toBe(200);
      const dial = await dialOf(id);
      expect(dial.state).toBe("connected");
      expect(dial.lastSeenAt).toBe(seenAt);
    }, 30_000);

    it("rejects a body with no label, and an anonymous caller", async () => {
      const { id } = await pair();
      expect((await call(`/api/cores/${id}`, { method: "PATCH", json: {} })).status).toBe(400);
      expect(
        (await call(`/api/cores/${id}`, { method: "PATCH", anonymous: true, json: { label: "x" } })).status,
      ).toBe(401);
    }, 20_000);

    it("404s on an id it doesn't know", async () => {
      const response = await call("/api/cores/core_nope", { method: "PATCH", json: { label: "x" } });
      expect(response.status).toBe(404);
    });
  });

  describe("removing a Core", () => {
    it("drops the registry row, its secrets, and its cursor", async () => {
      const { id } = await pair();
      await vi.waitFor(async () => expect((await dialOf(id)).state).toBe("connected"), {
        timeout: 10_000,
      });
      expect((await call(`/api/cores/${id}`, { method: "DELETE" })).status).toBe(204);
      expect(await (await call("/api/cores")).json()).toEqual({ cores: [] });
      const db = getPanelDb();
      expect(db.prepare("SELECT COUNT(*) AS n FROM cores").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM core_secrets").get()).toEqual({ n: 0 });
    }, 20_000);

    it("404s on an id it doesn't know", async () => {
      expect((await call("/api/cores/core_nope", { method: "DELETE" })).status).toBe(404);
    });
  });
});
