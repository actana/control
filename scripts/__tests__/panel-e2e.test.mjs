import { EventEmitter } from "node:events";
import * as http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  CookieJar,
  PANEL_LISTENING_SENTINEL,
  PanelHttpClient,
  PanelLink,
  panelServiceEnv,
  waitForPanelListening,
} from "../lib/panel-e2e.mjs";

// A stand-in for a spawned Panel: stdout/stderr the waiter can read lines off,
// plus the `exit`/`error` events it has to treat as failures.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.say = (line) => child.stdout.push(`${line}\n`);
  child.complain = (line) => child.stderr.push(`${line}\n`);
  return child;
}

describe("CookieJar", () => {
  it("keeps the value of a set-cookie and replays it as a request header", () => {
    const jar = new CookieJar();
    jar.capture(["ac_panel_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600"]);
    expect(jar.get("ac_panel_session")).toBe("abc123");
    expect(jar.header()).toBe("ac_panel_session=abc123");
  });

  it("percent-decodes the value the way a browser hands it back", () => {
    const jar = new CookieJar();
    jar.capture(["ac_panel_session=a%2Fb; Path=/"]);
    expect(jar.get("ac_panel_session")).toBe("a/b");
  });

  it("forgets a cookie the server cleared, so logout really unauthenticates", () => {
    const jar = new CookieJar();
    jar.capture(["ac_panel_session=abc123; Path=/"]);
    jar.capture(["ac_panel_session=; Path=/; Max-Age=0"]);
    expect(jar.get("ac_panel_session")).toBeNull();
    expect(jar.header()).toBe("");
  });

  it("replaces a rotated session rather than sending both", () => {
    const jar = new CookieJar();
    jar.capture(["ac_panel_session=first; Path=/"]);
    jar.capture(["ac_panel_session=second; Path=/"]);
    expect(jar.header()).toBe("ac_panel_session=second");
  });

  it("carries several cookies at once", () => {
    const jar = new CookieJar();
    jar.capture(["a=1; Path=/", "b=2; Path=/"]);
    expect(jar.header()).toBe("a=1; b=2");
  });
});

describe("panelServiceEnv", () => {
  const base = { dataDir: "/tmp/data", port: 7999, serverEntry: "/build/server.js" };

  it("points the service at the temp data dir, port and built entry", () => {
    const env = panelServiceEnv(base);
    expect(env.AC_PANEL_DATA_DIR).toBe("/tmp/data");
    expect(env.AC_PANEL_PORT).toBe("7999");
    expect(env.AC_PANEL_SERVER_ENTRY).toBe("/build/server.js");
    // Loopback, not 0.0.0.0: a test must not put an unauthenticated first-boot
    // Panel on the network of whatever machine CI happens to be.
    expect(env.AC_PANEL_HOST).toBe("127.0.0.1");
  });

  it("passes AC_SECRETS_KEY through when the caller supplies one", () => {
    const env = panelServiceEnv({ ...base, secretsKey: "a".repeat(64) });
    expect(env.AC_SECRETS_KEY).toBe("a".repeat(64));
  });

  it("drops an inherited AC_SECRETS_KEY when the caller supplies none", () => {
    // Otherwise the key-file leg of the test would silently assert nothing:
    // the service would take the ambient key and never write secrets.key.
    const env = panelServiceEnv(base, { AC_SECRETS_KEY: "inherited", PATH: "/usr/bin" });
    expect(env.AC_SECRETS_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops the inherited data-dir fallbacks so nothing lands in the real Panel's state", () => {
    const env = panelServiceEnv(base, { AC_USER_DATA_DIR: "/home/me/real", PORT: "3000" });
    expect(env.AC_USER_DATA_DIR).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });
});

describe("waitForPanelListening", () => {
  it("resolves on the readiness sentinel", async () => {
    const child = fakeChild();
    const observer = { logLines: [] };
    const waiting = waitForPanelListening(child, 5_000, observer);
    child.say("[panel] listening on http://127.0.0.1:7999");
    child.say(PANEL_LISTENING_SENTINEL);
    await expect(waiting).resolves.toBeUndefined();
    expect(observer.logLines).toContain("[stdout] [panel] listening on http://127.0.0.1:7999");
  });

  it("rejects when the service dies before it is ready, keeping its output", async () => {
    const child = fakeChild();
    const observer = { logLines: [] };
    const waiting = waitForPanelListening(child, 5_000, observer);
    child.complain("[panel] no built server at /build/server.js");
    // Give the readline interface a turn to deliver the line first.
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 1, null);
    await expect(waiting).rejects.toThrow(/exited/);
    expect(observer.logLines).toContain("[stderr] [panel] no built server at /build/server.js");
  });

  it("rejects when the sentinel never comes", async () => {
    const child = fakeChild();
    await expect(waitForPanelListening(child, 20, { logLines: [] })).rejects.toThrow(
      /@@AC_LISTENING@@/,
    );
  });
});

// A stand-in for the panel-link socket: the test pushes server frames in and
// reads what the client sent out.
function fakeSocket() {
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (raw) => socket.sent.push(JSON.parse(raw));
  socket.close = () => socket.emit("close");
  socket.terminate = () => socket.emit("close");
  socket.deliver = (frame) => socket.emit("message", JSON.stringify(frame));
  return socket;
}

const coreFrame = (frame) => ({ t: "core", coreId: "core_1", frame });

