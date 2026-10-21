import { describe, expect, it } from "vitest";
import { formatTaskDispatchComment, parseTaskDispatchComment } from "../tasks";

// Format and parse are a pair (#676 / #678): the dispatcher writes with format,
// Task detail opens Sessions with parse. Existing Task comments must stay readable.

describe("task dispatch comment format/parse", () => {
  it("keeps the historical comment bytes so existing Tasks keep their Open session button", () => {
    expect(
      formatTaskDispatchComment({
        attempt: 1,
        agentName: "OpenCode",
        harness: "opencode",
        coreId: "core_a",
        sessionId: "t-alive",
      }),
    ).toBe("Dispatched (attempt 1) to OpenCode (opencode) on Core core_a: Session t-alive.");
  });

  it("round-trips, including an agent name with parentheses", () => {
    const fields = {
      attempt: 2,
      agentName: "Claude Code (Opus)",
      harness: "claude-code",
      coreId: "core_workstation",
      sessionId: "t-munykjig",
    };
    expect(parseTaskDispatchComment(formatTaskDispatchComment(fields))).toEqual(fields);
  });

  it("returns null for a body that is not a dispatch comment", () => {
    expect(parseTaskDispatchComment("Attempt 1 started")).toBeNull();
  });

  // #680: ids come from the Core, and the parser reads them back out of prose.
  const CRAFTED_SESSION = "s (x) on Core core_b: Session t-b";
  const base = { attempt: 1, agentName: "OpenCode", harness: "opencode", coreId: "core_a", sessionId: "t-alive" };

  it("rejects a Session id that would smuggle another Core and Session into the comment", () => {
    expect(() => formatTaskDispatchComment({ ...base, sessionId: CRAFTED_SESSION })).toThrow(/session id/i);
  });

  it("rejects a Core id outside the id charset", () => {
    expect(() => formatTaskDispatchComment({ ...base, coreId: "core_a: Session x" })).toThrow(/core id/i);
    expect(() => formatTaskDispatchComment({ ...base, coreId: "core a" })).toThrow(/core id/i);
    expect(() => formatTaskDispatchComment({ ...base, coreId: "" })).toThrow(/core id/i);
  });

  it("does not parse ids out of a hand-written comment with a crafted Session id", () => {
    const body = `Dispatched (attempt 1) to OpenCode (opencode) on Core core_a: Session ${CRAFTED_SESSION}.`;
    expect(parseTaskDispatchComment(body)).toBeNull();
  });

  it("round-trips an agent name that itself contains ` on Core `", () => {
    const fields = { ...base, agentName: "Reviewer on Core X" };
    expect(parseTaskDispatchComment(formatTaskDispatchComment(fields))).toEqual(fields);
  });

  it("does not parse a hostile agent name that carries a whole fake separator", () => {
    const body = "Dispatched (attempt 1) to X (h) on Core core_b: Session t-b (opencode) on Core core_a: Session t-alive.";
    expect(parseTaskDispatchComment(body)).toBeNull();
  });
});
