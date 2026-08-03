import { afterAll, describe, expect, it } from "vitest";
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

const { attachPanelLink } = await import("../ws-server");
const { closePanelDb } = await import("../../panel-db");
const { operatorSessionCookie } = await import("../../__tests__/_operator-session");
const { PANEL_LINK_PATH, PANEL_LINK_PROTOCOL_VERSION, PANEL_LINK_VERSION_PARAM } = await import(
  "~/shared/panel-link"
);

const server = http.createServer((_req, res) => res.end("ok"));
attachPanelLink(server);
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
