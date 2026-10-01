import { describe, expect, it } from "vitest";
import type { Session } from "~/db/schema";
import {
  OPTIMISTIC_SESSION_ID_PREFIX,
  appendOptimisticSession,
  buildOptimisticSession,
  isOptimisticSessionId,
  newOptimisticSessionId,
  removeOptimisticSession,
  removeSessionFromCache,
  removeSessionsFromCache,
  replaceOptimisticSession,
  restoreSessionsCache,
} from "../optimistic-session";
import { queryKeys } from "~/queries";

function createQueryClientStub() {
  const cache = new Map<string, unknown>();
  return {
    setQueryData: <T,>(key: readonly unknown[], updater: T | ((current: T | undefined) => T)) => {
      const current = cache.get(JSON.stringify(key)) as T | undefined;
      const next = typeof updater === "function" ? (updater as (c: T | undefined) => T)(current) : updater;
      cache.set(JSON.stringify(key), next);
      return next;
    },
    getQueryData: <T,>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined,
  };
}

describe("optimistic-session", () => {
  it("marks optimistic ids with a dedicated prefix", () => {
    const id = newOptimisticSessionId();
    expect(id.startsWith(OPTIMISTIC_SESSION_ID_PREFIX)).toBe(true);
    expect(isOptimisticSessionId(id)).toBe(true);
    expect(isOptimisticSessionId("t-abc")).toBe(false);
  });

  it("builds a ready-status placeholder session", () => {
    const session = buildOptimisticSession({
      agent: "claude-code",
      claudeSessionId: "sess-1",
    });
    expect(session.title).toBe("Waiting for initial prompt...");
    expect(session.status).toBe("ready");
    expect(session).not.toHaveProperty("projectId");
    expect(isOptimisticSessionId(session.id)).toBe(true);
  });

  it("prepends optimistic rows to match server createdAt desc order", () => {
    const qc = createQueryClientStub();
    const key = queryKeys.sessions("core-a");
    const existing = buildOptimisticSession({
      id: "t-existing",
      agent: "codex",
    });
    qc.setQueryData(key, [existing]);

    const optimistic = buildOptimisticSession({
      agent: "codex",
    });
    appendOptimisticSession(qc as never, "core-a", optimistic);

    const sessions = qc.getQueryData<Session[]>(key)!;
    expect(sessions.map((t) => t.id)).toEqual([optimistic.id, "t-existing"]);
  });

  it("replaces an optimistic row without duplicating the persisted session", () => {
    const qc = createQueryClientStub();
    const key = queryKeys.sessions("core-a");
    const existing = buildOptimisticSession({
      id: "t-existing",
      agent: "codex",
    });
    qc.setQueryData(key, [existing]);

    const optimistic = buildOptimisticSession({
      agent: "codex",
    });
    appendOptimisticSession(qc as never, "core-a", optimistic);

    const persisted = { ...optimistic, id: "t-real", updatedAt: optimistic.updatedAt + 1 } satisfies Session;
    replaceOptimisticSession(qc as never, "core-a", optimistic.id, persisted);

    const sessions = qc.getQueryData<Session[]>(key)!;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.id).toBe("t-real");
    expect(sessions[1]?.id).toBe("t-existing");
  });

  it("drops an optimistic row on rollback", () => {
    const qc = createQueryClientStub();
    const key = queryKeys.sessions("core-a");
    const optimistic = buildOptimisticSession({
      agent: "codex",
    });
    appendOptimisticSession(qc as never, "core-a", optimistic);
    removeOptimisticSession(qc as never, "core-a", optimistic.id);
    expect(qc.getQueryData<Session[]>(key)).toEqual([]);
  });

  it("removes persisted sessions from cache and restores on rollback", () => {
    const qc = createQueryClientStub();
    const key = queryKeys.sessions("core-a");
    const keep = buildOptimisticSession({
      id: "t-keep",
      agent: "codex",
    });
    const remove = buildOptimisticSession({
      id: "t-remove",
      agent: "claude-code",
    });
    const snapshot = [keep, remove];
    qc.setQueryData(key, snapshot);

    removeSessionFromCache(qc as never, "core-a", "t-remove");
    expect(qc.getQueryData<Session[]>(key)).toEqual([keep]);

    restoreSessionsCache(qc as never, "core-a", snapshot);
    expect(qc.getQueryData<Session[]>(key)).toEqual(snapshot);
  });

  it("removes multiple sessions from cache in one update", () => {
    const qc = createQueryClientStub();
    const key = queryKeys.sessions("core-a");
    const sessions = [
      buildOptimisticSession({ id: "t-1", agent: "codex" }),
      buildOptimisticSession({ id: "t-2", agent: "codex" }),
      buildOptimisticSession({ id: "t-3", agent: "codex" }),
    ];
    qc.setQueryData(key, sessions);

    removeSessionsFromCache(qc as never, "core-a", new Set(["t-1", "t-3"]));
    expect(qc.getQueryData<Session[]>(key)?.map((t) => t.id)).toEqual(["t-2"]);
  });
});