describe("PanelLink", () => {
  it("matches an answer to the reqId it generated", async () => {
    const socket = fakeSocket();
    const link = new PanelLink(socket);
    const answering = link.request("core_1", { type: "projectsList" });
    const [sent] = socket.sent;
    expect(sent.t).toBe("core");
    expect(sent.frame.type).toBe("projectsList");
    // An answer to somebody else's request must not resolve this one.
    socket.deliver(coreFrame({ type: "projectsListResult", reqId: "someone-else", projects: [] }));
    socket.deliver(coreFrame({ type: "projectsListResult", reqId: sent.frame.reqId, projects: ["p"] }));
    await expect(answering).resolves.toMatchObject({ projects: ["p"] });
  });

  it("collects the events a subscribe replays, up to its own marker", async () => {
    const socket = fakeSocket();
    const link = new PanelLink(socket);
    const subscribing = link.subscribe("core_1", 3);
    socket.deliver(coreFrame({ type: "event", event: { eventId: 4, kind: "task:updated" } }));
    socket.deliver(coreFrame({ type: "event", event: { eventId: 5, kind: "pty:exit" } }));
    socket.deliver(coreFrame({ type: "eventsReplayed", lastEventId: 5 }));
    await expect(subscribing).resolves.toEqual({
      events: [
        { eventId: 4, kind: "task:updated" },
        { eventId: 5, kind: "pty:exit" },
      ],
      lastEventId: 5,
    });
  });

  it("does not settle a second subscribe on the first one's marker", async () => {
    // The bug this exists for: a `waitFor` that scans the whole backlog matches
    // the PREVIOUS subscribe's `eventsReplayed`, so a re-subscribe resolves
    // instantly with zero events — and a replay assertion built on it can never
    // see anything, however correct the service is.
    const socket = fakeSocket();
    const link = new PanelLink(socket);
    const first = link.subscribe("core_1", 0);
    socket.deliver(coreFrame({ type: "eventsReplayed", lastEventId: 1 }));
    await expect(first).resolves.toEqual({ events: [], lastEventId: 1 });

    const second = link.subscribe("core_1", 1);
    socket.deliver(coreFrame({ type: "event", event: { eventId: 2, kind: "project:created" } }));
    socket.deliver(coreFrame({ type: "eventsReplayed", lastEventId: 2 }));
    await expect(second).resolves.toEqual({
      events: [{ eventId: 2, kind: "project:created" }],
      lastEventId: 2,
    });
  });

  it("reads a frame that arrived before the caller started waiting", async () => {
    const socket = fakeSocket();
    const link = new PanelLink(socket);
    socket.deliver({ t: "dial", status: { coreId: "core_1", state: "connected" } });
    await expect(
      link.waitFor((f) => f.t === "dial" && f.status.state === "connected", { timeoutMs: 50 }),
    ).resolves.toMatchObject({ t: "dial" });
  });

  it("collects a Core's events in arrival order", () => {
    const socket = fakeSocket();
    const link = new PanelLink(socket);
    socket.deliver(coreFrame({ type: "event", event: { eventId: 7, kind: "pty:exit" } }));
    socket.deliver({ t: "core", coreId: "core_2", frame: { type: "event", event: { eventId: 8 } } });
    expect(link.eventsFor("core_1")).toEqual([{ eventId: 7, kind: "pty:exit" }]);
  });

  it("collects a PTY's output frames in arrival order", () => {
    const socket = fakeSocket();
    const link = new PanelLink(socket);
    socket.deliver(coreFrame({ type: "data", ptyId: "pty_1", data: "he", seq: 1 }));
    socket.deliver(coreFrame({ type: "data", ptyId: "pty_2", data: "not me", seq: 1 }));
    socket.deliver(coreFrame({ type: "data", ptyId: "pty_1", data: "llo", seq: 2 }));
    expect(link.ptyOutput("core_1", "pty_1")).toEqual(["he", "llo"]);
  });
});

describe("PanelHttpClient", () => {
  const servers = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /** A stub Panel: echoes what it was sent and hands out a session cookie. */
  async function stubPanel(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return new PanelHttpClient(`http://127.0.0.1:${server.address().port}`);
  }

  it("posts JSON and parses the JSON answer", async () => {
    const client = await stubPanel(async (req, res) => {
      const body = await new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => resolve(raw));
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ echoed: JSON.parse(body), method: req.method, url: req.url }));
    });
    const response = await client.post("/api/auth/setup", { name: "op" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      echoed: { name: "op" },
      method: "POST",
      url: "/api/auth/setup",
    });
  });

  it("stores the session cookie and sends it on later requests", async () => {
    const client = await stubPanel((req, res) => {
      if (req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "ac_panel_session=tok; Path=/; HttpOnly");
        res.setHeader("content-type", "application/json");
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    });
    await client.post("/api/auth/login", { password: "x" });
    expect(client.jar.get("ac_panel_session")).toBe("tok");
    const response = await client.get("/api/cores");
    expect(response.body).toEqual({ cookie: "ac_panel_session=tok" });
  });

  it("reports a non-JSON body as text rather than throwing", async () => {
    const client = await stubPanel((req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "text/plain");
      res.end("unauthorized");
    });
    const response = await client.get("/api/cores");
    expect(response.status).toBe(401);
    expect(response.body).toBeNull();
    expect(response.text).toBe("unauthorized");
  });
});
