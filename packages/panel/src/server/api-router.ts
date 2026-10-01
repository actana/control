import { randomUUID } from "node:crypto";
import { jsonError } from "./http-responses";
import { requireHookToken } from "./hook-auth";
import { authenticateApiRequest, type ApiPrincipal } from "./api-key-auth";
import {
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND,
} from "~/shared/http-status";
import * as sessionsController from "./controllers/sessions.controller";
import * as homeTerminalsController from "./controllers/home-terminals.controller";
import * as settingsController from "./controllers/settings.controller";
import * as keybindingsController from "./controllers/keybindings.controller";
import * as hooksController from "./controllers/hooks.controller";
import * as usageController from "./controllers/usage.controller";
import * as claudeUsageLimitsController from "./controllers/claude-usage-limits.controller";
import * as providerUsageController from "./controllers/provider-usage.controller";
import * as harnessLaunchersController from "./controllers/harness-launchers.controller";
import * as eventsController from "./controllers/events.controller";
import * as healthController from "./controllers/health.controller";
import * as aiRuntimeModelsController from "./controllers/ai-runtime-models.controller";
import * as authController from "./controllers/auth.controller";
import * as apiKeysController from "./controllers/api-keys.controller";
import * as coresController from "./controllers/cores.controller";
import * as storageController from "./controllers/storage.controller";
import * as coreFilesController from "./controllers/core-files.controller";
import * as sharedFilesController from "./controllers/shared-files.controller";
import * as updateCheckController from "./controllers/update-check.controller";
import * as tasksController from "./controllers/tasks.controller";
import * as v1Controller from "./controllers/v1.controller";
import { handleMcpRequest, MCP_PATH } from "./mcp";
import { OPERATOR_ID } from "./services/operator";
import * as webhooksController from "./controllers/webhooks.controller";

const HARNESS_HOOK_PATH = /^\/api\/hooks\/([a-z0-9-]+)$/;
const CORE_PATH = /^\/api\/cores\/([^/]+)$/;
const CORE_SHARED_TEST_PATH = /^\/api\/cores\/([^/]+)\/shared\/test$/;
// The Files tab: the Shared folder read from S3 directly, so it answers while the Core is offline (#565).
const CORE_SHARED_FILES_PATH = /^\/api\/cores\/([^/]+)\/shared\/files(?:\/([a-z-]+))?$/;
const CORE_PAIRING_FINISH_PATH = /^\/api\/cores\/([^/]+)\/pairing\/finish$/;
const CORE_DELETE_PATH = /^\/api\/cores\/([^/]+)\/delete$/;
const API_KEY_REVOKE_PATH = /^\/api\/api-keys\/([^/]+)\/revoke$/;
const WEBHOOK_PATH = /^\/api\/webhooks\/([^/]+)$/;
const WEBHOOK_PING_PATH = /^\/api\/webhooks\/([^/]+)\/ping$/;
const WEBHOOK_DELIVERIES_PATH = /^\/api\/webhooks\/([^/]+)\/deliveries$/;
// A Core's files, addressed by both ids: the SDK's Files client still builds its
// requests as `/v1/projects/:id/files`, which a Core answers as an alias of the
// workspace's files (issue 557), so the Panel's proxy takes the same shape.
// `files/list` is matched before `files` so the leaf is never read as a path — the same order, and the same reason, as on the Core (#216).
const CORE_PROJECT_FILES_LIST_PATH = /^\/api\/cores\/([^/]+)\/projects\/([^/]+)\/files\/list$/;
const CORE_PROJECT_FILES_PATH = /^\/api\/cores\/([^/]+)\/projects\/([^/]+)\/files$/;
// Literal path — checked before SESSION_PATH so the id patterns never see it.
const SESSION_SWEEP_DISCONNECTED_PATH = "/api/sessions/sweep-disconnected";
const TASK_PATH = /^\/api\/tasks\/([^/]+)$/;
const TASK_STATUS_PATH = /^\/api\/tasks\/([^/]+)\/status$/;
const TASK_COMMENTS_PATH = /^\/api\/tasks\/([^/]+)\/comments$/;
const CORE_AGENTS_PATH = /^\/api\/cores\/([^/]+)\/agents$/;
// Public REST API (#572 PR 2). Versioned under `/api/v1` so the session-cookie
// routes above stay their own path; a key never reaches those.
const V1_CORE_PATH = /^\/api\/v1\/cores\/([^/]+)$/;
const V1_CORE_AGENTS_PATH = /^\/api\/v1\/cores\/([^/]+)\/agents$/;
const V1_AGENT_PATH = /^\/api\/v1\/agents\/([^/]+)$/;
const V1_TASK_PATH = /^\/api\/v1\/tasks\/([^/]+)$/;
const V1_TASK_STATUS_PATH = /^\/api\/v1\/tasks\/([^/]+)\/status$/;
const V1_TASK_COMMENTS_PATH = /^\/api\/v1\/tasks\/([^/]+)\/comments$/;
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;
const SESSION_STATUS_PATH = /^\/api\/sessions\/([^/]+)\/status$/;
const SESSION_QUESTION_PATH = /^\/api\/sessions\/([^/]+)\/question$/;
const SESSION_ARCHIVE_PATH = /^\/api\/sessions\/([^/]+)\/archive$/;
const SESSION_RESTORE_PATH = /^\/api\/sessions\/([^/]+)\/restore$/;
const HOME_USER_TERMINAL_PATH = /^\/api\/home\/user-terminals\/([^/]+)$/;
const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";
const REQUEST_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

