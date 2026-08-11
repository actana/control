import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { requireOperatorSession } from "../panel-auth";
import { coreLinkManager } from "../services/core-link-manager";
import { PanelLinkRouter, type PanelLinkSession } from "./router";
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
    wss.handleUpgrade(request, socket as Duplex, head, (ws) => {
      bindPanelLinkSocket(router, ws);
    });
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

/**
 * The sweep's clock, matching the core link's
 * (`packages/core/src/pty-core-link-server.ts`). 15s is well inside the idle
 * timeouts a reverse proxy (`DEPLOY.md`) or Docker's NAT keeps, so the ping
 * doubles as what stops an idle flow being collected in the first place; 45s
 * gives a connection three of them to answer before it is called dead.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * What the sweep needs from an upgraded socket. `ping` and `terminate` are
 * optional because a socket injected by a test has neither, and a sweep that
 * assumed them would throw on the one path nobody watches.
 */
export interface PanelLinkServerSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(): void;
  ping?(): void;
  terminate?(): void;
  on(event: "message", cb: (raw: unknown) => void): unknown;
  on(event: "pong" | "close" | "error", cb: () => void): unknown;
}

/**
 * Take over one upgraded socket: route its frames, and run the per-connection
 * liveness sweep that gives the panel link the contract the core link already
 * has.
 *
 * The sweep is what makes the browser's existing recovery reachable. A
 * WebSocket that dies without a TCP FIN leaves both ends believing they are
 * connected — `readyState` stays `OPEN` and no `close` event ever fires — and
 * `close` is the only thing that starts a reconnect. Reaping the corpse here
 * fires that `close`, and the reconnect → re-subscribe → reattach path that was
 * already written finally runs.
 *
 * Exported for the sweep's own tests, which drive it with an injected socket
 * and a clock they can move. `attachPanelLink` is the only production caller.
 */
export function bindPanelLinkSocket(
  router: PanelLinkRouter,
  ws: PanelLinkServerSocket,
): PanelLinkSession {
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

  /**
   * Advanced by anything arriving from this tab — an RPC, or the pong that
   * answers our ping. The pong is what keeps a quiet-but-healthy tab alive: a
   * browser cannot send a WebSocket ping of its own, and an idle Panel sends no
   * application frames for as long as its operator leaves it alone.
   */
  let lastInboundAt = Date.now();

  let sweep: ReturnType<typeof setInterval> | null = null;
  function stopSweep(): void {
    if (sweep) clearInterval(sweep);
    sweep = null;
  }

  // One sweep per connection, and its lifetime is owned by *this* socket's
  // close handler and nothing else. Deliberately without the core link's
  // "am I still the current connection?" guard: the Core holds exactly one
  // connection, so that check is right there and fatal here — the Panel holds
  // one connection per tab, and the same line would reap every tab but the
  // newest.
  if (ws.ping) {
    sweep = setInterval(() => {
      if (Date.now() - lastInboundAt > HEARTBEAT_TIMEOUT_MS) {
        stopSweep();
        // `terminate`, not `close`: a graceful close on a half-open socket
        // waits on a peer that is never going to answer, and the session would
        // hold its watch set for as long as that took.
        try {
          ws.terminate ? ws.terminate() : ws.close();
        } catch {
          // Already gone — the close handler still detaches.
        }
        return;
      }
      try {
        ws.ping?.();
      } catch {
        // The close handler will take it from here.
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  ws.on("pong", () => {
    lastInboundAt = Date.now();
  });
  ws.on("message", (raw) => {
    lastInboundAt = Date.now();
    void session.receiveRaw(toText(raw));
  });
  ws.on("close", () => {
    stopSweep();
    session.detach();
  });
  ws.on("error", () => {
    stopSweep();
    session.detach();
  });

  return session;
}

function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}
