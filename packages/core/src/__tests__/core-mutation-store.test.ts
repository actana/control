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
// with the actual `ensureSchema` DDL — the same shape a fresh VM boots into
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

  it("round-trips create-project → projectsList", () => {
    const created = coreMutationStore.mutateProject({
      op: "create",
      projectId: "p-int-1",
      name: "MC",
      path: userDataDir,
    });
    expect(created?.projectId).toBe("p-int-1");
    expect(created?.name).toBe("MC");
    expect(created?.path).toBe(userDataDir);

    const listed = coreQueryStore.listProjects();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.projectId).toBe("p-int-1");
  });

  it("round-trips create-task → tasksList", () => {
    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p-int-2",
      name: "MC",
      path: userDataDir,
    });
    const t = coreMutationStore.mutateTask({
      op: "create",
      taskId: "t-int-1",
      projectId: "p-int-2",
      title: "fix bug",
      agent: "claude-code",
    });
    expect(t?.taskId).toBe("t-int-1");

    const tasks = coreQueryStore.listTasks("p-int-2");
    expect(tasks.map((x) => x.taskId)).toEqual(["t-int-1"]);
  });

  it("rejects a project path that doesn't exist with an actionable error", () => {
    expect(() =>
      coreMutationStore.mutateProject({
        op: "create",
        name: "bogus",
        path: "/definitely/does/not/exist/on/this/vm/xyzzy",
      }),
    ).toThrow(/does not exist on the Core/);
    expect(coreQueryStore.listProjects()).toEqual([]);
  });

  it("rejects a non-absolute project path", () => {
    expect(() =>
      coreMutationStore.mutateProject({
        op: "create",
        name: "bogus",
        path: "relative/dir",
      }),
    ).toThrow(/must be absolute/);
  });

  it("archive cascades child tasks and returns the pre-delete snapshot", () => {
    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p-int-3",
      name: "cascade-src",
      path: userDataDir,
    });
    coreMutationStore.mutateTask({
      op: "create",
      taskId: "t-int-2",
      projectId: "p-int-3",
      title: "child",
      agent: "claude-code",
    });
    expect(coreQueryStore.listTasks("p-int-3")).toHaveLength(1);

    const snap = coreMutationStore.mutateProject({
      op: "archive",
      projectId: "p-int-3",
    });
    expect(snap?.projectId).toBe("p-int-3");
    expect(snap?.name).toBe("cascade-src");
    expect(coreQueryStore.listProjects()).toEqual([]);
    expect(coreQueryStore.listTasks("p-int-3")).toEqual([]);
  });

  it("sessionsList returns tasks enriched with the live PTY probe", () => {
    coreMutationStore.mutateProject({
      op: "create",
      projectId: "p-int-4",
      name: "sess",
      path: userDataDir,
    });
    coreMutationStore.mutateTask({
      op: "create",
      taskId: "t-live",
      projectId: "p-int-4",
      title: "live",
      agent: "claude-code",
    });
    coreMutationStore.mutateTask({
      op: "create",
      taskId: "t-idle",
      projectId: "p-int-4",
      title: "idle",
      agent: "claude-code",
    });
    setLivePtyProbe((taskId) => (taskId === "t-live" ? "pty-abc" : null));

    const sessions = coreMutationStore.listSessions("p-int-4");
    const live = sessions.find((s) => s.taskId === "t-live");
    const idle = sessions.find((s) => s.taskId === "t-idle");
    expect(live?.ptyId).toBe("pty-abc");
    expect(idle?.ptyId).toBeNull();
  });

  it("throws on an unknown project mutation op (stale-shape guard)", () => {
    expect(() =>
      coreMutationStore.mutateProject({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        op: "bogus",
      } as any),
    ).toThrow(/unknown project mutation op/);
  });
});
