import { describe, expect, it } from "vitest";
import { dragTargetIsSessionPane } from "./board-drop-arbiter";

/** Stands in for the element a drag event reports as its target. `matches` is
 *  the set of selectors this element (or one of its ancestors) answers to. */
function targetMatching(...matches: string[]): EventTarget {
  return {
    closest: (selector: string) => (matches.includes(selector) ? { tag: selector } : null),
  } as unknown as EventTarget;
}

describe("dragTargetIsSessionPane", () => {
  it("claims a drag whose target sits inside a grid cell", () => {
    expect(dragTargetIsSessionPane({ target: targetMatching("[data-grid-cell]") })).toBe(true);
  });

  it("leaves the board's own space to the board", () => {
    expect(dragTargetIsSessionPane({ target: targetMatching() })).toBe(false);
  });

  it("treats a target that is not an element as board space", () => {
    expect(dragTargetIsSessionPane({ target: null })).toBe(false);
    expect(dragTargetIsSessionPane({ target: {} as EventTarget })).toBe(false);
  });
});
