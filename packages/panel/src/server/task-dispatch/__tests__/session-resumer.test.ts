import { beforeEach, describe, expect, it, vi } from "vitest";
import { harnessAutoModeFlag } from "@actana/sdk/core";

const start = vi.hoisted(() => vi.fn());
const attach = vi.hoisted(() => vi.fn());
vi.mock("@actana/sdk/core", async (orig) => ({
  ...(await orig<typeof import("@actana/sdk/core")>()),
  CoreSession: { start, attach },
}));
const sessionRowsList = vi.hoisted(() => vi.fn());
const findBySession = vi.hoisted(() => vi.fn());
const sessionsMutate = vi.hoisted(() => vi.fn());
const link = vi.hoisted(() => ({ current: true }));
vi.mock("../../services/core-link-manager", () => ({
  coreLinkManager: () => ({ client: () => (link.current ? { sdk: { sessionsMutate, sessionRowsList, findBySession } } : null) }),
}));

import { resumeSessionOnCore } from "../session-starter";
import { RESUME_REFUSALS } from "../types";

const POINTER = "Read ~/shared/tasks/task_1/prompt-attempt-2.md and do what it says. It holds your Task and tells you where to report the result.";
const request = (over: Record<string, unknown> = {}) =>
  ({ coreId: "core_1", sessionId: "row-1", harness: "claude-code", model: "claude-sonnet-5-5", flags: [], prompt: POINTER, ...over }) as never;
const row = (over: Record<string, unknown> = {}) => ({ sessionId: "row-1", agent: "claude-code", status: "terminated", claudeSessionId: "uuid-1", ...over });
const handle = () => ({ sessionId: "row-1", onExit: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}), dispose: vi.fn(), exitStatus: () => null, send: vi.fn(async (_text: string) => true) });