const SHARED_FILES_ROUTES: Readonly<Record<string, string>> = {
  "GET ": "list",
  "GET details": "details",
  "GET media": "media",
  "GET search": "search",
  "GET summary": "summary",
  "POST download-url": "download-url",
  "POST mkdir": "mkdir",
  "PUT upload": "upload",
  "POST rename": "rename",
  "POST move": "move",
  "POST delete": "delete",
};

type SharedFilesRoute = "list" | "details" | "media" | "search" | "summary" | "download-url" | "mkdir" | "upload" | "rename" | "move" | "delete" | undefined;

function sharedFilesRoute(method: string, leaf: string | undefined): SharedFilesRoute {
  return SHARED_FILES_ROUTES[`${method} ${leaf ?? ""}`] as SharedFilesRoute;
}

function decode(segment: string | undefined): string {
  return decodeURIComponent(segment ?? "");
}

function requestHeaderId(request: Request, header: string): string | null {
  const value = request.headers.get(header)?.trim();
  return value && REQUEST_ID_RE.test(value) ? value : null;
}

function applyRequestHeaders(
  response: Response,
  requestId: string,
  correlationId: string,
): Response {
  const setCookies = getSetCookieHeaders(response.headers);
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.set(key, value);
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set(CORRELATION_ID_HEADER, correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values?.length) return values;
  const value = headers.get("set-cookie");
  return value ? value.split(/,(?=\s*[^;,]+=)/) : [];
}

// The Panel's entire anonymous surface: the three calls a browser needs before
// it has a session. Everything else requires the Operator's session cookie.
// Adding an entry here is the *only* way a route can be reached without a
// session, which makes auth-bypass regressions a one-grep review surface.
// Exported so __tests__/api-auth.test.ts can snapshot the list and fail CI on
// any addition.
export const ANONYMOUS_ROUTES: ReadonlyArray<{ method: string; pathname: string }> = [
  { method: "GET", pathname: "/api/auth/state" },
  { method: "POST", pathname: "/api/auth/setup" },
  { method: "POST", pathname: "/api/auth/login" },
];

/**
 * Harness hook endpoints. Not an Operator surface — an agent process POSTs here
 * with the machine token, no browser and no session involved. See hook-auth.ts;
 * these move onto the Core with the rest of the session path.
 */
function isHookRoute(pathname: string): boolean {
  return HARNESS_HOOK_PATH.test(pathname);
}

function isAnonymousRoute(method: string, pathname: string): boolean {
  return ANONYMOUS_ROUTES.some(
    (r) => r.method === method && r.pathname === pathname,
  );
}

/**
 * Centralized auth gate. Default: every /api/* route requires the Operator's
 * session cookie, or an API key on the few routes that accept one (#572).
 * Opt-outs: the anonymous auth handoff surface above, and the agent hook
 * endpoints, which carry the machine token instead. What comes back is who the
 * call runs as.
 */
async function requireApiAuth(
  request: Request,
  method: string,
  pathname: string,
): Promise<{ ok: true; principal: ApiPrincipal | null } | { ok: false; response: Response }> {
  if (isAnonymousRoute(method, pathname)) return { ok: true, principal: null };
  if (isHookRoute(pathname)) {
    const hook = requireHookToken(request);
    return hook.ok ? { ok: true, principal: null } : hook;
  }
  return await authenticateApiRequest(request, method, pathname);
}

