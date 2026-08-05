import { describe, it, expect } from "vitest";
import {
  mergeFleetTasks,
  fanOutTasks,
  type CoreFanOutResult,
  type CoreFanOutTarget,
} from "../fleet-merge";
import type { CoreLinkTaskSnapshot } from "@actana/shared/core-link-frames";

// The Fleet view fans out `tasksList` to every connected Core in parallel and
// merges results keyed by `coreId/taskId` (CONTEXT.md "Fleet view"). Offline
// Cores show "unreachable + last-seen" with no task rows — the Panel caches
// nothing beyond the Core registry, so a downed Core is honestly blank, not
// stale. With a single registered Core the Fleet view degenerates to per-Core
// navigation.

const task = (over: Partial<CoreLinkTaskSnapshot> & Pick<CoreLinkTaskSnapshot, "taskId" | "projectId">): CoreLinkTaskSnapshot => ({
  title: over.title ?? "task",
  titleManuallySet: over.titleManuallySet ?? false,
  claudeSessionId: over.claudeSessionId ?? null,
  agent: over.agent ?? "claude-code",
  status: over.status ?? "running",
  pinned: over.pinned ?? false,
  archived: over.archived ?? false,
  icon: over.icon ?? null,
  updatedAt: over.updatedAt ?? 1,
  ...over,
});

const online = (coreId: string, coreLabel: string, tasks: CoreLinkTaskSnapshot[], lastSeenAt = 5_000): CoreFanOutResult => ({
  coreId,
  coreLabel,
  ok: true,
  tasks,
  lastSeenAt,
});

const offline = (coreId: string, coreLabel: string, lastSeenAt: number | null = null): CoreFanOutResult => ({
  coreId,
  coreLabel,
  ok: false,
  lastSeenAt,
});

