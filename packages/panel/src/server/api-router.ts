import { randomUUID } from "node:crypto";
import { jsonError } from "./http-responses";
import { requireHookToken } from "./hook-auth";
import { requireOperatorSession } from "./panel-auth";
import {
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND,
} from "~/shared/http-status";
import * as projectsController from "./controllers/projects.controller";
import * as projectPresentationController from "./controllers/project-presentation.controller";
import * as tasksController from "./controllers/tasks.controller";
import * as groupsController from "./controllers/groups.controller";
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
import * as coresController from "./controllers/cores.controller";
import * as coreFilesController from "./controllers/core-files.controller";
import * as updateCheckController from "./controllers/update-check.controller";

const HARNESS_HOOK_PATH = /^\/api\/hooks\/([a-z0-9-]+)$/;
const PROJECT_PATH = /^\/api\/projects\/([^/]+)$/;
const PROJECT_PATH_STATUS_PATH = /^\/api\/projects\/([^/]+)\/path-status$/;
const PROJECT_IMAGE_PATH = /^\/api\/projects\/([^/]+)\/image$/;
const PROJECT_PRESENTATION_PATH = /^\/api\/project-presentation\/([^/]+)$/;
const PROJECT_TASKS_PATH = /^\/api\/projects\/([^/]+)\/tasks$/;
const GROUP_PATH = /^\/api\/groups\/([^/]+)$/;
const CORE_PATH = /^\/api\/cores\/([^/]+)$/;
// A Project's files on a Core, addressed by both ids because the Panel holds no
// row for a Core-owned Project (ADR 0005) and therefore cannot look one up from
// the other. `files/list` is matched before `files` so the leaf is never read as
// a path — the same order, and the same reason, as on the Core (#216).
const CORE_PROJECT_FILES_LIST_PATH = /^\/api\/cores\/([^/]+)\/projects\/([^/]+)\/files\/list$/;
const CORE_PROJECT_FILES_PATH = /^\/api\/cores\/([^/]+)\/projects\/([^/]+)\/files$/;
// Literal path — checked before TASK_PATH so the id patterns never see it.
const TASK_SWEEP_DISCONNECTED_PATH = "/api/tasks/sweep-disconnected";
const TASK_PATH = /^\/api\/tasks\/([^/]+)$/;
const TASK_STATUS_PATH = /^\/api\/tasks\/([^/]+)\/status$/;
const TASK_QUESTION_PATH = /^\/api\/tasks\/([^/]+)\/question$/;
const TASK_ARCHIVE_PATH = /^\/api\/tasks\/([^/]+)\/archive$/;
const TASK_RESTORE_PATH = /^\/api\/tasks\/([^/]+)\/restore$/;
const HOME_USER_TERMINAL_PATH = /^\/api\/home\/user-terminals\/([^/]+)$/;
const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";
const REQUEST_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

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
 * session cookie. Opt-outs: the anonymous auth handoff surface above, and the
 * agent hook endpoints, which carry the machine token instead.
 */
