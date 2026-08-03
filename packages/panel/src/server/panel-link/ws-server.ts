import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { requireOperatorSession } from "../panel-auth";
import { coreLinkManager } from "../services/core-link-manager";
import { PanelLinkRouter } from "./router";
import {
  PANEL_LINK_PATH,
  PANEL_LINK_PROTOCOL_VERSION,
  PANEL_LINK_VERSION_PARAM,
  encodePanelLinkFrame,
} from "~/shared/panel-link";

/**
 * The panel link's transport: a WebSocket endpoint on the Panel's own HTTP
 * server, gated by the Operator's session cookie at the upgrade.
 *
 * Gating at the upgrade rather than after it is the whole point — an
 * unauthenticated socket is never established, so there is no window in which a
 * stranger holds an open link to someone's fleet. It is the same cookie the
 * rest of the Panel runs on: a browser that can load the app can open its link,
 * and a browser that cannot gets a 401 and a login page.
 */

let attached: { server: Server; router: PanelLinkRouter } | null = null;

export function attachPanelLink(server: Server): PanelLinkRouter {
  if (attached?.server === server) return attached.router;

  const router = new PanelLinkRouter(coreLinkManager());
  // `noServer` because the Panel already has an HTTP server and the upgrade has
  // to be authenticated before `ws` touches it.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (!isPanelLinkUpgrade(request)) return;
    const rejection = rejectUpgrade(request);
    if (rejection) {
      socket.write(rejection);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as Duplex, head, (ws) => bind(router, ws));
  });

  attached = { server, router };
  return router;
}

function isPanelLinkUpgrade(request: IncomingMessage): boolean {
  try {
    return new URL(request.url ?? "/", "http://panel.invalid").pathname === PANEL_LINK_PATH;
  } catch {
    return false;
  }
}

/**
 * The upgrade's gate. Returns the raw HTTP refusal to write, or null to let the
 * handshake proceed. A refusal is a plain response because there is no
 * WebSocket yet to close with a code — the browser sees a failed upgrade, and
 * its client treats a 401 as "go log in", not as a network blip to retry
 * forever.
 */
function rejectUpgrade(request: IncomingMessage): string | null {
  const version = readVersion(request);
  if (version !== PANEL_LINK_PROTOCOL_VERSION) {
    return httpRefusal(400, "panel-link version mismatch — reload the Panel");
  }
  const auth = requireOperatorSession(asWebRequest(request));
  if (!auth.ok) return httpRefusal(401, "unauthorized");
  return null;
}

function readVersion(request: IncomingMessage): number | null {
  try {
    const raw = new URL(request.url ?? "/", "http://panel.invalid").searchParams.get(
      PANEL_LINK_VERSION_PARAM,
    );
    const version = Number(raw);
    return Number.isInteger(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The upgrade request as a `Request`, so the session gate the rest of the
 * Panel uses applies here unchanged rather than being reimplemented against
 * Node's headers.
 */
function asWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value != null) headers.set(key, String(value));
  }
  const host = request.headers.host ?? "panel.invalid";
  return new Request(`http://${host}${request.url ?? "/"}`, { headers });
}

function httpRefusal(status: number, message: string): string {
  const reason = status === 401 ? "Unauthorized" : "Bad Request";
  return (
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "content-type: text/plain; charset=utf-8\r\n" +
    `content-length: ${Buffer.byteLength(message)}\r\n` +
    "connection: close\r\n\r\n" +
    message
  );
}

function bind(router: PanelLinkRouter, ws: WebSocket): void {
  const session = router.attach({
    send: (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(encodePanelLinkFrame(frame));
      } catch {
        // The close handler detaches; a failed write is not worth a throw that
        // would take down the fan-out loop for every other tab.
      }
    },
    close: () => ws.close(),
  });
  ws.on("message", (raw) => void session.receiveRaw(toText(raw)));
  ws.on("close", () => session.detach());
  ws.on("error", () => session.detach());
}

function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}
