import { timingSafeEqual } from "node:crypto";
import { getOrCreateApiToken } from "./services/settings";
import { HTTP_UNAUTHORIZED } from "~/shared/http-status";
import { jsonError } from "./http-responses";

/**
 * Machine authentication for `/api/hooks/*` — the endpoints an agent's hooks
 * POST to while a session runs. This is not an Operator surface: no human and
 * no browser is involved, so the Operator session cookie cannot gate it.
 *
 * These endpoints belong to the Harness, and move onto it with the rest of the
 * PTY/session path (tickets 05 and 06). Until then the Panel process still
 * serves them, gated by the same shared token the Harness hands each agent in
 * its hook environment (shared/mission-control-hook-env.ts).
 */
function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Length is compared first (and leaks) because timingSafeEqual throws on a
  // length mismatch; the token is fixed-length, so nothing usable leaks.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function requireHookToken(
  request: Request,
): { ok: true } | { ok: false; response: Response } {
  // Headers.get() is case-insensitive per the Fetch spec — one lookup is enough.
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = getOrCreateApiToken().trim();
  if (!token || !expected || !tokensEqual(token, expected)) {
    return { ok: false, response: jsonError(HTTP_UNAUTHORIZED, "unauthorized") };
  }
  return { ok: true };
}
