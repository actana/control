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
});
