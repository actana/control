import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import WebSocket from "ws";

/**
 * The panel-link endpoint over a real socket. What matters here is the gate: an
 * unauthenticated browser must never end up holding a link to someone's fleet,
 * and the refusal has to be a plain HTTP status a client can act on rather than
 * a socket that opens and then goes quiet.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-link-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { attachPanelLink, bindPanelLinkSocket } = await import("../ws-server");
type PanelLinkServerSocket = import("../ws-server").PanelLinkServerSocket;
const { closePanelDb } = await import("../../panel-db");
const { operatorSessionCookie } = await import("../../__tests__/_operator-session");
const { PANEL_LINK_PATH, PANEL_LINK_PROTOCOL_VERSION, PANEL_LINK_VERSION_PARAM } = await import(
  "~/shared/panel-link"
);

const server = http.createServer((_req, res) => res.end("ok"));
const router = attachPanelLink(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closePanelDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function linkUrl(version: number = PANEL_LINK_PROTOCOL_VERSION): string {
  return `ws://127.0.0.1:${port}${PANEL_LINK_PATH}?${PANEL_LINK_VERSION_PARAM}=${version}`;
}

/** Try the upgrade; resolve "open" or the HTTP status the service refused with. */
function dial(headers: Record<string, string> = {}, version?: number): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(linkUrl(version), { headers });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on("error", (err) => resolve(`error ${err.message}`));
  });
}