describe("mergeFleetTasks", () => {
  it("merges tasks from multiple online Cores, keyed by coreId/taskId", () => {
    const result = mergeFleetTasks([
      online("core-home", "This Mac", [task({ taskId: "t1", projectId: "p1", title: "a" })]),
      online("core_x", "prod-vm-1", [task({ taskId: "t2", projectId: "p9", title: "b" })]),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => `${r.coreId}/${r.taskId}`).sort()).toEqual([
      "core-home/t1",
      "core_x/t2",
    ]);
    // Each row carries its Core's label so the Fleet view can show it.
    expect(result.rows.find((r) => r.taskId === "t1")?.coreLabel).toBe("This Mac");
    expect(result.rows.find((r) => r.taskId === "t2")?.coreLabel).toBe("prod-vm-1");
    expect(result.offlineCores).toEqual([]);
    expect(result.singleCore).toBe(false);
  });

  it("an offline Core shows in offlineCores with no task rows", () => {
    const result = mergeFleetTasks([
      online("core-home", "This Mac", [task({ taskId: "t1", projectId: "p1" })]),
      offline("core_x", "prod-vm-1", 1_700_000_000_000),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows.every((r) => r.coreId === "core-home")).toBe(true);
    expect(result.offlineCores).toEqual([
      { coreId: "core_x", coreLabel: "prod-vm-1", lastSeenAt: 1_700_000_000_000 },
    ]);
  });

  it("an offline Core that was never seen has lastSeenAt null", () => {
    const result = mergeFleetTasks([offline("core_y", "never-up", null)]);
    expect(result.rows).toEqual([]);
    expect(result.offlineCores).toEqual([
      { coreId: "core_y", coreLabel: "never-up", lastSeenAt: null },
    ]);
  });

  it("does not cache task rows for an offline Core (honestly blank)", () => {
    // Even if a previous fan-out returned tasks for core_x, the merge only
    // sees the current result — a downed Core contributes zero rows, not stale
    // labels or state.
    const result = mergeFleetTasks([offline("core_x", "prod-vm-1", 999)]);
    expect(result.rows).toEqual([]);
    expect(result.offlineCores).toHaveLength(1);
  });

  it("degenerates to single-Core navigation when only one Core is registered", () => {
    const result = mergeFleetTasks([
      online("core-home", "This Mac", [task({ taskId: "t1", projectId: "p1" })]),
    ]);
    expect(result.singleCore).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.offlineCores).toEqual([]);
  });

  it("degenerates to single-Core when the only registered Core is offline", () => {
    const result = mergeFleetTasks([offline("core-home", "This Mac", 123)]);
    expect(result.singleCore).toBe(true);
    expect(result.offlineCores).toHaveLength(1);
  });

  it("sorts rows by updatedAt descending (most recent first)", () => {
    const result = mergeFleetTasks([
      online("c1", "C1", [
        task({ taskId: "old", projectId: "p1", updatedAt: 100 }),
        task({ taskId: "new", projectId: "p1", updatedAt: 999 }),
      ]),
      online("c2", "C2", [task({ taskId: "mid", projectId: "p9", updatedAt: 500 })]),
    ]);
    expect(result.rows.map((r) => r.taskId)).toEqual(["new", "mid", "old"]);
  });

  it("sorts offline Cores by label for stable display", () => {
    const result = mergeFleetTasks([
      offline("z", "zeta", null),
      offline("a", "alpha", null),
      offline("m", "middle", null),
    ]);
    expect(result.offlineCores.map((c) => c.coreLabel)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
  });

  it("handles an empty fan-out (no Cores registered)", () => {
    const result = mergeFleetTasks([]);
    expect(result.rows).toEqual([]);
    expect(result.offlineCores).toEqual([]);
    expect(result.singleCore).toBe(false);
  });

  it("excludes archived tasks from the merged rows", () => {
    // The Fleet view is for active work; archived tasks stay on the Core
    // and are not fanned out into the dashboard. The merge trusts the Core
    // to omit them, but defensively drops any that slip through so a stale
    // Core never pollutes the active dashboard.
    const result = mergeFleetTasks([
      online("c1", "C1", [
        task({ taskId: "live", projectId: "p1", archived: false }),
        task({ taskId: "done", projectId: "p1", archived: true }),
      ]),
    ]);
    expect(result.rows.map((r) => r.taskId)).toEqual(["live"]);
  });
});

describe("fanOutTasks", () => {
  const target = (coreId: string, coreLabel: string, lastSeenAt: number | null = null): CoreFanOutTarget => ({
    coreId,
    coreLabel,
    lastSeenAt,
  });
  const tasks = (taskId: string, projectId = "p1"): CoreLinkTaskSnapshot[] => [
    { taskId, projectId, title: "t", titleManuallySet: false, claudeSessionId: null, agent: "claude-code", status: "running", pinned: false, archived: false, icon: null, updatedAt: 1 },
  ];

  it("returns ok+tasks for Cores whose query resolves", async () => {
    const results = await fanOutTasks(
      [target("c1", "C1"), target("c2", "C2")],
      async (coreId) => (coreId === "c1" ? tasks("t1") : tasks("t2", "p2")),
    );
    expect(results).toHaveLength(2);
    const c1 = results.find((r) => r.coreId === "c1")!;
    expect(c1.ok).toBe(true);
    if (c1.ok) expect(c1.tasks.map((t) => t.taskId)).toEqual(["t1"]);
  });

  it("returns offline (ok:false) for a Core whose query rejects", async () => {
    const results = await fanOutTasks(
      [target("c1", "C1", 999)],
      async () => {
        throw new Error("core-link down");
      },
    );
    expect(results).toEqual([{ coreId: "c1", coreLabel: "C1", ok: false, lastSeenAt: 999 }]);
  });

  it("returns offline (ok:false) for a Core whose query times out", async () => {
    const results = await fanOutTasks(
      [target("slow", "Slow", 100)],
      async () => new Promise<CoreLinkTaskSnapshot[]>((resolve) => setTimeout(() => resolve(tasks("late")), 1000)),
      50,
    );
    expect(results).toEqual([{ coreId: "slow", coreLabel: "Slow", ok: false, lastSeenAt: 100 }]);
  });

  it("carries lastSeenAt through to online results (fallback to now)", async () => {
    const before = Date.now();
    const results = await fanOutTasks(
      [target("c1", "C1", null), target("c2", "C2", 5000)],
      async () => tasks("t1"),
    );
    const after = Date.now();
    const c1 = results.find((r) => r.coreId === "c1")!;
    const c2 = results.find((r) => r.coreId === "c2")!;
    if (c1.ok) expect(c1.lastSeenAt).toBeGreaterThanOrEqual(before);
    if (c2.ok) expect(c2.lastSeenAt).toBe(5000);
    if (c1.ok) expect(c1.lastSeenAt).toBeLessThanOrEqual(after);
  });

  it("fans out in parallel (not sequentially)", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await fanOutTasks(
      [target("a", "A"), target("b", "B"), target("c", "C")],
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return tasks("t");
      },
    );
    expect(maxActive).toBeGreaterThan(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("returns an empty array for an empty target list", async () => {
    const results = await fanOutTasks([], async () => tasks("t"));
    expect(results).toEqual([]);
  });

  it("preserves target order in the results", async () => {
    const results = await fanOutTasks(
      [target("z", "Z"), target("a", "A"), target("m", "M")],
      async (coreId) => tasks(coreId),
    );
    expect(results.map((r) => r.coreId)).toEqual(["z", "a", "m"]);
  });
});
