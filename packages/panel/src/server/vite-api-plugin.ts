import type { Plugin } from "vite";
import { serveNodeRequest } from "./node-http-bridge";
import { HTTP_INTERNAL_SERVER_ERROR } from "../shared/http-status";

const TOKEN_QUERY_REDACT_URL = /([?&])token=[^&#]+/gi;
const TOKEN_QUERY_REDACT_MESSAGE = /([?&])token=[^&#\s"']+/gi;
const TOKEN_REDACTED_REPLACEMENT = "$1token=<redacted>";

// The Node ↔ Web translation both this middleware and `bin/panel.mjs` run lives
// in `node-http-bridge.ts` (#225). It was written twice before and the two
// copies disagreed twice: once about buffering the request body (#169) and once
// about surviving a failing answer. Re-exported here so the suites that pin the
// dev server's half keep naming it where they always did.
export { nodeRequestToFetch } from "./node-http-bridge";

/**
 * Vite plugin that mounts the MissionControl `/api/*` Web-fetch handler
 * as a Connect middleware. Lazy-imports the handler so Vite's SSR
 * boundary keeps better-sqlite3 / native bindings on the Node side.
 */
export function missionControlApi(): Plugin {
  return {
    name: "mission-control-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/")) return next();
        try {
          const { handleApiRequest } = await server.ssrLoadModule(
            "/src/server/api-router.ts"
          );
          const served = await serveNodeRequest(req, res, (request) =>
            (handleApiRequest as any)(request),
          );
          if (!served) return next();
        } catch (err: any) {
          // Never echo err.message — a throw that wrapped a URL can carry a
          // credential in its query. Generic body + redacted server log.
          const safeUrl = (req.url ?? "").replace(
            TOKEN_QUERY_REDACT_URL,
            TOKEN_REDACTED_REPLACEMENT,
          );
          const safeMessage = String(err?.message ?? "internal error").replace(
            TOKEN_QUERY_REDACT_MESSAGE,
            TOKEN_REDACTED_REPLACEMENT,
          );
          // eslint-disable-next-line no-console
          console.error(`[mc-api] ${req.method} ${safeUrl} failed: ${safeMessage}`);
          // A streamed answer that died mid-flight has already sent its status
          // line, and `writeResponseToNode` has already ended that socket the
          // only honest way it could. Writing a second answer on top would
          // throw ERR_HTTP_HEADERS_SENT out of the error handler itself.
          if (res.headersSent || res.writableEnded || res.destroyed) return;
          res.statusCode = HTTP_INTERNAL_SERVER_ERROR;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });

      // The same Operator gate the built server applies (src/server.ts). Dev
      // renders SSR through Vite's own pipeline, so without this the dev Panel
      // would serve the app shell to anyone.
      server.middlewares.use(async (req, res, next) => {
        if (!req.headers.accept?.includes("text/html")) return next();
        try {
          const { documentAuthRedirect } = await server.ssrLoadModule(
            "/src/server/panel-auth.ts",
          );
          const served = await serveNodeRequest(req, res, (request) =>
            (documentAuthRedirect as any)(request),
          );
          if (!served) return next();
        } catch {
          next();
        }
      });

      // The panel link in dev. Vite owns the HTTP server here, so the endpoint
      // attaches to Vite's rather than to the one `bin/panel.mjs` creates —
      // same code, same cookie gate, so the dev loop exercises the real thing.
      // Vite's own HMR socket is on a different path and is left alone.
      const httpServer = server.httpServer;
      if (httpServer) {
        void server
          .ssrLoadModule("/src/server/panel-link/ws-server.ts")
          .then(({ attachPanelLink }) => (attachPanelLink as any)(httpServer))
          .catch((err: unknown) => {
            console.error(`[mc-api] panel link unavailable in dev: ${String(err)}`);
          });
      }
    },
  };
}
