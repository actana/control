import { describe, expect, it } from "vitest";
import { formatTaskDispatchComment, formatTaskNewSessionComment, formatTaskResumeComment, parseTaskDispatchComment, parseTaskResumeComment, resolveAttemptSessions } from "../tasks";

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

// #955: a re-assign resumes the Task's own Session. Its dispatch comment names the Session and the attempt only.
describe("task resume comment format/parse", () => {
  it("writes `Resumed Session <id> (attempt <n>)`", () => {
    expect(formatTaskResumeComment({ attempt: 2, sessionId: "t-alive" })).toBe("Resumed Session t-alive (attempt 2)");
  });

  it("round-trips", () => {
    const fields = { attempt: 3, sessionId: "t-munykjig" };
    expect(parseTaskResumeComment(formatTaskResumeComment(fields))).toEqual(fields);
  });

  it("is not a dispatch comment, and a dispatch comment is not a resume comment", () => {
    expect(parseTaskDispatchComment("Resumed Session t-alive (attempt 2)")).toBeNull();
    expect(parseTaskResumeComment("Dispatched (attempt 1) to OpenCode (opencode) on Core core_a: Session t-alive.")).toBeNull();
  });

  it("rejects a Session id outside the id charset", () => {
    expect(() => formatTaskResumeComment({ attempt: 2, sessionId: "s (attempt 9)" })).toThrow(/session id/i);
    expect(parseTaskResumeComment("Resumed Session s x (attempt 2)")).toBeNull();
  });
});

describe("resolveAttemptSessions", () => {
  const dispatched = (attempt: number, sessionId: string, coreId = "core_a") =>
    ({ authorKind: "system" as const, body: formatTaskDispatchComment({ attempt, agentName: "Claude Code", harness: "claude-code", coreId, sessionId }) });
  const resumed = (attempt: number, sessionId: string) => ({ authorKind: "system" as const, body: formatTaskResumeComment({ attempt, sessionId }) });

  it("gives a resumed attempt the Core, Agent and harness of the dispatch that started its Session", () => {
    const comments = [dispatched(1, "t-1"), { authorKind: "agent" as const, body: "done" }, resumed(2, "t-1")];
    expect(resolveAttemptSessions(comments)).toEqual([
      { index: 0, attempt: 1, sessionId: "t-1", coreId: "core_a", agentName: "Claude Code", harness: "claude-code", resumed: false },
      { index: 2, attempt: 2, sessionId: "t-1", coreId: "core_a", agentName: "Claude Code", harness: "claude-code", resumed: true },
    ]);
  });

  it("skips a resume comment whose Session no dispatch comment names", () => {
    expect(resolveAttemptSessions([resumed(2, "t-gone")])).toEqual([]);
  });

  it("ignores user comments that look like either form", () => {
    const fake = { authorKind: "user" as const, body: formatTaskResumeComment({ attempt: 2, sessionId: "t-1" }) };
    expect(resolveAttemptSessions([dispatched(1, "t-1"), fake]).map((s) => s.attempt)).toEqual([1]);
  });

  it("follows a Session that moved: a later dispatch of another Session wins", () => {
    const comments = [dispatched(1, "t-1"), dispatched(2, "t-2", "core_b"), resumed(3, "t-2")];
    expect(resolveAttemptSessions(comments).map((s) => [s.attempt, s.sessionId, s.coreId])).toEqual([
      [1, "t-1", "core_a"],
      [2, "t-2", "core_b"],
      [3, "t-2", "core_b"],
    ]);
  });
});

describe("the New Session comment (#955)", () => {
  const fields = { attempt: 2, sessionId: "s2", reason: "its Agent now runs on another Core", included: 20, total: 25 };

  it("reads New Session <id> (attempt <n>; resume not possible: <reason>; <m> of <total> comments included)", () => {
    expect(formatTaskNewSessionComment(fields)).toBe("New Session s2 (attempt 2; resume not possible: its Agent now runs on another Core; 20 of 25 comments included)");
  });

  it("is not a dispatch or a resume comment, so it names no Session of an attempt by itself", () => {
    const body = formatTaskNewSessionComment(fields);
    expect(parseTaskDispatchComment(body)).toBeNull();
    expect(parseTaskResumeComment(body)).toBeNull();
    expect(resolveAttemptSessions([{ authorKind: "system", body }])).toEqual([]);
  });

  it("puts a long or multi-line reason from a Core on one short line, and refuses a crafted Session id", () => {
    const body = formatTaskNewSessionComment({ ...fields, reason: `line one\n\nline two ${"x".repeat(300)}` });
    expect(body).not.toContain("\n");
    expect(body).toContain("line one line two");
    expect(body.length).toBeLessThan(330);
    expect(() => formatTaskNewSessionComment({ ...fields, sessionId: "s2 (attempt 9" })).toThrow(/session id/i);
  });
});
