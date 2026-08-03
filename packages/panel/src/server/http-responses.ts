/**
 * Response helpers shared by every controller. Authentication lives in
 * panel-auth.ts (the Operator session) and hook-auth.ts (the machine token the
 * agent hook endpoints still use) — this module deliberately knows nothing
 * about either.
 */
export function jsonError(
  status: number,
  message: string,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