const SENSITIVE_QUERY_PARAM_RE = /([?&])(token|ticket)=[^&#\s"']+/gi;

export function redactSensitiveErrorText(value: string): string {
  return value.replace(SENSITIVE_QUERY_PARAM_RE, "$1$2=<redacted>");
}

function isCallerFacingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { expose?: unknown; name?: unknown };
  return maybe.expose === true || maybe.name === "ZodError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "bad request";
  if (typeof err === "string") return err || "bad request";
  return "bad request";
}

function withApiAuth(fn: typeof dispatch) {
  return async (
    request: Request,
    url: URL,
    method: string,
    pathname: string,
  ): Promise<Response> => {
    const auth = await requireApiAuth(request, method, pathname);
    if (!auth.ok) return auth.response;

    try {
      return await fn(request, url, method, pathname, auth.principal);
    } catch (err) {
      const message = redactSensitiveErrorText(errorMessage(err));
      if (isCallerFacingError(err)) return jsonError(HTTP_BAD_REQUEST, message);

      console.error(`[api] unhandled in dispatch ${method} ${pathname}: ${message}`);
      return jsonError(HTTP_INTERNAL_SERVER_ERROR, "internal error");
    }
  };
}

const protectedDispatch = withApiAuth(dispatch);

/** Pure Web `Request → Response` API router for `/api/*`. Reused in dev (Vite middleware) and prod. */
export async function handleApiRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  if (pathname !== MCP_PATH && !pathname.startsWith("/api/")) return null;
  const requestId = requestHeaderId(request, REQUEST_ID_HEADER) ?? randomUUID();
  const correlationId = requestHeaderId(request, CORRELATION_ID_HEADER) ?? requestId;

  if (pathname === "/api/healthz" && method === "GET") {
    return applyRequestHeaders(await healthController.read(), requestId, correlationId);
  }

  // The MCP server (#573) is outside `/api/` and is judged by its own key-only gate, never the session's.
  if (pathname === MCP_PATH) {
    return applyRequestHeaders(await handleMcpRequest(request), requestId, correlationId);
  }

  const response = await protectedDispatch(request, url, method, pathname);
  return applyRequestHeaders(response, requestId, correlationId);
}

