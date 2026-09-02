// The registry the query layer uses to tell "the pin the operator is on" from
// "the pin the operator has left" (issue 381). Plain counting, no react: what
// is proven here is that a scope stays visible while anything is still showing
// it, and that a read nobody was watching is never mistaken for a late one.
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetProjectScopesForTests,
  isProjectScopeVisible,
  projectScopeToken,
  retainProjectScope,
  watchProjectScope,
} from "~/lib/visible-project-scope";

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
    const releaseRow = retainProjectScope("p-a", "core_1", () => seen.push("row"));
    const releaseTasks = retainProjectScope("p-a", "core_1", () => seen.push("tasks"));

    releaseRow();
    expect(seen).toEqual([]);
    releaseTasks();
    expect(seen.sort()).toEqual(["row", "tasks"]);
  });

  it("reports a scope the operator has left since the read started", () => {
    const release = retainProjectScope("p-b", "core_1");
    const operatorLeft = watchProjectScope("p-b", "core_1");

    expect(operatorLeft()).toBe(false);
    release();
    expect(operatorLeft()).toBe(true);
  });

  it("never calls a read nobody was watching a late one", () => {
    // An imperative prefetch or a `fetchQuery` in a test has no view behind it,
    // so there is no screen to have left — its side effects still count.
    const operatorLeft = watchProjectScope("p-c", "core_1");

    expect(operatorLeft()).toBe(false);
    const release = retainProjectScope("p-c", "core_1");
    release();
    expect(operatorLeft()).toBe(false);
  });
});
