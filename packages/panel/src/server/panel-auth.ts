import { jsonError } from "./http-responses";
import { LOGIN_PATH, SETUP_PATH, withCarriedQuery } from "~/lib/auth-paths";
import { HTTP_UNAUTHORIZED } from "~/shared/http-status";
import { operatorExists } from "./services/operator";
import {
  SESSION_TTL_MS,
  resolvePanelSession,
  type PanelSession,
} from "./services/panel-sessions";

/**
 * The Operator's session cookie. HTTP-only so page JavaScript — including
 * anything an XSS bug could inject — can never read it, and SameSite=Lax so a
 * third-party page can't ride it on a state-changing request. Lax rather than
 * Strict keeps a link into the Panel from landing on a login page for someone
 * who is already signed in.
 */
export const PANEL_SESSION_COOKIE = "ac_panel_session";

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== PANEL_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * Whether the browser reached us over TLS. The Panel itself listens on plain
 * HTTP and trusts the reverse proxy for TLS (ADR 0010), so the proxy's
 * `x-forwarded-proto` is the signal — falling back to the request URL for a
 * Panel exposed directly.
 */
function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieHeader(request: Request, token: string): string {
  const attributes = [
    `${PANEL_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedSessionCookieHeader(request: Request): string {
  const attributes = [`${PANEL_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export type PanelAuthState = {
  /** No Operator yet — the Panel is in its first-boot window. */
  needsSetup: boolean;
  session: PanelSession | null;
};

export function readPanelAuthState(request: Request): PanelAuthState {
  if (!operatorExists()) return { needsSetup: true, session: null };
  return { needsSetup: false, session: resolvePanelSession(readSessionCookie(request)) };
}

/**
 * A 303 to `pathname`, carrying `search` — the query the browser asked with —
 * onto it.
 *
 * Every redirect in this gate passes through here with the incoming query,
 * because a gate that answers `/?step=redeem` with a bare `/login` has thrown
 * away the only thing the request said (#406). `withCarriedQuery` re-encodes
 * the value, so nothing an attacker puts in a query can break the header.
 */
function redirectTo(pathname: string, search: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: withCarriedQuery(pathname, search), "cache-control": "no-store" },
  });
}

/**
 * The gate on the served UI. Anything but the login and setup pages requires a
 * session, so pointing a browser at an exposed Panel gets you a login page and
 * nothing else — no shell, no SSR'd fleet, no data.
 *
 * Only page navigations are redirected. Asset and module requests are left
 * alone (a login page has to be able to load its own JavaScript); nothing
 * behind them is Operator data, which all arrives through the gated `/api/*`.
 */
export function documentAuthRedirect(request: Request): Response | null {
  if (!request.headers.get("accept")?.includes("text/html")) return null;
  let pathname: string;
  let search: string;
  try {
    const url = new URL(request.url);
    pathname = url.pathname;
    // The pairing query travels with the browser through the whole round trip
    // — out to setup or login and back again — rather than being dropped here
    // and reconstructed from somewhere else later.
    search = url.search;
  } catch {
    return null;
  }
  if (pathname.startsWith("/api/")) return null;

  const { needsSetup, session } = readPanelAuthState(request);
  if (pathname === SETUP_PATH) {
    if (needsSetup) return null;
    return redirectTo(session ? "/" : LOGIN_PATH, search);
  }
  if (pathname === LOGIN_PATH) {
    if (needsSetup) return redirectTo(SETUP_PATH, search);
    return session ? redirectTo("/", search) : null;
  }
  if (session) return null;
  return redirectTo(needsSetup ? SETUP_PATH : LOGIN_PATH, search);
}

/** The gate every authenticated surface goes through. */
export function requireOperatorSession(
  request: Request,
): { ok: true; session: PanelSession } | { ok: false; response: Response } {
  const { session } = readPanelAuthState(request);
  if (session) return { ok: true, session };
  return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "unauthorized") };
}
