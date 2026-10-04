import type { QueryClient } from "@tanstack/react-query";
import type { Session } from "~/db/schema";
import { DEFAULT_BRANCH, DEFAULT_SESSION_STATUS, type Harness } from "@actana/shared/domain";
import { randomHex } from "@actana/shared/random-hex";
import { sessionsCacheKey } from "~/queries";
import { TITLE_WAITING } from "~/lib/session-sentinels";

export const OPTIMISTIC_SESSION_ID_PREFIX = "t-opt-";

export function isOptimisticSessionId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_SESSION_ID_PREFIX);
}

export function newOptimisticSessionId(): string {
  return `${OPTIMISTIC_SESSION_ID_PREFIX}${randomHex(16)}`;
}

export function buildOptimisticSession(input: {
  id?: string;
  agent: Harness;
  claudeSessionId?: string | null;
  claudeSkipPermissions?: boolean;
  claudeBareSession?: boolean;
}): Session {
  const now = Date.now();
  return {
    id: input.id ?? newOptimisticSessionId(),
    title: TITLE_WAITING,
    titleManuallySet: false,
    icon: null,
    agent: input.agent,
    status: DEFAULT_SESSION_STATUS,
    branch: DEFAULT_BRANCH,
    preview: "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: input.claudeSessionId ?? null,
    claudeSkipPermissions: input.claudeSkipPermissions ?? false,
    claudeBareSession: input.claudeBareSession ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

// Every helper takes the `coreId` first, so writes land in the same cache
// bucket the query reads from (`sessionsCacheKey`).
export function removeSessionFromCache(
  queryClient: QueryClient,
  coreId: string,
  sessionId: string,
) {
  queryClient.setQueryData<Session[]>(
    sessionsCacheKey(coreId),
    (current) => (current ?? []).filter((t) => t.id !== sessionId),
  );
}

export function removeSessionsFromCache(
  queryClient: QueryClient,
  coreId: string,
  sessionIds: Iterable<string>,
) {
  const ids = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  queryClient.setQueryData<Session[]>(
    sessionsCacheKey(coreId),
    (current) => (current ?? []).filter((t) => !ids.has(t.id)),
  );
}

export function restoreSessionsCache(
  queryClient: QueryClient,
  coreId: string,
  sessions: Session[],
) {
  queryClient.setQueryData<Session[]>(sessionsCacheKey(coreId), sessions);
}

export function setSessionArchivedInCache(
  queryClient: QueryClient,
  coreId: string,
  sessionId: string,
  archived: boolean,
) {
  setSessionsArchivedInCache(queryClient, coreId, [sessionId], archived);
}

export function setSessionsArchivedInCache(
  queryClient: QueryClient,
  coreId: string,
  sessionIds: Iterable<string>,
  archived: boolean,
) {
  const ids = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  queryClient.setQueryData<Session[]>(
    sessionsCacheKey(coreId),
    (current) => (current ?? []).map((t) => (ids.has(t.id) ? { ...t, archived } : t)),
  );
}

export function setSessionPinnedInCache(
  queryClient: QueryClient,
  coreId: string,
  sessionId: string,
  pinned: boolean,
) {
  queryClient.setQueryData<Session[]>(
    sessionsCacheKey(coreId),
    (current) =>
      (current ?? []).map((t) => (t.id === sessionId ? { ...t, pinned, updatedAt: Date.now() } : t)),
  );
}

export function appendOptimisticSession(
  queryClient: QueryClient,
  coreId: string,
  session: Session,
) {
  queryClient.setQueryData<Session[]>(
    sessionsCacheKey(coreId),
    (current) => [session, ...(current ?? [])],
  );
}

export function replaceOptimisticSession(
  queryClient: QueryClient,
  coreId: string,
  optimisticId: string,
  session: Session,
) {
  queryClient.setQueryData<Session[]>(
    sessionsCacheKey(coreId),
    (current) => {
      const withoutOptimistic = (current ?? []).filter((t) => t.id !== optimisticId);
      if (withoutOptimistic.some((t) => t.id === session.id)) return withoutOptimistic;
      return [session, ...withoutOptimistic];
    },
  );
}

export function removeOptimisticSession(
  queryClient: QueryClient,
  coreId: string,
  optimisticId: string,
) {
  removeSessionFromCache(queryClient, coreId, optimisticId);
}