async function dispatch(
  request: Request,
  url: URL,
  method: string,
  pathname: string,
  principal: ApiPrincipal | null,
): Promise<Response> {
  // Operator auth — first boot, login, logout, password change.
  if (pathname === "/api/auth/state" && method === "GET") return authController.state(request);
  if (pathname === "/api/auth/setup" && method === "POST") return authController.setup(request);
  if (pathname === "/api/auth/login" && method === "POST") return authController.login(request);
  if (pathname === "/api/auth/logout" && method === "POST") return authController.logout(request);
  if (pathname === "/api/auth/password" && method === "POST") {
    return authController.changePassword(request);
  }

  // Cores — the registry the Panel service dials from.
  if (pathname === "/api/cores") {
    if (method === "GET") return coresController.list(principal!);
  }

  // Public REST API under /api/v1 (#572 PR 2). Key auth (and the session when
  // no key is presented); every call runs as the principal's owner. Matched
  // before the unversioned session routes so `/api/v1/tasks` is never read as
  // an unknown `/api/…` leaf.
  if (pathname === "/api/v1/cores") {
    if (method === "GET") return v1Controller.listCoresV1(principal!);
  }
  let m = pathname.match(V1_CORE_AGENTS_PATH);
  if (m && method === "GET") return v1Controller.listCoreAgentsV1(principal!, decode(m[1]));
  m = pathname.match(V1_CORE_PATH);
  if (m && method === "GET") return v1Controller.getCoreV1(decode(m[1]), principal!);
  if (pathname === "/api/v1/agents") {
    if (method === "GET") return v1Controller.listAgentsV1(principal!);
    if (method === "POST") return v1Controller.createAgentV1(principal!, request);
  }
  m = pathname.match(V1_AGENT_PATH);
  if (m) {
    if (method === "GET") return v1Controller.getAgentV1(principal!, decode(m[1]));
    if (method === "DELETE") return v1Controller.deleteAgentV1(principal!, decode(m[1]));
  }
  if (pathname === "/api/v1/tasks") {
    if (method === "GET") return v1Controller.listTasksV1(principal!);
    if (method === "POST") return v1Controller.createTaskV1(principal!, request);
  }
  m = pathname.match(V1_TASK_STATUS_PATH);
  if (m && method === "POST") return v1Controller.setTaskStatusV1(principal!, decode(m[1]), request);
  m = pathname.match(V1_TASK_COMMENTS_PATH);
  if (m && method === "GET") return v1Controller.listTaskCommentsV1(principal!, decode(m[1]));
  if (m && method === "POST") return v1Controller.addTaskCommentV1(principal!, decode(m[1]), request);
  m = pathname.match(V1_TASK_PATH);
  if (m && method === "GET") return v1Controller.getTaskV1(principal!, decode(m[1]));

  // API keys (#572). The Operator's session creates, lists and revokes them; a
  // key never does, because these routes are not in API_KEY_ROUTES.
  if (pathname === "/api/api-keys") {
    if (method === "GET") return apiKeysController.list(principal!);
    if (method === "POST") return apiKeysController.create(principal!, request);
  }
  const revokeMatch = pathname.match(API_KEY_REVOKE_PATH);
  if (revokeMatch && method === "POST") return apiKeysController.revoke(principal!, decode(revokeMatch[1]));
  // Webhooks (#574): signed Task event delivery. No UI in this PR.
  if (pathname === "/api/webhooks") {
    if (method === "GET") return webhooksController.list();
    if (method === "POST") return webhooksController.create(request);
  }
  m = pathname.match(WEBHOOK_PING_PATH);
  if (m && method === "POST") return webhooksController.ping(decode(m[1]));
  m = pathname.match(WEBHOOK_DELIVERIES_PATH);
  if (m && method === "GET") return webhooksController.deliveries(decode(m[1]));
  m = pathname.match(WEBHOOK_PATH);
  if (m && method === "DELETE") return webhooksController.remove(decode(m[1]));
  // The Shared-folder storage config (#564): the key is write-only, so there is a GET without it and a PUT.
  if (pathname === "/api/storage") {
    if (method === "GET") return storageController.read();
    if (method === "PUT") return storageController.write(request);
  }
  // Pairing (#286). Literal paths, and matched before CORE_PATH so `pairing`
  // is never read as a Core id. Both are Node-side work the browser cannot do:
  // a TLS chain is read here, a key pair is born here, and a code is spent
  // here — see `services/core-pairing.ts`.
  if (pathname === "/api/cores/pairing/inspect" && method === "POST") {
    return coresController.inspect(request);
  }
  if (pathname === "/api/cores/pairing" && method === "POST") {
    return coresController.pair(request);
  }
  // A Core's files, on the Core that owns them (#129 F6/F11, #169). The
  // Panel is a dumb pipe here: these three lines resolve a Core and forward a
  // stream, and every decision about what a path means is the Core's.
  m = pathname.match(CORE_PROJECT_FILES_LIST_PATH);
  if (m) {
    if (method === "GET") return coreFilesController.list(decode(m[1]), decode(m[2]), url);
  }
  m = pathname.match(CORE_PROJECT_FILES_PATH);
  if (m) {
    const coreId = decode(m[1]);
    const projectId = decode(m[2]);
    if (method === "GET") return coreFilesController.read(coreId, projectId, url);
    if (method === "PUT") return coreFilesController.write(coreId, projectId, url, request);
  }

  // Tasks (#571). Every route runs as the session's owner, and the Tasks and
  // Agents services apply the status rules; nothing here moves a status itself.
  // A Panel session belongs to the one Operator today (ADR 0011), so that is the owner.
  const ownerId = OPERATOR_ID;
  if (pathname === "/api/tasks") {
    if (method === "GET") return tasksController.list(ownerId);
    if (method === "POST") return tasksController.create(ownerId, request);
  }
  m = pathname.match(TASK_PATH);
  if (m && method === "GET") return tasksController.read(ownerId, decode(m[1]));
  m = pathname.match(TASK_STATUS_PATH);
  if (m && method === "POST") return tasksController.setStatus(ownerId, decode(m[1]), request);
  m = pathname.match(TASK_COMMENTS_PATH);
  if (m && method === "POST") return tasksController.comment(ownerId, decode(m[1]), request);
  m = pathname.match(CORE_AGENTS_PATH);
  if (m && method === "GET") return tasksController.listCoreAgents(ownerId, decode(m[1]));

  // The Files tab (#565): every call runs as the session's owner, on one of that owner's Cores. A key never reaches these.
  m = pathname.match(CORE_SHARED_FILES_PATH);
  if (m) {
    const files = sharedFilesRoute(method, m[2]);
    const coreId = decode(m[1]);
    const owner = principal!.ownerId;
    switch (files) {
      case "list": return sharedFilesController.list(owner, coreId, url);
      case "details": return sharedFilesController.details(owner, coreId, url);
      case "media": return sharedFilesController.media(owner, coreId, url);
      case "search": return sharedFilesController.search(owner, coreId, url);
      case "summary": return sharedFilesController.summary(owner, coreId, url);
      case "download-url": return sharedFilesController.downloadUrl(owner, coreId, request);
      case "mkdir": return sharedFilesController.mkdir(owner, coreId, request);
      case "upload": return sharedFilesController.upload(owner, coreId, url, request);
      case "rename": return sharedFilesController.rename(owner, coreId, request);
      case "move": return sharedFilesController.move(owner, coreId, request);
      case "delete": return sharedFilesController.remove(owner, coreId, request);
    }
  }

  // The Shared folder, from the pairing's last step to delete (#564).
  m = pathname.match(CORE_SHARED_TEST_PATH);
  if (m && method === "POST") return coresController.testSharedFolder(decode(m[1]));
  m = pathname.match(CORE_PAIRING_FINISH_PATH);
  if (m && method === "POST") return coresController.finishPairing(decode(m[1]), request);
  m = pathname.match(CORE_DELETE_PATH);
  if (m && method === "POST") return coresController.destroy(decode(m[1]), request);

  m = pathname.match(CORE_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return coresController.getOne(id, principal!);
    // PATCH is the alias, and only the alias: a Core's endpoint and credentials
    // are what its pairing produced, and pairing again is the only way to
    // change them.
    if (method === "PATCH") return coresController.rename(id, request);
    if (method === "DELETE") return coresController.remove(id);
  }

  // Sessions
  if (pathname === SESSION_SWEEP_DISCONNECTED_PATH && method === "POST") {
    return sessionsController.sweepDisconnected();
  }
  m = pathname.match(SESSION_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return sessionsController.getOne(id, request);
    if (method === "PATCH") return sessionsController.update(id, request);
    if (method === "DELETE") return sessionsController.remove(id, request);
  }
  m = pathname.match(SESSION_STATUS_PATH);
  if (m && method === "POST") return sessionsController.setStatus(decode(m[1]), request);
  m = pathname.match(SESSION_QUESTION_PATH);
  if (m && method === "GET") return sessionsController.readQuestion(decode(m[1]));
  m = pathname.match(SESSION_ARCHIVE_PATH);
  if (m && method === "POST") return sessionsController.archive(decode(m[1]), request);
  m = pathname.match(SESSION_RESTORE_PATH);
  if (m && method === "POST") return sessionsController.restore(decode(m[1]), request);

  // Terminals. Every terminal is a `home_terminals` row and reaches the Core as
  // a VM Shell Session (issue 266); the `/api/projects/:id/user-terminals` and
  // `/api/user-terminals/:id` routes went with the project-root path.
  if (pathname === "/api/home/user-terminals") {
    if (method === "GET") return homeTerminalsController.listAll(request);
    if (method === "POST") return homeTerminalsController.create(request);
  }
  m = pathname.match(HOME_USER_TERMINAL_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "PATCH") return homeTerminalsController.rename(id, request);
    if (method === "DELETE") return homeTerminalsController.remove(id, request);
  }

  // Settings
  if (pathname === "/api/settings") {
    if (method === "GET") return settingsController.read();
    if (method === "POST") return settingsController.update(request);
  }
  if (pathname === "/api/ai-runtime/models" && method === "GET") {
    return aiRuntimeModelsController.list(url);
  }

  // Keybindings
  if (pathname === "/api/keybindings") {
    if (method === "GET") return keybindingsController.list();
    if (method === "PUT") return keybindingsController.set(request);
    if (method === "DELETE") return keybindingsController.reset(url);
  }

  // Harness hooks
  m = pathname.match(HARNESS_HOOK_PATH);
  if (m && method === "POST") return hooksController.receive(url, request);

  // Usage + events
  if (pathname === "/api/usage" && method === "GET") return usageController.read(url);
  if (pathname === "/api/claude-usage-limits" && method === "GET") {
    return claudeUsageLimitsController.read();
  }
  if (pathname === "/api/provider-usage" && method === "GET") {
    return providerUsageController.read(url);
  }
  if (pathname === "/api/harness-launchers/accounts" && method === "GET") {
    return harnessLaunchersController.accounts();
  }
  if (pathname === "/api/harness-launchers/latest-versions" && method === "GET") {
    return harnessLaunchersController.latestVersions(url);
  }
  if (pathname === "/api/events" && method === "GET") return eventsController.stream();

  // Behind the session gate like everything else: an anonymous browser has no
  // business learning which release this deployment is on.
  if (pathname === "/api/update-check" && method === "GET") return updateCheckController.read();

  return jsonError(HTTP_NOT_FOUND, "not found");
}

export { mapHookEventToStatus } from "~/shared/harness-hook-events";
