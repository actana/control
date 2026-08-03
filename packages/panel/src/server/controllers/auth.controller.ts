import { json, jsonError } from "../http-responses";
import {
  clearedSessionCookieHeader,
  readPanelAuthState,
  readSessionCookie,
  requireOperatorSession,
  sessionCookieHeader,
} from "../panel-auth";
import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_UNAUTHORIZED,
} from "~/shared/http-status";
import {
  OperatorExistsError,
  PasswordPolicyError,
  createOperator,
  getOperator,
  operatorExists,
  setOperatorPassword,
  verifyOperatorPassword,
} from "../services/operator";
import { loginAttemptAllowed, recordLoginFailure } from "../services/rate-limits";
import {
  createPanelSession,
  revokeAllPanelSessions,
  revokePanelSession,
} from "../services/panel-sessions";

type Body = Record<string, unknown>;

async function readBody(request: Request): Promise<Body> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Body) : {};
  } catch {
    return {};
  }
}

function withSessionCookie(request: Request, response: Response, token: string): Response {
  response.headers.append("set-cookie", sessionCookieHeader(request, token));
  return response;
}

function publicOperator(): { name: string } | null {
  const operator = getOperator();
  return operator ? { name: operator.name } : null;
}

/**
 * The one endpoint a browser may call before it has anything: it tells the
 * login page whether this Panel is still on its first boot.
 */
export function state(request: Request): Response {
  const { needsSetup, session } = readPanelAuthState(request);
  return json({
    needsSetup,
    authenticated: session !== null,
    operator: session ? publicOperator() : null,
  });
}

/** First boot: create the single Operator and log this browser in. */
export async function setup(request: Request): Promise<Response> {
  if (operatorExists()) return jsonError(HTTP_CONFLICT, "an Operator already exists");
  const body = await readBody(request);
  let operator;
  try {
    operator = createOperator({ name: body.name, password: body.password });
  } catch (err) {
    if (err instanceof OperatorExistsError) {
      return jsonError(HTTP_CONFLICT, "an Operator already exists");
    }
    if (err instanceof PasswordPolicyError) return jsonError(HTTP_BAD_REQUEST, err.message);
    throw err;
  }
  const { token } = createPanelSession();
  return withSessionCookie(request, json({ operator: { name: operator.name } }), token);
}

export async function login(request: Request): Promise<Response> {
  if (!operatorExists()) return jsonError(HTTP_CONFLICT, "setup required");
  // Checked before the body is hashed: verifying a password is deliberately
  // expensive, so a throttled caller must not get to spend it.
  const allowed = loginAttemptAllowed();
  if (!allowed.ok) return allowed.response;

  const body = await readBody(request);
  if (!verifyOperatorPassword(body.password)) {
    recordLoginFailure();
    return jsonError(HTTP_UNAUTHORIZED, "incorrect password");
  }
  const { token } = createPanelSession();
  return withSessionCookie(request, json({ operator: publicOperator() }), token);
}

export function logout(request: Request): Response {
  revokePanelSession(readSessionCookie(request));
  const response = json({ ok: true });
  response.headers.append("set-cookie", clearedSessionCookieHeader(request));
  return response;
}

/**
 * Change the password and revoke every session — including the other browsers
 * this Operator is signed in from, which is the whole point after a device
 * loss. The caller gets a fresh session so the tab they did it from survives.
 */
export async function changePassword(request: Request): Promise<Response> {
  const auth = requireOperatorSession(request);
  if (!auth.ok) return auth.response;

  const body = await readBody(request);
  if (!verifyOperatorPassword(body.currentPassword)) {
    return jsonError(HTTP_UNAUTHORIZED, "incorrect password");
  }
  try {
    setOperatorPassword(body.newPassword);
  } catch (err) {
    if (err instanceof PasswordPolicyError) return jsonError(HTTP_BAD_REQUEST, err.message);
    throw err;
  }
  revokeAllPanelSessions();
  const { token } = createPanelSession();
  return withSessionCookie(request, json({ ok: true }), token);
}
