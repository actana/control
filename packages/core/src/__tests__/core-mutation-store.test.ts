import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import {
  configureCoreMutationStore,
  disposeCoreMutationStore,
  coreMutationStore,
  setLivePtyProbe,
} from "../core-mutation-store";
import {
  configureCoreQueryStore,
  disposeCoreQueryStore,
  coreQueryStore,
} from "../core-query-store";

// Integration test: exercises the real `coreMutationStore` (RW handle) and
// the real `coreQueryStore` (RO handle) against a real SQLite bootstrapped
// with the actual `ensureCoreSchema` DDL — the same shape a fresh VM boots into
// (issue 02). Pins the invariant that ADR-0004's write path lands rows that
// the read path sees, in the shape the loopback server also produces.
//
// This complements `pty-core-link.test.ts` (which uses a fake mutation port
// to exercise the server dispatch) and `core-mutations.test.ts` (which
// exercises the pure SQL helpers against a minimal in-memory schema).

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-core-mutation-store-"));
}

describe("coreMutationStore (integration against real schema)", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = tmpDir();
    bootstrapCoreDb(userDataDir);
    configureCoreMutationStore(userDataDir);
    configureCoreQueryStore(userDataDir);
  });

  afterEach(() => {
    disposeCoreMutationStore();
    disposeCoreQueryStore();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("round-trips create-session → sessionRowsList, with no project and no path anywhere", () => {
    const t = coreMutationStore.mutateSession({
      op: "create",
      sessionId: "t-int-1",
      title: "fix bug",
      agent: "claude-code",
    });
    expect(t?.sessionId).toBe("t-int-1");
    expect(t).toEqual({
      sessionId: "t-int-1",
      title: "fix bug",
      titleManuallySet: false,
      claudeSessionId: null,
      agent: "claude-code",
      status: "ready",
      pinned: false,
      archived: false,
      icon: null,
      updatedAt: expect.any(Number),
    });

    const sessions = coreQueryStore.listSessionRows();
    expect(sessions.map((x) => x.sessionId)).toEqual(["t-int-1"]);
    expect(sessions[0]).toEqual(t);
  });

  it("sessionsList returns sessions enriched with the live PTY probe", () => {
    coreMutationStore.mutateSession({ op: "create", sessionId: "t-live", title: "live", agent: "claude-code" });
    coreMutationStore.mutateSession({ op: "create", sessionId: "t-idle", title: "idle", agent: "claude-code" });
    setLivePtyProbe((sessionId) => (sessionId === "t-live" ? "pty-abc" : null));

    const sessions = coreMutationStore.listSessions();
    const live = sessions.find((s) => s.sessionId === "t-live");
    const idle = sessions.find((s) => s.sessionId === "t-idle");
    expect(live?.ptyId).toBe("pty-abc");
    expect(idle?.ptyId).toBeNull();
  });

  it("delete removes the session from sessionRowsList and hands back what it removed", () => {
    coreMutationStore.mutateSession({ op: "create", sessionId: "t-doomed", title: "doomed", agent: "claude-code" });
    coreMutationStore.mutateSession({ op: "create", sessionId: "t-spared", title: "spared", agent: "claude-code" });

    const removed = coreMutationStore.mutateSession({ op: "delete", sessionId: "t-doomed" });
    expect(removed?.sessionId).toBe("t-doomed");
    expect(removed?.title).toBe("doomed");
    expect(coreQueryStore.listSessionRows().map((t) => t.sessionId)).toEqual(["t-spared"]);
  });

  it("reports a delete of a row that isn't there as null, not an exception", () => {
    expect(coreMutationStore.mutateSession({ op: "delete", sessionId: "t-ghost" })).toBeNull();
  });

  it("throws on an unknown session mutation op (stale-shape guard)", () => {
    expect(() =>
      coreMutationStore.mutateSession({
        op: "bogus",
      } as never),
    ).toThrow(/unknown session mutation op/);
  });
});
