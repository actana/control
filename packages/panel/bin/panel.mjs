#!/usr/bin/env node
/**
 * The Panel service: a plain Node process that serves the built Panel — SSR
 * pages, client assets, and the `/api/*` surface — over HTTP.
 *
 *   node packages/panel/bin/panel.mjs
 *
 * Environment:
 *   AC_PANEL_PORT / PORT   port to listen on (default 7420)
 *   AC_PANEL_HOST / HOST   interface to bind (default 0.0.0.0; the container
 *                          and reverse-proxy case — bind 127.0.0.1 to keep it
 *                          on the loopback of a shared machine)
 *   AC_PANEL_DATA_DIR      directory holding panel.db and everything else the
 *                          Panel must survive a restart with
 *   AC_SECRETS_KEY         32-byte key (hex or base64) for the Cores' stored
 *                          credentials. Unset, the Panel generates and keeps
 *                          one at <data dir>/secrets.key; set it to hold the
 *                          key somewhere other than beside the data. Losing it
 *                          means re-pairing every Core.
 *   AC_PANEL_SERVER_ENTRY  override the built server bundle (tests, dev builds)
 *
 * The Panel speaks plain HTTP and trusts a reverse proxy for TLS (ADR 0010).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PORT = 7420;
const here = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.AC_PANEL_PORT ?? process.env.PORT ?? DEFAULT_PORT);
const host = process.env.AC_PANEL_HOST ?? process.env.HOST ?? "0.0.0.0";

function resolveServerEntry() {
  const override = process.env.AC_PANEL_SERVER_ENTRY?.trim();
  if (override) return override;
  return path.join(here, "..", "dist", "server", "server.js");
}

const entry = resolveServerEntry();
if (!fs.existsSync(entry)) {
  console.error(
    `[panel] no built server at ${entry}\n` +
      `[panel] run \`pnpm --filter @actana/panel build\` first, or set AC_PANEL_SERVER_ENTRY.`,
  );
  process.exit(1);
}

const mod = await import(pathToFileURL(entry).href);
const handler = mod.default ?? mod.server;
if (!handler || typeof handler.fetch !== "function") {
  console.error(`[panel] server entry exports no fetch handler: ${entry}`);
  process.exit(1);
}
// The Node ↔ Web bridge comes off the bundle rather than being written again
// here (#225). This file and the Vite dev middleware used to translate a
// request and its answer independently, and the two copies disagreed twice:
// about buffering an upload (#169), and about what to do when the answer's
// body fails half-written — where this one piped with no `error` listener on
// the source, so a Core that destroyed an interrupted stream took the whole
// Panel process down with an unhandled `'error'` event.
const serveNodeRequest = mod.serveNodeRequest;
if (typeof serveNodeRequest !== "function") {
  console.error(`[panel] server entry exports no serveNodeRequest bridge: ${entry}`);
  process.exit(1);
}

const staticRoot = path.resolve(path.dirname(entry), "..", "client");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

/**
 * Static assets are public by design: they are the same bundle for every
 * Operator, and the login page has to load its own JavaScript before anyone
 * has a session. All Operator data goes through the gated handler below.
 */
function sendStaticFile(req, res) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") return false;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${host}:${port}`).pathname);
  } catch {
    return false;
  }
  if (pathname === "/") return false;

  const filePath = path.resolve(staticRoot, pathname.slice(1));
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) {
    return false;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", mimeTypes.get(ext) ?? "application/octet-stream");
  if (pathname.startsWith("/assets/")) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("cache-control", "no-cache");
  }
  if (method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (sendStaticFile(req, res)) return;

    await serveNodeRequest(req, res, (request) => handler.fetch(request), {
      hostFallback: `${host}:${port}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[panel] request error url=${req.url ?? ""}: ${message}`);
    // A streamed answer that failed half-written has already spent its status
    // line, and the bridge has already ended that socket the only honest way
    // left. A second answer written on top would throw out of this handler.
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

// The panel link: one WebSocket per browser tab, carrying every Core's live
// traffic (ADR 0012). It shares this HTTP server — same port, same origin, same
// session cookie — so an operator's reverse proxy needs no second rule.
if (typeof mod.attachPanelLink === "function") {
  mod.attachPanelLink(server);
} else {
  console.warn("[panel] server entry exports no attachPanelLink — live updates are off");
}

server.listen(port, host, () => {
  console.log(`[panel] listening on http://${host}:${port}`);
  // Machine-readable readiness marker for anything supervising this process.
  console.log("@@AC_CORE_LISTENING@@");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
