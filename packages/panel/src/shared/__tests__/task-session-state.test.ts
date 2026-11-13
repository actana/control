import { describe, expect, it } from "vitest";
import { TASK_SESSION_STATES, formatTaskSessionStateComment, isTaskSessionState, sessionStateForCoreStatus } from "../tasks";

describe("Task Session states (#949)", () => {
  it("are exactly the five of the shared contract", () => {
    expect([...TASK_SESSION_STATES]).toEqual(["working", "needs-input", "interrupted", "idle-no-result", "exited"]);
    expect(isTaskSessionState("needs-input")).toBe(true);
    expect(isTaskSessionState("finished")).toBe(false);
    expect(isTaskSessionState(null)).toBe(false);
  });

  it("map the Core's Session status", () => {
    expect(sessionStateForCoreStatus("running")).toBe("working");
    expect(sessionStateForCoreStatus("needs-input")).toBe("needs-input");
    expect(sessionStateForCoreStatus("interrupted")).toBe("interrupted");
    expect(sessionStateForCoreStatus("finished")).toBe("idle-no-result");
    expect(sessionStateForCoreStatus("terminated")).toBe("exited");
    expect(sessionStateForCoreStatus("disconnected")).toBe("exited");
  });

  it("map a status nobody knows to null, so nothing is written for it", () => {
    expect(sessionStateForCoreStatus("starting")).toBeNull();
    expect(sessionStateForCoreStatus("")).toBeNull();
  });

  it("comment on a change into needs-input, interrupted or idle-no-result, and on working after one of them", () => {
    for (const to of ["needs-input", "interrupted", "idle-no-result"] as const) {
      expect(formatTaskSessionStateComment("working", to)).toEqual(expect.any(String));
      expect(formatTaskSessionStateComment(null, to)).toEqual(expect.any(String));
      expect(formatTaskSessionStateComment("working", to)).not.toBe(formatTaskSessionStateComment("working", "needs-input" === to ? "interrupted" : "needs-input"));
      expect(formatTaskSessionStateComment(to, "working")).toEqual(expect.any(String));
    }
  });

  it("do not comment on anything else", () => {
    expect(formatTaskSessionStateComment(null, "working")).toBeNull();
    expect(formatTaskSessionStateComment("working", "working")).toBeNull();
    expect(formatTaskSessionStateComment("working", "exited")).toBeNull();
    expect(formatTaskSessionStateComment("needs-input", "exited")).toBeNull();
    expect(formatTaskSessionStateComment("exited", "working")).toBeNull();
  });
});
