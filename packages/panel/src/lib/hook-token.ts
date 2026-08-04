/**
 * The machine token an agent's hooks POST back with (see
 * server/hook-auth.ts). It is *not* the Operator's credential — the Operator
 * authenticates with a session cookie the browser attaches on its own.
 *
 * Nothing in the browser resolves it any more: a session runs on a Core, and
 * that Core's Core owns the hook env for the PTYs it spawns. This cache
 * exists only for callers that were handed a token explicitly via
 * {@link setHookToken}; everyone else gets `null` and lets the Core decide.
 */
let cached: string | null = null;

export function setHookToken(token: string | null): void {
  cached = token;
}

export async function resolveHookToken(): Promise<string | null> {
  return cached;
}
