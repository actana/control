import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { handleApiRequest } from "~/server/api-router";
import { documentAuthRedirect } from "~/server/panel-auth";
import { registerEventLogRecorder } from "~/server/event-log-recorder";
import { coreLinkManager } from "~/server/services/core-link-manager";

/**
 * The panel-link endpoint, handed the process's HTTP server by whatever is
 * hosting it (`bin/panel.mjs` in production, Vite in dev). It is exported
 * rather than self-installing because only the host owns the server object —
 * this module is a fetch handler and never sees one.
 */
export { attachPanelLink } from "~/server/panel-link/ws-server";

/**
 * The Node ↔ Web translation `bin/panel.mjs` serves every request through
 * (#225), exported for the same reason `attachPanelLink` is: only the host owns
 * the `IncomingMessage`/`ServerResponse` pair, and only this bundle can be sure
 * the dev middleware and the deployed service are running the *same* one. They
 * were written twice before and disagreed twice — once about buffering a
 * request body (#169) and once about surviving an answer that fails mid-stream.
 */
export { serveNodeRequest } from "~/server/node-http-bridge";

// Subscribe the event-log recorder to the server's AppEvent stream for the life
// of the server process (idempotent). Appends every task/session/hook event to
// the monotonic `event_log` table so a reconnecting Panel can replay the
// missed event/task timeline via the core-link's `subscribe` path.
registerEventLogRecorder();

// Bring up a core-link to every registered Core as the process starts — not
// when a browser arrives. The links, and the replay cursors they advance, are
// the service's; an operator with no tab open still has a Panel that is
// watching their fleet.
coreLinkManager().start();

const startHandler = createStartHandler({ handler: defaultStreamHandler });

export default {
  async fetch(request: Request, opts?: Parameters<typeof startHandler>[1]) {
    const apiResponse = await handleApiRequest(request);
    if (apiResponse) return apiResponse;
    const redirect = documentAuthRedirect(request);
    if (redirect) return redirect;
    return startHandler(request, opts);
  },
};
