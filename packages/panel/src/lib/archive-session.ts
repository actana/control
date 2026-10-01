import type { QueryClient } from "@tanstack/react-query";
import { mutateSessionForCore } from "~/lib/mutate-session-for-core";
import type { OpenTerminal } from "~/lib/terminal-store";
import { sessionsCacheKey } from "~/queries";

type CloseSessionFn = (
  sessionId: string,
  opts?: { activateSessionId?: string | null },
) => Promise<void>;

/**
 * Close + archive one open session, scoped to its own Core so it works for a
 * session belonging to any Core.
 * Mirrors the close+archive core of archiveSessions in the Core workspace route. Throws on
 * failure so callers can surface a toast.
 *
 * Callers archiving many sessions at once should pass `skipInvalidate` and run
 * a single deduped `invalidateSessionQueries` afterwards — a shared key must
 * not be invalidated once per session.
 *
 * `activateSessionId` is handed to `close` so the caller can promote a replacement
 * session to active (e.g. the grid activating the closed cell's neighbour);
 * it defaults to null, which leaves the Core with no active session.
 *
 * Reversible for either owner: a Core lists its archived rows over their own
 * frame (ADR 0019), so the row leaves the grid and reappears under Archived,
 * where Restore flips it back.
 */
export async function archiveOpenSession(
  session: OpenTerminal,
  close: CloseSessionFn,
  queryClient: QueryClient,
  opts?: { skipInvalidate?: boolean; activateSessionId?: string | null },
): Promise<void> {
  await close(session.sessionId, {
    activateSessionId: opts?.activateSessionId ?? null,
  }).catch(() => undefined);
  // The row lives in the owning Core's database (ADR 0004/0005), so the flip
  // rides the panel link to that Core.
  await mutateSessionForCore(session.coreId, {
    op: "update",
    sessionId: session.sessionId,
    archived: true,
  });
  if (!opts?.skipInvalidate) await invalidateSessionQueries(queryClient, [session]);
}

/** Refresh the queries affected by archiving `sessions`, each key exactly once. */
export async function invalidateSessionQueries(
  queryClient: QueryClient,
  sessions: OpenTerminal[],
): Promise<void> {
  const keys = new Map<string, readonly unknown[]>();
  const add = (queryKey: readonly unknown[]) => keys.set(JSON.stringify(queryKey), queryKey);
  for (const { coreId } of sessions) {
    // The card reads from the owning Core's bucket (issue 84).
    add(sessionsCacheKey(coreId));
  }
  await Promise.all(
    [...keys.values()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
