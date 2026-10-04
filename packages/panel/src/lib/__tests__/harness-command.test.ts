import { describe, expect, it } from "vitest";
import type { Session } from "~/db/schema";
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

const baseSession = {
  id: "session-1",
  title: "Session",
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
} satisfies Omit<Session, "agent">;

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
  it("uses Claude session-id for ready sessions", () => {
    const session = { ...baseSession, agent: "claude-code" } satisfies Session;
    expect(buildHarnessLaunchCommand(session, session.claudeSessionId!, "new")).toBe(
      "claude --session-id 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions",
    );
  });

  it("passes a configured Claude model", () => {
    const session = { ...baseSession, agent: "claude-code" } satisfies Session;
    expect(
      buildHarnessLaunchCommand(session, session.claudeSessionId!, "new", { model: "sonnet" }),
    ).toBe("claude --session-id 00000000-0000-4000-8000-000000000000 --model sonnet --dangerously-skip-permissions");
  });

  it("uses Cursor resume for every launch", () => {
    const session = { ...baseSession, agent: "cursor-cli" } satisfies Session;
    expect(buildHarnessLaunchCommand(session, session.claudeSessionId!, "resume")).toBe(
      "cursor-agent --resume 00000000-0000-4000-8000-000000000000 --force",
    );
  });

  it("starts OpenCode without a session id until one is captured", () => {
    const session = {
      ...baseSession,
      agent: "opencode",
      claudeSessionId: null,
    } satisfies Session;
    expect(buildHarnessLaunchCommand(session, "", "new")).toBe("opencode");
  });

  it("resumes OpenCode only with a captured ses_* session id", () => {
    const session = {
      ...baseSession,
      agent: "opencode",
      status: "running",
      claudeSessionId: OPENCODE_SESSION_ID,
    } satisfies Session;
    expect(buildHarnessLaunchCommand(session, OPENCODE_SESSION_ID, "resume")).toBe(
      `opencode --session ${OPENCODE_SESSION_ID}`,
    );
  });

  it("starts Pi without a session id until one is captured", () => {
    const session = {
      ...baseSession,
      agent: "pi",
      claudeSessionId: null,
    } satisfies Session;
    expect(buildHarnessLaunchCommand(session, "", "new")).toBe("pi");
  });

  it("resumes Pi with a captured session UUID", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const session = {
      ...baseSession,
      agent: "pi",
      status: "running",
      claudeSessionId: sessionId,
    } satisfies Session;
    expect(buildHarnessLaunchCommand(session, sessionId, "resume")).toBe(
      `pi --session ${sessionId}`,
    );
  });

  it("passes a model on a fresh Pi launch", () => {
    const session = {
      ...baseSession,
      agent: "pi",
      claudeSessionId: null,
    } satisfies Session;
    expect(buildHarnessLaunchCommand(session, "", "new", { model: "anthropic/claude-sonnet-4-5" })).toBe(
      "pi --model anthropic/claude-sonnet-4-5",
    );
  });
});

describe("harnessLaunchMode", () => {
  it("resumes Codex only after a session id is known and the session has started", () => {
    expect(
      harnessLaunchMode({ ...baseSession, agent: "codex", status: "ready" } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "codex",
        status: "running",
        claudeSessionId: null,
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "codex",
        status: "running",
      } satisfies Session),
    ).toBe("resume");
  });

  it("starts Claude Code fresh until a session id is captured (issue 387)", () => {
    // The bare Session issue 387 settles: never prompted, so no hook ever
    // captured an id for it, and the settle moved it off `ready`. Resuming
    // would be `claude --resume` into a conversation that never existed.
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "claude-code",
        status: "disconnected",
        claudeSessionId: null,
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "claude-code",
        status: "finished",
        claudeSessionId: null,
      } satisfies Session),
    ).toBe("new");
    // A Session that did have a turn still resumes off its captured id, and a
    // fresh one still starts new — neither half of the gate moved.
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "claude-code",
        status: "disconnected",
      } satisfies Session),
    ).toBe("resume");
    expect(
      harnessLaunchMode({ ...baseSession, agent: "claude-code", status: "ready" } satisfies Session),
    ).toBe("new");
  });

  it("starts OpenCode fresh until a ses_* id is captured", () => {
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "opencode",
        status: "ready",
        claudeSessionId: null,
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "opencode",
        status: "ready",
        claudeSessionId: "00000000-0000-4000-8000-000000000000",
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "opencode",
        status: "running",
        claudeSessionId: OPENCODE_SESSION_ID,
      } satisfies Session),
    ).toBe("resume");
  });

  it("resumes Pi only after a session UUID is captured and the session has started (ADO #4986)", () => {
    const piSession = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "pi",
        status: "ready",
        claudeSessionId: null,
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "pi",
        status: "running",
        claudeSessionId: null,
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "pi",
        status: "ready",
        claudeSessionId: piSession,
      } satisfies Session),
    ).toBe("new");
    expect(
      harnessLaunchMode({
        ...baseSession,
        agent: "pi",
        status: "finished",
        claudeSessionId: piSession,
      } satisfies Session),
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
    expect(
      isHarnessResumeCommand("pi", "pi --session a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    ).toBe(true);
    expect(isHarnessResumeCommand("pi", "pi")).toBe(false);
  });
});

describe("buildFreshHarnessLaunchCommand", () => {
  it("falls back to a fresh Codex session without resume", () => {
    const session = {
      ...baseSession,
      agent: "codex",
      status: "running",
    } satisfies Session;
    expect(buildFreshHarnessLaunchCommand(session, "fresh-id")).toBe("codex --enable hooks --yolo");
  });

  it("falls back to a fresh OpenCode session without session flags", () => {
    const session = {
      ...baseSession,
      agent: "opencode",
      status: "running",
      claudeSessionId: OPENCODE_SESSION_ID,
    } satisfies Session;
    expect(buildFreshHarnessLaunchCommand(session, OPENCODE_SESSION_ID)).toBe("opencode");
  });

  it("falls back to a fresh Pi session without --session (ADO #4986)", () => {
    const session = {
      ...baseSession,
      agent: "pi",
      status: "running",
      claudeSessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    } satisfies Session;
    expect(buildFreshHarnessLaunchCommand(session, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "pi",
    );
  });
});
