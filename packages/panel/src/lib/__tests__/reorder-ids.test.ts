import { describe, expect, it } from "vitest";
import { reorderIds } from "../reorder-ids";

describe("reorderIds", () => {
  it("moves an id forward", () => {
    expect(reorderIds(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves an id back", () => {
    expect(reorderIds(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("returns a copy, not the input, when nothing moves", () => {
    const order = ["a", "b"];
    const same = reorderIds(order, 1, 1);

    expect(same).toEqual(order);
    expect(same).not.toBe(order);
  });
});
