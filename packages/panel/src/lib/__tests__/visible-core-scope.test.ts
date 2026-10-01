// The registry the query layer uses to tell "the Core the operator is on" from
// "the Core the operator has left" (issue 381). Plain counting, no react: what
// is proven here is that a scope stays visible while anything is still showing
// it, that a read nobody was watching is never mistaken for a late one, and —
// the part a visibility snapshot could not do — that a read belonging to a
// visit the operator has left stays stale even once they come back.
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetCoreScopesForTests,
  coreScopeGeneration,
  isCoreScopeVisible,
  retainCoreScope,
  watchCoreScope,
} from "~/lib/visible-core-scope";

/** A reader of one query key, as `useScopedToVisibleCore` registers one. */
function reader(readerKey: string, onLeft: () => void) {
  return { readerKey, onLeft };
}

describe("the visible Core scope", () => {
  beforeEach(() => {
    __resetCoreScopesForTests();
  });

  it("keeps a Core visible until its last reader lets go", () => {
    const board = retainCoreScope("core_a");
    const pane = retainCoreScope("core_a");

    expect(isCoreScopeVisible("core_a")).toBe(true);
    board();
    // The board left the screen; a pane is still reading the same rows.
    expect(isCoreScopeVisible("core_a")).toBe(true);
    pane();
    expect(isCoreScopeVisible("core_a")).toBe(false);
  });

  it("survives a release being called twice", () => {
    const first = retainCoreScope("core_a");
    const second = retainCoreScope("core_a");

    first();
    first();
    expect(isCoreScopeVisible("core_a")).toBe(true);
    second();
    expect(isCoreScopeVisible("core_a")).toBe(false);
  });

  it("keeps two Cores apart", () => {
    const release = retainCoreScope("core_a");

    expect(isCoreScopeVisible("core_b")).toBe(false);
    release();
  });

  it("tells every reader of a scope at once that the operator has left it", () => {
    // A Core is read by two queries — its session list and its archived list —
    // and each unmounts in its own cleanup. The first one to go must not
    // conclude the operator has left while the other is still on screen (#381).
    const seen: string[] = [];
    const releaseArchived = retainCoreScope("core_a", reader("archived", () => seen.push("archived")));
    const releaseSessions = retainCoreScope("core_a", reader("sessions", () => seen.push("sessions")));

    releaseArchived();
    expect(seen).toEqual([]);
    releaseSessions();
    expect(seen.sort()).toEqual(["archived", "sessions"]);
  });

  it("holds one callback per key however often a reader remounts", () => {
    // A pane mounting and unmounting through a single visit used to leave a
    // fresh closure behind every time, and every one of them ran on the way
    // out — the same cancel, over and over, against the same key.
    let cancels = 0;
    const board = retainCoreScope("core_a", reader("sessions", () => (cancels += 1)));
    for (let mount = 0; mount < 5; mount += 1) {
      const pane = retainCoreScope("core_a", reader("sessions", () => (cancels += 1)));
      pane();
    }

    board();
    expect(cancels).toBe(1);
  });

  it("reports a read whose visit the operator has left", () => {
    const release = retainCoreScope("core_b");
    const readIsStale = watchCoreScope("core_b");

    expect(readIsStale()).toBe(false);
    release();
    expect(readIsStale()).toBe(true);
  });

  it("keeps a left read stale after the operator comes back", () => {
    // A → B → A → B. B's first read is cancelled on the way out; its promise
    // still resolves, and by then B is on screen again. "Is B visible?" says
    // yes and lets the abandoned answer overwrite the live one — the visit
    // generation is what says no.
    const firstVisit = retainCoreScope("core_b");
    const readOne = watchCoreScope("core_b");
    firstVisit();

    const secondVisit = retainCoreScope("core_b");
    const readTwo = watchCoreScope("core_b");

    expect(isCoreScopeVisible("core_b")).toBe(true);
    expect(readOne()).toBe(true);
    expect(readTwo()).toBe(false);
    expect(coreScopeGeneration("core_b")).toBe(1);
    secondVisit();
  });

  it("leaves a read nobody is watching alone until a visit actually ends", () => {
    // An imperative prefetch or a `fetchQuery` in a test has no view behind it.
    // Nothing has been left while it is in flight, so it keeps its side
    // effects — which is what the archived read-path suite relies on.
    const readIsStale = watchCoreScope("core_c");

    expect(readIsStale()).toBe(false);
    const release = retainCoreScope("core_c");
    expect(readIsStale()).toBe(false);
    release();
    // A read still outstanding when a visit closes is stale like any other —
    // the safe direction, and it costs a prefetch nothing, because a prefetch
    // that outlives a whole visit is one whose answer nobody wanted.
    expect(readIsStale()).toBe(true);
  });
});
