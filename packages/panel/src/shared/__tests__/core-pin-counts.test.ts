import { describe, it, expect } from "vitest";
import type { CoreLinkTaskSnapshot } from "@actana/sdk/core-link-frames";
import { corePinTaskCounts } from "../core-pin-counts";
import { emptyTaskCounts, type ProjectTaskCounts } from "../projects";

// The rule the rail's dots follow when a Core answers, and the one they follow
// when it cannot (#377, and PR #456's review). Zeroing an unreachable Core is
// the failure this exists to prevent: no dot reads as "nothing running", which
// is a claim about a machine the Panel just failed to reach.

function task(over: Partial<CoreLinkTaskSnapshot> = {}): CoreLinkTaskSnapshot {
  return {
    taskId: "t1",
    projectId: "p1",
    title: "Ship it",
    titleManuallySet: false,
    claudeSessionId: null,
    agent: "claude-code",
    status: "running",
    pinned: false,
    archived: false,
    icon: null,
    updatedAt: 10,
    ...over,
  };
}

function counts(over: Partial<ProjectTaskCounts> = {}): ProjectTaskCounts {
  return { ...emptyTaskCounts(), ...over };
}

describe("corePinTaskCounts", () => {
  it("counts a Core's answer against the pins it was asked about", () => {
    const result = corePinTaskCounts(["p1", "p2"], [task(), task({ taskId: "t2" })], new Map());
    expect(result.get("p1")?.running).toBe(2);
    // Asked about, no rows: a real zero, and how the last Session going away
    // clears the dot.
    expect(result.get("p2")).toEqual(emptyTaskCounts());
  });

  it("keeps the last known counts when the Core could not be asked", () => {
    const lastKnown = new Map([["p1", counts({ running: 1, total: 1, activeNonDone: 1 })]]);
    const result = corePinTaskCounts(["p1"], null, lastKnown);
    expect(result.get("p1")?.running).toBe(1);
  });

  it("never zeroes an unreachable Core's pins into looking idle", () => {
    const lastKnown = new Map([["p1", counts({ "needs-input": 2, total: 2, activeNonDone: 2 })]]);
    expect(corePinTaskCounts(["p1"], null, lastKnown).get("p1")?.["needs-input"]).toBe(2);
  });

  // Nothing else to show, and honest about a Core this tab has never reached.
  it("falls back to zeros for a pin it has never had counts for", () => {
    expect(corePinTaskCounts(["p1"], null, new Map()).get("p1")).toEqual(emptyTaskCounts());
  });

  it("answers only for the pins it was given", () => {
    const result = corePinTaskCounts(["p1"], [task({ projectId: "p9" })], new Map());
    expect([...result.keys()]).toEqual(["p1"]);
    expect(result.get("p1")).toEqual(emptyTaskCounts());
  });
});
