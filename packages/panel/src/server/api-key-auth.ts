import { jsonError } from "./http-responses";
import { HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from "~/shared/http-status";
import { OPERATOR_ID } from "./services/operator";
import { authenticateApiKey, type ApiKeyScope } from "./services/api-keys";
import { requireOperatorSession } from "./panel-auth";

/**
 * Who a call runs as (#572). Every route reads the owner from here and nothing
 * else: a key's calls run as the key's owner, a session's as the Operator.
 */
export type ApiPrincipal =
  | { kind: "session"; ownerId: number }
  | { kind: "api-key"; ownerId: number; keyId: string; scope: ApiKeyScope };

const BEARER = /^Bearer[ \t]+(.+)$/i;
const KEY_TOKEN_PREFIX = "ak_";

/**
 * The key a request presents, or null when it presents none: a cookie, a scheme
 * that is not Bearer, or a Bearer token that is not key-shaped (the hook
 * endpoints' machine token rides the same header and is the session gate's to
 * judge, as it always was). Anything shaped `ak_…` is a key being presented,
 * and fails as one if it is not real.
 */
function presentedApiKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  const token = header ? BEARER.exec(header.trim())?.[1]?.trim() : undefined;
  return token?.startsWith(KEY_TOKEN_PREFIX) ? token : null;
}

/**
 * The routes that accept an API key, as a short list: a route is closed to
 * keys until it is added here, so a key never reaches the Operator's whole
 * surface (pairing, forgetting a Core, minting more keys) by default.
 *
 * The public surface is `/api/v1/…` (#572 PR 2). The two unversioned Cores
 * GETs stay so PR 1's proofs keep working; they are the same reads as the v1
 * Cores routes.
 */
export const API_KEY_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/api\/cores$/ },
  { method: "GET", pattern: /^\/api\/cores\/(?!pairing$)[^/]+$/ },
  { method: "GET", pattern: /^\/api\/v1\/cores$/ },
  { method: "GET", pattern: /^\/api\/v1\/cores\/[^/]+$/ },
  { method: "GET", pattern: /^\/api\/v1\/cores\/[^/]+\/agents$/ },
  { method: "GET", pattern: /^\/api\/v1\/agents$/ },
  { method: "POST", pattern: /^\/api\/v1\/agents$/ },
  { method: "GET", pattern: /^\/api\/v1\/agents\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/api\/v1\/agents\/[^/]+$/ },
  { method: "GET", pattern: /^\/api\/v1\/tasks$/ },
  { method: "POST", pattern: /^\/api\/v1\/tasks$/ },
  { method: "GET", pattern: /^\/api\/v1\/tasks\/[^/]+$/ },
  { method: "PATCH", pattern: /^\/api\/v1\/tasks\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/api\/v1\/tasks\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/v1\/tasks\/[^/]+\/status$/ },
  { method: "GET", pattern: /^\/api\/v1\/tasks\/[^/]+\/comments$/ },
  { method: "POST", pattern: /^\/api\/v1\/tasks\/[^/]+\/comments$/ },
];

export function acceptsApiKey(method: string, pathname: string): boolean {
  return API_KEY_ROUTES.some((r) => r.method === method && r.pattern.test(pathname));
}

/**
 * The API gate. A request that presents an API key is judged by the key alone:
 * an unknown, malformed or revoked key is a 401, a key on a route that does
 * not accept keys is a 403, and neither ever falls back to the Operator's
 * session cookie. A request with no key goes through the session gate, which is
 * unchanged.
 */
export async function authenticateApiRequest(
  request: Request,
  method: string,
  pathname: string,
): Promise<{ ok: true; principal: ApiPrincipal } | { ok: false; response: Response }> {
  const presented = presentedApiKey(request);
  if (presented === null) {
    const session = await requireOperatorSession(request);
    if (!session.ok) return session;
    return { ok: true, principal: { kind: "session", ownerId: OPERATOR_ID } };
  }
  const key = await authenticateApiKey(presented);
  if (!key) return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "unauthorized") };
  if (!acceptsApiKey(method, pathname)) {
    return { ok: false, response: jsonError(HTTP_FORBIDDEN, "this route does not accept an API key") };
  }
  return { ok: true, principal: { kind: "api-key", ...key } };
}

/**
 * The gate for a surface that is for API keys alone (`/mcp`, #573). There is no
 * session fallback: no key, a key that is not `ak_…`-shaped, an unknown or a
 * revoked one is a 401, so an Operator's cookie in the same request is never
 * looked at and a tool can never run as anyone but the key's owner.
 */
export async function authenticateApiKeyOnly(
  request: Request,
): Promise<{ ok: true; principal: Extract<ApiPrincipal, { kind: "api-key" }> } | { ok: false; response: Response }> {
  const presented = presentedApiKey(request);
  const key = presented === null ? null : await authenticateApiKey(presented);
  if (!key) {
    return {
      ok: false,
      response: jsonError(HTTP_UNAUTHORIZED, "unauthorized", { "www-authenticate": 'Bearer realm="actana"' }),
    };
  }
  return { ok: true, principal: { kind: "api-key", ...key } };
}
