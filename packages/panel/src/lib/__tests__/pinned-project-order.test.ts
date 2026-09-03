import { describe, expect, it } from "vitest";
import {
  getPinnedProjects,
  mergeSubsetOrder,
  nextPinnedOrder,
  reorderPinnedIds,
  validatePinnedReorder,
  type PinnedOrderable,
} from "~/lib/pinned-project-order";

function project(
  overrides: Partial<PinnedOrderable> & Pick<PinnedOrderable, "id">,
): PinnedOrderable {
  return {
    pinned: false,
    pinnedOrder: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("pinned-project-order", () => {
  it("sorts pinned projects by pinnedOrder then createdAt", () => {
    const projects = [
      project({ id: "c", pinned: true, pinnedOrder: 2, createdAt: 3_000 }),
      project({ id: "a", pinned: true, pinnedOrder: 0, createdAt: 1_000 }),
      project({ id: "b", pinned: true, pinnedOrder: 1, createdAt: 2_000 }),
      project({ id: "u", pinned: false }),
    ];
    expect(getPinnedProjects(projects).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("falls back to createdAt when pinnedOrder is missing", () => {
    const projects = [
      project({ id: "old", pinned: true, pinnedOrder: null, createdAt: 1_000 }),
      project({ id: "new", pinned: true, pinnedOrder: null, createdAt: 2_000 }),
    ];
    expect(getPinnedProjects(projects).map((entry) => entry.id)).toEqual(["old", "new"]);
  });

  it("computes the next pinned order from existing pinned slots", () => {
    const projects = [
      project({ id: "a", pinned: true, pinnedOrder: 0 }),
      project({ id: "b", pinned: true, pinnedOrder: 4 }),
      project({ id: "c", pinned: false, pinnedOrder: 99 }),
    ];
    expect(nextPinnedOrder(projects)).toBe(5);
  });

  it("reorders ids within the pinned list", () => {
    expect(reorderPinnedIds(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderPinnedIds(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  // Regression: with a group active, drags reorder only that group's pinned
  // subset — the merged result must stay a full-order permutation or the
  // server's validatePinnedReorder rejects the save.
  it("splices a reordered group subset back into the full pinned order", () => {
    // Global order interleaves two groups: g1 = [a, c], g2 = [b, d].
    expect(mergeSubsetOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "b", "a", "d"]);
    // Moving a tile to the end of its group's subset.
    expect(mergeSubsetOrder(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "b", "c", "d"]);
    expect(mergeSubsetOrder(["a", "b", "c", "d"], ["d", "b"])).toEqual(["a", "d", "c", "b"]);
  });

  it("mergeSubsetOrder is identity for a full-order subset and ignores unknown ids", () => {
    expect(mergeSubsetOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
    expect(mergeSubsetOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    // A project unpinned mid-drag drops out instead of corrupting the order.
    expect(mergeSubsetOrder(["a", "b", "c"], ["gone", "c", "a"])).toEqual(["c", "b", "a"]);
  });

  it("mergeSubsetOrder output always validates as a complete reorder", () => {
    const pinned = [
      project({ id: "a", pinned: true, pinnedOrder: 0 }),
      project({ id: "b", pinned: true, pinnedOrder: 1 }),
      project({ id: "c", pinned: true, pinnedOrder: 2 }),
    ];
    const merged = mergeSubsetOrder(["a", "b", "c"], ["c", "a"]);
    expect(() => validatePinnedReorder(merged, pinned)).not.toThrow();
  });

  it("validates a complete pinned reorder payload", () => {
    const pinned = [
      project({ id: "a", pinned: true, pinnedOrder: 0 }),
      project({ id: "b", pinned: true, pinnedOrder: 1 }),
    ];
    expect(() => validatePinnedReorder(["a", "b"], pinned)).not.toThrow();
    expect(() => validatePinnedReorder(["b", "a"], pinned)).not.toThrow();
    expect(() => validatePinnedReorder(["a"], pinned)).toThrow(/exactly once/);
    expect(() => validatePinnedReorder(["a", "a", "b"], pinned)).toThrow(/duplicate/);
  });

  // Issue 382. The rail carries the pins of every Core alongside the Panel's
  // own, and a Core's row has no `projects` row here at all — so an id this
  // Panel does not know is a passenger holding a slot in the numbering, not a
  // payload error. The two things the check still owes the caller are that
  // every row it is about to renumber is named, and that no id is named twice.
  it("takes ids the Panel does not own as passengers on the rail order", () => {
    const pinned = [
      project({ id: "a", pinned: true, pinnedOrder: 0 }),
      project({ id: "b", pinned: true, pinnedOrder: 2 }),
    ];
    // A Core pin sitting between the Panel's two rows: that interleaving is
    // the whole reason the slot numbers are rail indices.
    expect(() => validatePinnedReorder(["a", "core-1", "b"], pinned)).not.toThrow();
    // A passenger does not excuse a missing row of our own.
    expect(() => validatePinnedReorder(["a", "core-1"], pinned)).toThrow(/exactly once/);
    expect(() => validatePinnedReorder(["a", "core-1", "core-1", "b"], pinned)).toThrow(
      /duplicate/,
    );
  });

  it("still rejects an unpinned row of the Panel's own when it is told which are ours", () => {
    const pinned = [project({ id: "a", pinned: true, pinnedOrder: 0 })];
    const ours = new Set(["a", "c"]);
    // `c` is this Panel's project and is not pinned — a caller sending it has
    // a bug, and the passenger rule must not swallow that.
    expect(() => validatePinnedReorder(["a", "c"], pinned, ours)).toThrow(/not pinned/);
    // ...while an id from no row here still rides along.
    expect(() => validatePinnedReorder(["a", "core-1"], pinned, ours)).not.toThrow();
  });
});