describe("the panel-link endpoint", () => {
  it("refuses an upgrade with no session at all", async () => {
    await expect(dial()).resolves.toBe("http 401");
  });

  it("refuses an upgrade carrying a session cookie it never issued", async () => {
    await expect(dial({ cookie: "ac_panel_session=not-a-real-token" })).resolves.toBe("http 401");
  });

  it("accepts the Operator's own session cookie", async () => {
    await expect(dial({ cookie: operatorSessionCookie() })).resolves.toBe("open");
  });

  it("refuses a browser built against a protocol version it doesn't speak", async () => {
    await expect(dial({ cookie: operatorSessionCookie() }, 999)).resolves.toBe("http 400");
  });

  it("leaves other upgrade paths to whoever else is listening", async () => {
    // A second upgrade handler on the same server, standing in for anything the
    // Panel might mount later (Vite's HMR socket, in dev). The panel link must
    // not answer for a path that isn't its own — it would take the socket and
    // the other handler would never see it.
    const seen: string[] = [];
    server.on("upgrade", (request, socket) => {
      if (request.url?.startsWith(PANEL_LINK_PATH)) return;
      seen.push(request.url ?? "");
      socket.write("HTTP/1.1 418 I'm a teapot\r\nconnection: close\r\n\r\n");
      socket.destroy();
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/something-else`);
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(undefined));
      ws.on("open", () => resolve(-1));
    });

    expect(seen).toEqual(["/something-else"]);
    expect(status).toBe(418);
  });
});

/**
 * One upgraded connection, as the sweep sees it. Deliberately minimal: it has
 * no `ping` unless asked for one, because that is the shape the sweep has to
 * survive, and its `terminate` behaves like `ws`'s — the socket is gone and the
 * close handler runs.
 */
class FakeUpgradedSocket implements PanelLinkServerSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  pings = 0;
  terminated = 0;
  gracefulCloses = 0;
  ping?: () => void;

  private readonly handlers = new Map<string, Array<(arg?: unknown) => void>>();

  constructor(opts: { ping?: boolean; autoPong?: boolean } = {}) {
    if (opts.ping !== false) {
      this.ping = () => {
        this.pings++;
        // A real browser answers in the network layer, without the page ever
        // hearing about it. That pong is the only thing keeping an idle tab's
        // connection alive.
        if (opts.autoPong) this.fire("pong");
      };
    }
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.gracefulCloses++;
    this.readyState = 3;
    this.fire("close");
  }
  terminate() {
    this.terminated++;
    this.readyState = 3;
    this.fire("close");
  }
  on(event: string, cb: (arg?: never) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (arg?: unknown) => void);
    this.handlers.set(event, list);
    return this;
  }

  fire(event: string, arg?: unknown) {
    for (const cb of [...(this.handlers.get(event) ?? [])]) cb(arg);
  }

  /** The tab sent a frame — an RPC, or a subscribe. */
  receive(frame: unknown) {
    this.fire("message", JSON.stringify(frame));
  }
}

function subscribe(coreId: string) {
  return { t: "core", coreId, frame: { type: "subscribe", reqId: "s1", lastEventId: 0 } };
}

/**
 * The liveness sweep. The case it exists for cannot be written as an event: a
 * connection that dies without a FIN produces nothing at all, so what these
 * tests do is stop answering and move the clock.
 */
describe("the panel-link sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates a connection that stops answering, and the session lets go", () => {
    const ws = new FakeUpgradedSocket();
    const session = bindPanelLinkSocket(router, ws);
    ws.receive(subscribe("core_a"));
    expect(session.watches("core_a")).toBe(true);

    // Pings go out on the 15s interval; the peer answers none of them. The
    // reap lands on the first tick past the 45s timeout.
    vi.advanceTimersByTime(61_000);

    expect(ws.terminated).toBe(1);
    // `terminate`, not `close` — a graceful close waits on a peer that is
    // never going to answer.
    expect(ws.gracefulCloses).toBe(0);
    expect(session.watches("core_a")).toBe(false);
  });

  it("never reaps a quiet-but-healthy connection, however long it stays quiet", () => {
    const ws = new FakeUpgradedSocket({ autoPong: true });
    const session = bindPanelLinkSocket(router, ws);
    ws.receive(subscribe("core_a"));

    // Four hours with not one application frame — an idle Core is entitled to
    // send none. Only the pongs stand between this tab and the reaper.
    vi.advanceTimersByTime(4 * 60 * 60_000);

    expect(ws.terminated).toBe(0);
    expect(ws.pings).toBeGreaterThan(900);
    expect(session.watches("core_a")).toBe(true);
  });

  it("takes a connection's own frames as proof of life", () => {
    const ws = new FakeUpgradedSocket();
    bindPanelLinkSocket(router, ws);

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      ws.receive(subscribe("core_a"));
    }

    expect(ws.terminated).toBe(0);
  });

  it("reaps one tab's connection without touching any other tab's", () => {
    // Binding order matters: the healthy connections sit either side of the
    // dead one. A sweep carrying the core link's "am I the current connection?"
    // guard would reap both of them and spare the newest — the Panel holds one
    // connection per tab, not one in total.
    const first = new FakeUpgradedSocket({ autoPong: true });
    const dead = new FakeUpgradedSocket();
    const last = new FakeUpgradedSocket({ autoPong: true });
    const firstSession = bindPanelLinkSocket(router, first);
    const deadSession = bindPanelLinkSocket(router, dead);
    const lastSession = bindPanelLinkSocket(router, last);
    for (const ws of [first, dead, last]) ws.receive(subscribe("core_a"));

    vi.advanceTimersByTime(61_000);

    expect(dead.terminated).toBe(1);
    expect(deadSession.watches("core_a")).toBe(false);
    expect(first.terminated).toBe(0);
    expect(firstSession.watches("core_a")).toBe(true);
    expect(last.terminated).toBe(0);
    expect(lastSession.watches("core_a")).toBe(true);
  });

  it("stops sweeping the moment its own socket closes", () => {
    const ws = new FakeUpgradedSocket({ autoPong: true });
    bindPanelLinkSocket(router, ws);
    vi.advanceTimersByTime(31_000);
    const pingsWhenClosed = ws.pings;
    expect(pingsWhenClosed).toBeGreaterThan(0);

    ws.fire("close");
    vi.advanceTimersByTime(60 * 60_000);

    expect(ws.pings).toBe(pingsWhenClosed);
  });

  it("carries a socket that cannot ping rather than throwing at it", () => {
    const ws = new FakeUpgradedSocket({ ping: false });
    const session = bindPanelLinkSocket(router, ws);
    ws.receive(subscribe("core_a"));

    vi.advanceTimersByTime(4 * 60 * 60_000);

    expect(ws.terminated).toBe(0);
    expect(session.watches("core_a")).toBe(true);
  });
});
