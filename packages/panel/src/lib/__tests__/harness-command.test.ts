import { describe, expect, it } from "vitest";
import type { Task } from "~/db/schema";
import {
  harnessLaunchMode,
  buildHarnessLaunchCommand,
  buildCodexCommand,
  buildCursorCommand,
  buildFreshHarnessLaunchCommand,
  buildOpencodeCommand,
  isHarnessResumeCommand,
  isOpencodeSessionId,
} from "../harness-command";

const baseTask = {
  id: "task-1",
  projectId: "project-1",
  title: "Task",
  titleManuallySet: false,
  icon: null,
  status: "ready",
  branch: "main",
  preview: "",
  lines: 0,
  archived: false,
  pinned: false,
  claudeSessionId: "00000000-0000-4000-8000-000000000000",
  claudeSkipPermissions: false,
  claudeBareSession: false,
  createdAt: 1,
  updatedAt: 1,
} satisfies Omit<Task, "agent">;

const OPENCODE_SESSION_ID = "ses_3cf7dd8d4ffeUPfENpVxfFojZ2";

describe("isOpencodeSessionId", () => {
  it("accepts OpenCode session ids", () => {
    expect(isOpencodeSessionId(OPENCODE_SESSION_ID)).toBe(true);
  });

  it("rejects Mission Control UUIDs and other foreign ids", () => {
    expect(isOpencodeSessionId("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isOpencodeSessionId("019d7a0f-432a-7fa1-a821-b7841f983967")).toBe(false);
  });
});

describe("buildCursorCommand", () => {
  it("resumes a persisted Cursor chat", () => {
    expect(
      buildCursorCommand({
        sessionId: "00000000-0000-4000-8000-000000000000",
        skipPermissions: false,
      }),
    ).toBe("cursor-agent --resume 00000000-0000-4000-8000-000000000000");
  });

  it("passes force mode when skip permissions is enabled", () => {
    expect(
      buildCursorCommand({
        sessionId: "00000000-0000-4000-8000-000000000000",
        skipPermissions: true,
      }),
    ).toBe("cursor-agent --resume 00000000-0000-4000-8000-000000000000 --force");
  });

  it("passes a configured model", () => {
    expect(
      buildCursorCommand({
        sessionId: "00000000-0000-4000-8000-000000000000",
        skipPermissions: false,
        model: "gpt-5.3-codex",
      }),
    ).toBe("cursor-agent --resume 00000000-0000-4000-8000-000000000000 --model gpt-5.3-codex");
  });
});

describe("buildOpencodeCommand", () => {
  it("starts a fresh OpenCode TUI without session flags", () => {
    expect(buildOpencodeCommand({ mode: "new" })).toBe("opencode");
  });

  it("ignores foreign session ids on a new launch", () => {
    expect(
      buildOpencodeCommand({
        mode: "new",
        sessionId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBe("opencode");
  });

  it("passes a configured model on fresh launches", () => {
    expect(
      buildOpencodeCommand({
        mode: "new",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toBe("opencode --model anthropic/claude-sonnet-4-5");
  });

  it("resumes only with a real OpenCode session id", () => {
    expect(
      buildOpencodeCommand({
        mode: "resume",
        sessionId: OPENCODE_SESSION_ID,
      }),
    ).toBe(`opencode --session ${OPENCODE_SESSION_ID}`);
  });

  it("falls back to a fresh launch when resume lacks a valid OpenCode session id", () => {
    expect(
      buildOpencodeCommand({
        mode: "resume",
        sessionId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBe("opencode");
  });
});

describe("buildCodexCommand", () => {
  it("starts a new Codex session with hooks enabled", () => {
    expect(
      buildCodexCommand({
        mode: "new",
        skipPermissions: false,
      }),
    ).toBe("codex --enable hooks");
  });

  it("passes a configured model before hook flags", () => {
    expect(
      buildCodexCommand({
        mode: "new",
        skipPermissions: false,
        model: "gpt-5.3-codex",
      }),
    ).toBe("codex --model gpt-5.3-codex --enable hooks");
  });

  it("resumes a persisted Codex session with hooks enabled", () => {
    expect(
      buildCodexCommand({
        mode: "resume",
        sessionId: "019d7a0f-432a-7fa1-a821-b7841f983967",
        skipPermissions: true,
      }),
    ).toBe("codex resume 019d7a0f-432a-7fa1-a821-b7841f983967 --enable hooks --yolo");
  });
});

describe("buildHarnessLaunchCommand", () => {
  it("uses Claude session-id for ready tasks", () => {
    const task = { ...baseTask, agent: "claude-code" } satisfies Task;
    expect(buildHarnessLaunchCommand(task, task.claudeSessionId!, "new")).toBe(
      "claude --session-id 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions",
    );
  });

  it("passes a configured Claude model", () => {
    const task = { ...baseTask, agent: "claude-code" } satisfies Task;
    expect(
      buildHarnessLaunchCommand(task, task.claudeSessionId!, "new", { model: "sonnet" }),
    ).toBe("claude --session-id 00000000-0000-4000-8000-000000000000 --model sonnet --dangerously-skip-permissions");
  });

  it("uses Cursor resume for every launch", () => {
    const task = { ...baseTask, agent: "cursor-cli" } satisfies Task;
    expect(buildHarnessLaunchCommand(task, task.claudeSessionId!, "resume")).toBe(
      "cursor-agent --resume 00000000-0000-4000-8000-000000000000 --force",
    );
  });

  it("starts OpenCode without a session id until one is captured", () => {
    const task = {
      ...baseTask,
      agent: "opencode",
      claudeSessionId: null,
    } satisfies Task;
    expect(buildHarnessLaunchCommand(task, "", "new")).toBe("opencode");
  });

  it("resumes OpenCode only with a captured ses_* session id", () => {
    const task = {
      ...baseTask,
      agent: "opencode",
      status: "running",
      claudeSessionId: OPENCODE_SESSION_ID,
    } satisfies Task;
    expect(buildHarnessLaunchCommand(task, OPENCODE_SESSION_ID, "resume")).toBe(
      `opencode --session ${OPENCODE_SESSION_ID}`,
    );
  });
});

describe("harnessLaunchMode", () => {
  it("resumes Codex only after a session id is known and the task has started", () => {
    expect(
      harnessLaunchMode({ ...baseTask, agent: "codex", status: "ready" } satisfies Task),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseTask,
        agent: "codex",
        status: "running",
        claudeSessionId: null,
      } satisfies Task),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseTask,
        agent: "codex",
        status: "running",
      } satisfies Task),
    ).toBe("resume");
  });

  it("starts OpenCode fresh until a ses_* id is captured", () => {
    expect(
      harnessLaunchMode({
        ...baseTask,
        agent: "opencode",
        status: "ready",
        claudeSessionId: null,
      } satisfies Task),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseTask,
        agent: "opencode",
        status: "ready",
        claudeSessionId: "00000000-0000-4000-8000-000000000000",
      } satisfies Task),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseTask,
        agent: "opencode",
        status: "running",
        claudeSessionId: OPENCODE_SESSION_ID,
      } satisfies Task),
    ).toBe("resume");
  });
});

describe("isHarnessResumeCommand", () => {
  it("detects resume launches for each supported agent", () => {
    expect(
      isHarnessResumeCommand(
        "claude-code",
        "claude --resume 00000000-0000-4000-8000-000000000000",
      ),
    ).toBe(true);
    expect(isHarnessResumeCommand("cursor-cli", "cursor-agent --resume abc")).toBe(true);
    expect(
      isHarnessResumeCommand("opencode", `opencode --session ${OPENCODE_SESSION_ID}`),
    ).toBe(true);
    expect(isHarnessResumeCommand("opencode", "opencode")).toBe(false);
    expect(
      isHarnessResumeCommand(
        "codex",
        "codex resume 019d7a0f-432a-7fa1-a821-b7841f983967 --enable hooks",
      ),
    ).toBe(true);
    expect(isHarnessResumeCommand("codex", "codex --enable hooks --yolo")).toBe(false);
  });
});

describe("buildFreshHarnessLaunchCommand", () => {
  it("falls back to a fresh Codex session without resume", () => {
    const task = {
      ...baseTask,
      agent: "codex",
      status: "running",
    } satisfies Task;
    expect(buildFreshHarnessLaunchCommand(task, "fresh-id")).toBe("codex --enable hooks --yolo");
  });

  it("falls back to a fresh OpenCode session without session flags", () => {
    const task = {
      ...baseTask,
      agent: "opencode",
      status: "running",
      claudeSessionId: OPENCODE_SESSION_ID,
    } satisfies Task;
    expect(buildFreshHarnessLaunchCommand(task, OPENCODE_SESSION_ID)).toBe("opencode");
  });
});
