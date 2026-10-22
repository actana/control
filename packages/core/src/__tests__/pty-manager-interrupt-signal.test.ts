// Issue 392: Esc mid-turn on each harness. The PTY-screen path, through the real
// PtyCore.spawn with a fake pty — which harness's interrupt line may fire the
// synthetic `interrupted` output signal on which PTY.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setImmediate(() => child.emit("close", 0));
      return child;
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: string) => (typeof p === "string" && p.endsWith("/setpriv") ? true : actual.existsSync(p));
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});
vi.mock("@actana/shared/harness-cli-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-resolution")>();
  return {
    ...actual,
    resolveHarnessCommandMeetingVersion: () => ({ binary: "/daemon/looked/up/harness" }),
    resolveHarnessCommandOnPath: () => "/daemon/looked/up/harness",
  };
});
vi.mock("@actana/shared/harness-cli-version", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actana/shared/harness-cli-version")>();
  return { ...actual, checkHarnessCliVersionCached: () => ({ ok: true }) };
});

import { hasClaudeInterruptPrompt, hasCodexInterruptLine, PtyCore } from "../pty-manager";
import { configureCoreHomeOps } from "../core-home-ops-client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

// What codex-cli 0.162.0 wrote to the PTY when Esc interrupted a running turn
// (captured against a local mock Responses server that never finished the
// turn): the history line is painted word by word with cursor-positioning
// escapes in between, so the words are never adjacent bytes.
const CODEX_INTERRUPT_FRAME =
  "\u001B[?2026h\u001B[?25l\u001B[34;2H\u001B[0m\u001B[49m\u001B[K\u001B[21;1H▖ \u001B[21;3HConversation" +
  "\u001B[21;16Hinterrupted\u001B[21;28H-\u001B[21;30Huse\u001B[21;34H/feedback\u001B[21;44Hif" +
  "\u001B[21;47Hsomething\u001B[21;57Hwent\u001B[21;62Hwrong\u001B[?2026l";
const CLAUDE_INTERRUPT_SCREEN = "⎿  Interrupted by user\n> What should Claude do instead?";

function pty() {
  const data: Array<(chunk: string) => void> = [];
  return {
    emit: (chunk: string) => data.forEach((fn) => fn(chunk)),
    proc: {
      pid: 4242,
      onData: (fn: (chunk: string) => void) => void data.push(fn),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      destroy: vi.fn(),
    },
  };
}

let workspaceDir = "";
beforeEach(() => {
  workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "interrupt-signal-")));
  vi.stubEnv("AC_CORE_HOME", workspaceDir);
  vi.stubEnv("AC_CORE_UID", "1000");
  vi.stubEnv("AC_CORE_GID", "1000");
  vi.stubEnv("HOME", "/var/lib/actana");
  configureCoreHomeOps({
    run: async (_spec, input) => {
      const request = JSON.parse(input) as { op: string; cwd?: string; roots?: string[] };
      const result =
        request.op === "spawnPathFacts"
          ? { cwdOk: true, realpaths: Object.fromEntries([request.cwd!, ...request.roots!].map((p) => [p, p])) }
          : request.op === "resolveCommand"
            ? { candidates: ["/bin/harness"] }
            : request.op === "installHarnessHooks"
              ? { installed: false, reportsTurnStart: false, hookTrustBypassEarned: false }
              : null;
      return { status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
    },
  });
});
afterEach(() => {
  configureCoreHomeOps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

async function sessionOn(agent: string, command: string) {
  const fake = pty();
  vi.spyOn(nodePty, "spawn").mockReturnValue(fake.proc as never);
  const signals: Array<{ sessionId: string; signal: string }> = [];
  const core = new PtyCore({
    userDataDir: os.tmpdir(),
    appPath: os.tmpdir(),
    getHookEnv: () => null,
    getProtectedPorts: () => [],
    onSessionOutputSignal: (info: { sessionId: string; signal: string }) => void signals.push(info),
  } as never);
  await core.spawn({ sessionId: "t-392", agent, command } as never);
  return { fake, signals };
}

describe("hasCodexInterruptLine", () => {
  it("reads the line through the cursor-positioning escapes codex paints it with", () => {
    expect(hasCodexInterruptLine(CODEX_INTERRUPT_FRAME)).toBe(true);
    expect(hasCodexInterruptLine("■ Conversation interrupted - use /feedback if something went wrong")).toBe(true);
  });

  it("does not match a screen that merely mentions interruption", () => {
    expect(hasCodexInterruptLine("Working (3s • esc to interrupt)")).toBe(false);
    expect(hasCodexInterruptLine(CLAUDE_INTERRUPT_SCREEN)).toBe(false);
  });
});

describe("hasClaudeInterruptPrompt", () => {
  it("still matches only what it matched before, and not codex's line", () => {
    expect(hasClaudeInterruptPrompt("Interrupted by user")).toBe(true);
    expect(hasClaudeInterruptPrompt("Interrupted · What should Claude do instead?")).toBe(true);
    expect(hasClaudeInterruptPrompt(CODEX_INTERRUPT_FRAME)).toBe(false);
  });
});

describe("the interrupted output signal through PtyCore.spawn (issue 392)", () => {
  it("reports interrupted once when codex prints its interrupt line, however many chunks repeat it", async () => {
    const { fake, signals } = await sessionOn("codex", "codex");
    fake.emit(CODEX_INTERRUPT_FRAME);
    fake.emit(CODEX_INTERRUPT_FRAME);
    expect(signals).toEqual([{ sessionId: "t-392", signal: "interrupted" }]);
  });

  it("re-arms once codex stops showing the line, so the next interrupt reports again", async () => {
    const { fake, signals } = await sessionOn("codex", "codex");
    fake.emit(CODEX_INTERRUPT_FRAME);
    fake.emit("Working (1s • esc to interrupt)");
    fake.emit(CODEX_INTERRUPT_FRAME);
    expect(signals).toHaveLength(2);
  });

  it("does not report interrupted for codex's line in a claude PTY", async () => {
    const { fake, signals } = await sessionOn("claude-code", "claude");
    fake.emit(CODEX_INTERRUPT_FRAME);
    expect(signals).toEqual([]);
  });

  it("does not report interrupted for claude's screen in a codex PTY", async () => {
    const { fake, signals } = await sessionOn("codex", "codex");
    fake.emit(CLAUDE_INTERRUPT_SCREEN);
    expect(signals).toEqual([]);
  });

  it("keeps reporting interrupted once for claude's own screen", async () => {
    const { fake, signals } = await sessionOn("claude-code", "claude");
    fake.emit(CLAUDE_INTERRUPT_SCREEN);
    fake.emit("Interrupted by user");
    expect(signals).toEqual([{ sessionId: "t-392", signal: "interrupted" }]);
  });

  it("reports nothing on opencode, which has neither screen", async () => {
    const { fake, signals } = await sessionOn("opencode", "opencode");
    fake.emit(CODEX_INTERRUPT_FRAME);
    fake.emit(CLAUDE_INTERRUPT_SCREEN);
    expect(signals).toEqual([]);
  });
});
