// The registry the query layer uses to tell "the pin the operator is on" from
// "the pin the operator has left" (issue 381). Plain counting, no react: what
// is proven here is that a scope stays visible while anything is still showing
// it, that a read nobody was watching is never mistaken for a late one, and —
// the part a visibility snapshot could not do — that a read belonging to a
// visit the operator has left stays stale even once they come back.
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetProjectScopesForTests,
  isProjectScopeVisible,
  projectScopeGeneration,
  projectScopeToken,
  retainProjectScope,
  watchProjectScope,
} from "~/lib/visible-project-scope";

/** A reader of one query key, as `useScopedToVisibleProject` registers one. */
function reader(readerKey: string, onLeft: () => void) {
  return { readerKey, onLeft };
}

describe("the visible project scope", () => {
  beforeEach(() => {
    __resetProjectScopesForTests();
  });

  it("keeps a project visible until its last reader lets go", () => {
    const board = retainProjectScope("p-a", "core_1");
    const pane = retainProjectScope("p-a", "core_1");

    expect(isProjectScopeVisible("p-a", "core_1")).toBe(true);
    board();
    // The board left the screen; a pane is still reading the same rows.
    expect(isProjectScopeVisible("p-a", "core_1")).toBe(true);
    pane();
    expect(isProjectScopeVisible("p-a", "core_1")).toBe(false);
  });

  it("survives a release being called twice", () => {
    const first = retainProjectScope("p-a", null);
    const second = retainProjectScope("p-a", null);

    first();
    first();
    expect(isProjectScopeVisible("p-a", null)).toBe(true);
    second();
    expect(isProjectScopeVisible("p-a", null)).toBe(false);
  });

  it("keeps the same project id on two Cores apart", () => {
    const release = retainProjectScope("p-a", "core_1");

    expect(isProjectScopeVisible("p-a", "core_2")).toBe(false);
    // A Core's project and a Panel-owned project of the same id are two
    // different rows, so they are two different scopes.
    expect(isProjectScopeVisible("p-a", null)).toBe(false);
    expect(projectScopeToken("p-a", "core_1")).not.toBe(projectScopeToken("p-a", null));
    release();
  });

  it("tells every reader of a scope at once that the operator has left it", () => {
    // A project is read by two queries — its row and its task list — and each
    // unmounts in its own cleanup. The first one to go must not conclude the
    // operator has left while the other is still on screen (#381).
    const seen: string[] = [];
    const releaseRow = retainProjectScope("p-a", "core_1", reader("row", () => seen.push("row")));
    const releaseTasks = retainProjectScope(
      "p-a",
      "core_1",
      reader("tasks", () => seen.push("tasks")),
    );

    releaseRow();
    expect(seen).toEqual([]);
    releaseTasks();
    expect(seen.sort()).toEqual(["row", "tasks"]);
  });

  it("holds one callback per key however often a reader remounts", () => {
    // A pane mounting and unmounting through a single visit used to leave a
    // fresh closure behind every time, and every one of them ran on the way
    // out — the same cancel, over and over, against the same key.
    let cancels = 0;
    const board = retainProjectScope("p-a", "core_1", reader("tasks", () => (cancels += 1)));
    for (let mount = 0; mount < 5; mount += 1) {
      const pane = retainProjectScope("p-a", "core_1", reader("tasks", () => (cancels += 1)));
      pane();
    }

    board();
    expect(cancels).toBe(1);
  });

  it("reports a read whose visit the operator has left", () => {
    const release = retainProjectScope("p-b", "core_1");
    const readIsStale = watchProjectScope("p-b", "core_1");

    expect(readIsStale()).toBe(false);
    release();
    expect(readIsStale()).toBe(true);
  });

  it("keeps a left read stale after the operator comes back", () => {
    // A → B → A → B. B's first read is cancelled on the way out; its promise
    // still resolves, and by then B is on screen again. "Is B visible?" says
    // yes and lets the abandoned answer overwrite the live one — the visit
    // generation is what says no.
    const firstVisit = retainProjectScope("p-b", "core_1");
    const readOne = watchProjectScope("p-b", "core_1");
    firstVisit();

    const secondVisit = retainProjectScope("p-b", "core_1");
    const readTwo = watchProjectScope("p-b", "core_1");

    expect(isProjectScopeVisible("p-b", "core_1")).toBe(true);
    expect(readOne()).toBe(true);
    expect(readTwo()).toBe(false);
    expect(projectScopeGeneration("p-b", "core_1")).toBe(1);
    secondVisit();
  });

  it("leaves a read nobody is watching alone until a visit actually ends", () => {
    // An imperative prefetch or a `fetchQuery` in a test has no view behind it.
    // Nothing has been left while it is in flight, so it keeps its side
    // effects — which is what the archived read-path suite relies on.
    const readIsStale = watchProjectScope("p-c", "core_1");

    expect(readIsStale()).toBe(false);
    const release = retainProjectScope("p-c", "core_1");
    expect(readIsStale()).toBe(false);
    release();
    // A read still outstanding when a visit closes is stale like any other —
    // the safe direction, and it costs a prefetch nothing, because a prefetch
    // that outlives a whole visit is one whose answer nobody wanted.
    expect(readIsStale()).toBe(true);
  });
});
