// The subscriber that notices a Harness arriving after the Core did.
//
// ADR 0031 D7. Everything here is about the two properties of
// `agents:availabilityChanged` that make a naive subscriber wrong: the payload
// is the full map rather than a transition, and the log replays by cursor. A
// subscriber that reacted to "available" in the payload would re-install on
// every tick; one that ignored event ids would re-install on every replay.

import { describe, it, expect, vi } from "vitest";
import { HARNESSES_AVAILABILITY_EVENT_KIND } from "@actana/sdk/core-link-frames";
import { HarnessSkillWatcher } from "../harness-skill-watcher";

const KIND = HARNESSES_AVAILABILITY_EVENT_KIND;

function payload(map: Record<string, string>): string {
  return JSON.stringify({
    availability: Object.fromEntries(
      Object.entries(map).map(([harness, status]) => [harness, { status }]),
    ),
  });
}

describe("what counts as a Harness arriving", () => {
  it("does not treat the first map it sees as an arrival", () => {
    // A Core booting with Claude Code already installed has not just gained it,
    // and the boot-time ensure has already run. Otherwise every Core writes the
    // skill twice on every start.
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ "claude-code": "available" }), 1);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("installs when a Harness goes from missing to available", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ "claude-code": "missing", codex: "missing" }), 1);
    const arrived = watcher.observe(
      KIND,
      payload({ "claude-code": "missing", codex: "available" }),
      2,
    );
    expect(arrived).toEqual(["codex"]);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("installs for a Harness that was not in the previous map at all", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ "claude-code": "missing" }), 1);
    expect(watcher.observe(KIND, payload({ "claude-code": "missing", opencode: "available" }), 2))
      .toEqual(["opencode"]);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("does nothing when the map repeats", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ codex: "missing" }), 1);
    watcher.observe(KIND, payload({ codex: "available" }), 2);
    watcher.observe(KIND, payload({ codex: "available" }), 3);
    watcher.observe(KIND, payload({ codex: "available" }), 4);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("does nothing when a Harness goes away", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ codex: "available" }), 1);
    watcher.observe(KIND, payload({ codex: "missing" }), 2);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("can be seeded with the state at boot, so the first live event is a diff", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({
      ensure,
      initial: { codex: { status: "missing" } },
    });
    expect(watcher.observe(KIND, payload({ codex: "available" }), 1)).toEqual(["codex"]);
    expect(ensure).toHaveBeenCalledOnce();
  });
});

describe("a replay is not news (ADR 0031 D7)", () => {
  it("ignores an event at or below the highest id already processed", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ codex: "missing" }), 10);
    watcher.observe(KIND, payload({ codex: "available" }), 11);
    expect(ensure).toHaveBeenCalledOnce();

    // The log replayed from the start. Every one of these is a transition this
    // watcher has already acted on.
    watcher.observe(KIND, payload({ codex: "missing" }), 10);
    watcher.observe(KIND, payload({ codex: "available" }), 11);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("holds the diff guard as well, so an out-of-order replay is still quiet", () => {
    // Belt and braces on purpose: the two guards fail differently, and a
    // subscriber wired to something other than a monotonic feed keeps one of
    // them.
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ codex: "available" }), 5);
    watcher.observe(KIND, payload({ codex: "available" }), 6);
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("what it declines to act on", () => {
  it("ignores every other event kind", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe("session:finished", payload({ codex: "available" }), 1);
    watcher.observe("session:finished", payload({ codex: "available" }), 2);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not advance past a payload it cannot read", () => {
    // "I did not understand" is not "nothing changed". Advancing the id would
    // make a later, well-formed event at the same position unreachable.
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ codex: "missing" }), 1);
    watcher.observe(KIND, "{ not json", 2);
    expect(watcher.observe(KIND, payload({ codex: "available" }), 2)).toEqual(["codex"]);
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("ignores a payload with no availability map in it", () => {
    const ensure = vi.fn();
    const watcher = new HarnessSkillWatcher({ ensure });
    watcher.observe(KIND, payload({ codex: "missing" }), 1);
    watcher.observe(KIND, JSON.stringify({ somethingElse: true }), 2);
    expect(ensure).not.toHaveBeenCalled();
  });
});
