import { describe, expect, it } from "vitest";
import { createBlockedTracker } from "../blocked-tracker";
import { needsAttention, sessionStateBadge } from "../task-session-state";

describe("sessionStateBadge (#954)", () => {
  it.each([
    ["needs-input", "Needs input"],
    ["interrupted", "Interrupted"],
    ["idle-no-result", "Idle without result"],
  ] as const)("%s has the badge %s", (state, label) => {
    expect(sessionStateBadge(state)?.label).toBe(label);
    expect(needsAttention(state)).toBe(true);
  });
  it.each(["working", "exited", null] as const)("%s has none", (state) => {
    expect(sessionStateBadge(state)).toBeNull();
    expect(needsAttention(state)).toBe(false);
  });
});

describe("createBlockedTracker (#954)", () => {
  const make = () => createBlockedTracker(new Set(["needs-input"]));
  it("learns the first snapshot without firing", () => {
    const t = make();
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual([]);
  });
  it("fires once on entering needs-input, not on later polls that still find it there", () => {
    const t = make();
    t.update([{ key: "a", state: "running" }]);
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual(["a"]);
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual([]);
  });
  it("fires again only after the Session left needs-input", () => {
    const t = make();
    t.update([{ key: "a", state: "running" }]);
    t.update([{ key: "a", state: "needs-input" }]);
    t.update([{ key: "a", state: "running" }]);
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual(["a"]);
  });
  it("does not fire for a suppressed entry and does not fire for it when the Operator looks away", () => {
    const t = make();
    t.update([{ key: "a", state: "running" }]);
    expect(t.update([{ key: "a", state: "needs-input", suppressed: true }])).toEqual([]);
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual([]);
  });
  it("fires for a new key that appears already blocked after the baseline", () => {
    const t = make();
    t.update([{ key: "a", state: "running" }]);
    expect(t.update([{ key: "b", state: "needs-input" }])).toEqual(["b"]);
  });
  it("keeps the last state of a key missing from a later snapshot", () => {
    const t = make();
    t.update([{ key: "a", state: "running" }]);
    t.update([{ key: "a", state: "needs-input" }]);
    t.update([{ key: "z", state: "running" }]);
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual([]);
  });
  it("primes each group on its own", () => {
    const t = make();
    t.update([{ key: "a", state: "needs-input", group: "c1" }]);
    expect(t.update([{ key: "b", state: "needs-input", group: "c2" }])).toEqual([]);
    expect(t.update([{ key: "c", state: "needs-input", group: "c2" }])).toEqual(["c"]);
  });
  it("an empty first snapshot does not count as the baseline", () => {
    const t = make();
    t.update([]);
    expect(t.update([{ key: "a", state: "needs-input" }])).toEqual([]);
  });
  it("a state change between two trigger states fires", () => {
    const t = createBlockedTracker(new Set(["needs-input", "idle-no-result"]));
    t.update([{ key: "a", state: "needs-input" }]);
    expect(t.update([{ key: "a", state: "idle-no-result" }])).toEqual(["a"]);
  });
});