function requireApiAuth(
  request: Request,
  method: string,
  pathname: string,
): { ok: true } | { ok: false; response: Response } {
  if (isAnonymousRoute(method, pathname)) return { ok: true };
  if (isHookRoute(pathname)) return requireHookToken(request);
  return requireOperatorSession(request);
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
    const auth = requireApiAuth(request, method, pathname);
    if (!auth.ok) return auth.response;

    try {
      return await fn(request, url, method, pathname);
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

  if (!pathname.startsWith("/api/")) return null;
  const requestId = requestHeaderId(request, REQUEST_ID_HEADER) ?? randomUUID();
  const correlationId = requestHeaderId(request, CORRELATION_ID_HEADER) ?? requestId;

  if (pathname === "/api/healthz" && method === "GET") {
    return applyRequestHeaders(await healthController.read(), requestId, correlationId);
  }

  const response = await protectedDispatch(request, url, method, pathname);
  return applyRequestHeaders(response, requestId, correlationId);
}

async function dispatch(
  request: Request,
  url: URL,
  method: string,
  pathname: string,
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
    if (method === "GET") return coresController.list();
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
  // A Project's files, on the Core that owns them (#129 F6/F11, #169). The
  // Panel is a dumb pipe here: these three lines resolve a Core and forward a
  // stream, and every decision about what a path means is the Core's.
  let m = pathname.match(CORE_PROJECT_FILES_LIST_PATH);
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

  m = pathname.match(CORE_PATH);
  if (m) {
    const id = decode(m[1]);
    // PATCH is the alias, and only the alias: a Core's endpoint and credentials
    // are what its pairing produced, and pairing again is the only way to
    // change them.
    if (method === "PATCH") return coresController.rename(id, request);
    if (method === "DELETE") return coresController.remove(id);
  }

  // Projects
  if (pathname === "/api/projects") {
    if (method === "GET") return projectsController.list(request);
    if (method === "POST") return projectsController.create(request);
  }
  if (pathname === "/api/projects/pinned-order" && method === "PATCH") {
    return projectsController.reorderPinned(request);
  }
  m = pathname.match(PROJECT_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return projectsController.getOne(id, request);
    if (method === "PATCH") return projectsController.update(id, request);
    if (method === "DELETE") return projectsController.remove(id, request);
  }
  m = pathname.match(PROJECT_PATH_STATUS_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return projectsController.pathStatus(id);
  }
  m = pathname.match(PROJECT_IMAGE_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return projectsController.getImage(id);
    if (method === "PUT") return projectsController.putImage(id, request);
    if (method === "DELETE") return projectsController.removeImage(id, request);
  }

  // Panel-local presentation for Core-owned projects (issue 98) — group, card
  // image and launch URL for a project whose row lives on its Core.
  if (pathname === "/api/project-presentation" && method === "GET") {
    return projectPresentationController.list();
  }
  if (pathname === "/api/project-presentation/prune" && method === "POST") {
    return projectPresentationController.prune(request);
  }
  // Literal path — matched before PROJECT_PRESENTATION_PATH so "pinned-order"
  // is never read as a project id.
  if (pathname === "/api/project-presentation/pinned-order" && method === "PATCH") {
    return projectPresentationController.reorderPinned(request);
  }
  m = pathname.match(PROJECT_PRESENTATION_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "PATCH") return projectPresentationController.upsert(id, request);
    if (method === "DELETE") return projectPresentationController.remove(id);
  }

  m = pathname.match(PROJECT_TASKS_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return tasksController.listForProject(id, request);
    if (method === "POST") return tasksController.create(id, request);
  }
  // Groups
  if (pathname === "/api/groups") {
    if (method === "GET") return groupsController.list(request);
    if (method === "POST") return groupsController.create(request);
  }
  // Must precede GROUP_PATH — otherwise "order" is captured as a group id.
  if (pathname === "/api/groups/order" && method === "PATCH") {
    return groupsController.reorder(request);
  }
  m = pathname.match(GROUP_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "PATCH") return groupsController.update(id, request);
    if (method === "DELETE") return groupsController.remove(id, request);
  }

  // Tasks
  if (pathname === TASK_SWEEP_DISCONNECTED_PATH && method === "POST") {
    return tasksController.sweepDisconnected();
  }
  m = pathname.match(TASK_PATH);
  if (m) {
    const id = decode(m[1]);
    if (method === "GET") return tasksController.getOne(id, request);
    if (method === "PATCH") return tasksController.update(id, request);
    if (method === "DELETE") return tasksController.remove(id, request);
  }
  m = pathname.match(TASK_STATUS_PATH);
  if (m && method === "POST") return tasksController.setStatus(decode(m[1]), request);
  m = pathname.match(TASK_QUESTION_PATH);
  if (m && method === "GET") return tasksController.readQuestion(decode(m[1]));
  m = pathname.match(TASK_ARCHIVE_PATH);
  if (m && method === "POST") return tasksController.archive(decode(m[1]), request);
  m = pathname.match(TASK_RESTORE_PATH);
  if (m && method === "POST") return tasksController.restore(decode(m[1]), request);

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