describe("resuming a Task's own Session on a Core (#955)", () => {
  beforeEach(() => {
    start.mockReset();
    attach.mockReset();
    sessionRowsList.mockReset();
    findBySession.mockReset();
    sessionsMutate.mockReset();
    link.current = true;
    sessionRowsList.mockResolvedValue({ sessions: [row()], archivedCount: 0 });
    findBySession.mockResolvedValue({ ptyId: null });
    start.mockImplementation(async () => handle());
  });

  it("reopens the same Session row with the harness's resume command, and types the pointer in as the prompt", async () => {
    const out = await resumeSessionOnCore(request(), 1);

    expect(out.kind).toBe("resumed");
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "row-1",
        harness: "claude-code",
        prompt: POINTER,
        command: "claude --resume uuid-1 --model claude-sonnet-5-5 --dangerously-skip-permissions",
        dangerouslySkipPermissions: true,
      }),
    );
    // The row is the Task's own: nothing is created, nothing deleted.
    expect(sessionsMutate).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", "codex resume uuid-1 --model claude-sonnet-5-5 --enable hooks --yolo"],
    ["cursor-cli", "cursor-agent --resume uuid-1 --model claude-sonnet-5-5 --force"],
    ["opencode", "opencode --model claude-sonnet-5-5"],
    ["pi", "pi --model claude-sonnet-5-5 --session uuid-1"],
  ] as const)("%s: the same Session through that harness's own resume form", async (harness, command) => {
    // opencode resumes only a `ses...` id, as its own launch does.
    const id = harness === "opencode" ? "ses_abc" : "uuid-1";
    sessionRowsList.mockResolvedValue({ sessions: [row({ agent: harness, claudeSessionId: id })], archivedCount: 0 });
    await resumeSessionOnCore(request({ harness }), 1);
    const expected = harness === "opencode" ? "opencode --model claude-sonnet-5-5 --session ses_abc" : command;
    expect(start.mock.calls[0]![1].command).toBe(expected);
  });

  it.each(["claude-code", "codex", "cursor-cli", "opencode", "pi"] as const)("%s: the skip-permissions flag in the command and the option agree, or the Core's spawn policy refuses it", async (harness) => {
    const id = harness === "opencode" ? "ses_abc" : "uuid-1";
    sessionRowsList.mockResolvedValue({ sessions: [row({ agent: harness, claudeSessionId: id })], archivedCount: 0 });
    await resumeSessionOnCore(request({ harness, model: null }), 1);
    const arg = start.mock.calls[0]![1];
    const flag = harnessAutoModeFlag(harness);
    if (flag) {
      expect(arg.command.split(" ")).toContain(flag);
      expect(arg.dangerouslySkipPermissions).toBe(true);
    } else {
      expect(arg).not.toHaveProperty("dangerouslySkipPermissions");
    }
  });

  it("cannot resume a Session the Core has no row for", async () => {
    sessionRowsList.mockResolvedValue({ sessions: [], archivedCount: 0 });
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.sessionGone });
    expect(start).not.toHaveBeenCalled();
  });

  it("cannot resume a Session with no harness session id", async () => {
    sessionRowsList.mockResolvedValue({ sessions: [row({ claudeSessionId: null })], archivedCount: 0 });
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.noSessionId });
    expect(start).not.toHaveBeenCalled();
  });

  it("cannot resume a Session that never ran (`ready`): the harness would be given a conversation that does not exist", async () => {
    sessionRowsList.mockResolvedValue({ sessions: [row({ status: "ready" })], archivedCount: 0 });
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.noResume });
  });

  it("cannot resume a Session of another harness than the Agent's", async () => {
    sessionRowsList.mockResolvedValue({ sessions: [row({ agent: "codex" })], archivedCount: 0 });
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.otherHarness });
  });

  it("types the pointer into a Session whose harness is still running, as a message and then the return", async () => {
    findBySession.mockResolvedValue({ ptyId: "pty-1" });
    const h = handle();
    attach.mockResolvedValue(h);
    const out = await resumeSessionOnCore(request(), 1);

    expect(out.kind).toBe("sent");
    expect(attach).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "row-1" }));
    expect(h.send.mock.calls.map((c) => c[0])).toEqual([POINTER, "\r"]);
    expect(start).not.toHaveBeenCalled();
  });

  it("a running Session that does not take the message is reported still live, and let go of", async () => {
    findBySession.mockResolvedValue({ ptyId: "pty-1" });
    const h = handle();
    h.send.mockResolvedValue(false);
    attach.mockResolvedValue(h);
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.sendRefused, stillLive: true });
    expect(h.dispose).toHaveBeenCalled();
  });

  it("a running Session someone holds the lock on: the send is refused, still live", async () => {
    findBySession.mockResolvedValue({ ptyId: "pty-1" });
    const h = handle();
    h.send.mockRejectedValue(new Error("session-locked"));
    attach.mockResolvedValue(h);
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.sendRefused, stillLive: true });
    expect(h.dispose).toHaveBeenCalled();
  });

  it("a Core with no live link throws, so the Task waits for it as for any start", async () => {
    link.current = false;
    await expect(resumeSessionOnCore(request(), 1)).rejects.toThrow(/no live link to this Core/);
  });

  it("a full Core throws, so the Task waits for a slot", async () => {
    start.mockRejectedValue(new Error("pty:spawn refused: this Core already runs 8 live harness PTYs (the limit)."));
    await expect(resumeSessionOnCore(request(), 1)).rejects.toThrow(/already runs 8 live harness PTYs/);
  });

  it("a resume the Core refuses for another reason is `cannot`, with the Core's words", async () => {
    start.mockRejectedValue(new Error("pty:spawn refused: command not allowed"));
    const out = await resumeSessionOnCore(request(), 1);
    expect(out).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.resumeRefused("pty:spawn refused: command not allowed") });
  });

  it("a harness that exits at once is `cannot`, and the handle is let go of", async () => {
    const h = handle();
    h.onExit.mockImplementation(((cb: (e: { exitCode: number }) => void) => {
      queueMicrotask(() => cb({ exitCode: 1 }));
      return () => {};
    }) as never);
    start.mockResolvedValue(h);
    expect(await resumeSessionOnCore(request(), 1_000)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.exitedAtOnce });
    expect(h.dispose).toHaveBeenCalled();
  });

  it("a Core that cannot list its Sessions gives no answer", async () => {
    sessionRowsList.mockRejectedValue(new Error("timeout"));
    expect(await resumeSessionOnCore(request(), 1)).toEqual({ kind: "cannot", refusal: RESUME_REFUSALS.noAnswer });
  });
});
