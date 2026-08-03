import { HTTP_TOO_MANY_REQUESTS } from "~/shared/http-status";
import { jsonError } from "../http-responses";

type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitResult =
  | { ok: true }
  | { ok: false; response: Response };

const buckets = new Map<string, Bucket>();

/** Rate-limit window: one minute (matches the per-minute env limits). */
const RATE_LIMIT_WINDOW_MS = 60_000;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number; message?: string },
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true };
  }
  existing.count += 1;
  if (existing.count <= opts.limit) return { ok: true };
  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return {
    ok: false,
    response: jsonError(
      HTTP_TOO_MANY_REQUESTS,
      opts.message ?? "rate limit exceeded",
      { "retry-after": String(retryAfter) },
    ),
  };
}

export function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  try {
    return new URL(request.url).hostname;
  } catch {
    return "unknown";
  }
}

export function hookCallRateLimit(request: Request, taskId: string): RateLimitResult {
  return rateLimit(`hook-call:${requestIp(request)}:${taskId || "no-task"}`, {
    limit: envNumber("AC_HOOK_RATE_LIMIT_PER_MINUTE", 120),
    windowMs: RATE_LIMIT_WINDOW_MS,
    message: "too many hook calls",
  });
}

// Failed sign-ins are counted in one global bucket, deliberately *not* keyed by
// client IP: the only IP a Panel behind a reverse proxy can see is the one the
// caller puts in X-Forwarded-For, so a per-IP key is a per-request key and
// throttles nobody. There is exactly one Operator, so one bucket is the honest
// scope. The cost is that a flood can make the Operator wait out a window; the
// limit is set high enough that a human typo never triggers it and the window
// is a minute.
const LOGIN_FAILURE_BUCKET = "login-failure";

function loginFailureLimit(): number {
  return envNumber("AC_LOGIN_RATE_LIMIT_PER_MINUTE", 10);
}

/**
 * Whether another password attempt may be *verified*. Checked before hashing —
 * scrypt at login parameters costs ~32 MB and real time per call, so an
 * unauthenticated caller must not be able to make the Panel pay it in a loop.
 */
export function loginAttemptAllowed(): RateLimitResult {
  const bucket = buckets.get(LOGIN_FAILURE_BUCKET);
  const now = Date.now();
  // `<`, not `<=`: the limit is how many failures are allowed in the window,
  // so the attempt after the limit-th is the one that's refused.
  if (!bucket || bucket.resetAt <= now || bucket.count < loginFailureLimit()) {
    return { ok: true };
  }
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return {
    ok: false,
    response: jsonError(HTTP_TOO_MANY_REQUESTS, "too many failed sign-in attempts", {
      "retry-after": String(retryAfter),
    }),
  };
}

/**
 * Charge a wrong password to the bucket. Only failures count: a Panel the
 * Operator is signing into from several devices must not throttle itself.
 */
export function recordLoginFailure(): void {
  rateLimit(LOGIN_FAILURE_BUCKET, {
    limit: loginFailureLimit(),
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
}

export function resetRateLimitsForTests(): void {
  if (process.env.VITEST) buckets.clear();
}
