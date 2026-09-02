import type { Task } from "~/db/schema";
import type { Harness } from "@actana/shared/domain";
import type { AiModelId } from "@actana/shared/ai-runtime-defaults";
import { harnessLaunchesWithSkipPermissions } from "@actana/shared/harnesses";
import { buildClaudeCommand, newSessionId } from "./claude-command";

export { newSessionId };

export type HarnessLaunchMode = "new" | "resume";

export function isOpencodeSessionId(sessionId: string): boolean {
  return sessionId.startsWith("ses");
}

export function harnessUsesPersistedSession(agent: Harness): boolean {
  return (
    agent === "claude-code" ||
    agent === "codex" ||
    agent === "cursor-cli" ||
    agent === "opencode"
  );
}

export function harnessLaunchMode(task: Task): HarnessLaunchMode {
  if (task.agent === "claude-code") {
    // Both halves are load-bearing, the way they are for codex below.
    //
    // `status !== "ready"` alone read as "this Session has had a conversation",
    // which was true only while `ready` was a one-way status. Issue 387 moves a
    // Session off `ready` when its PTY dies — so a bare Session that was never
    // prompted, and therefore never had a session id captured for it, now
    // reaches this branch reading `disconnected`. Resuming it means
    // `claude --resume <id>` against a conversation that never existed: the
    // spawn dies on the spot, and the operator is shown the retry notice.
    //
    // A Session with no captured id has nothing to resume INTO, whatever its
    // status says, so it starts new.
    return task.claudeSessionId && task.status !== "ready" ? "resume" : "new";
  }
  if (task.agent === "cursor-cli") {
    return "resume";
  }
  if (task.agent === "opencode") {
    return task.claudeSessionId &&
      isOpencodeSessionId(task.claudeSessionId) &&
      task.status !== "ready"
      ? "resume"
      : "new";
  }
  if (task.agent === "codex") {
    return task.claudeSessionId && task.status !== "ready" ? "resume" : "new";
  }
  return "new";
}

export function isHarnessResumeCommand(agent: Harness, command: string): boolean {
  if (agent === "claude-code" || agent === "cursor-cli") {
    return command.includes("--resume");
  }
  if (agent === "opencode") {
    return command.includes("--session");
  }
  if (agent === "codex") {
    return /\bcodex(?:\s+\S+)*\s+resume(?:\s|$)/.test(command);
  }
  return false;
}

export function buildCursorCommand(opts: {
  sessionId: string;
  skipPermissions: boolean;
  model?: AiModelId | null;
}): string {
  const parts = ["cursor-agent", "--resume", opts.sessionId];
  if (opts.model) parts.push("--model", opts.model);
  if (opts.skipPermissions) parts.push("--force");
  return parts.join(" ");
}

export function buildOpencodeCommand(opts: {
  mode: HarnessLaunchMode;
  sessionId?: string | null;
  model?: AiModelId | null;
}): string {
  const parts = ["opencode"];
  if (opts.model) parts.push("--model", opts.model);
  if (
    opts.mode === "resume" &&
    opts.sessionId &&
    isOpencodeSessionId(opts.sessionId)
  ) {
    parts.push("--session", opts.sessionId);
    return parts.join(" ");
  }
  return parts.join(" ");
}

export function buildCodexCommand(opts: {
  mode: HarnessLaunchMode;
  sessionId?: string | null;
  skipPermissions: boolean;
  model?: AiModelId | null;
}): string {
  const parts = ["codex"];
  if (opts.mode === "resume" && opts.sessionId) {
    parts.push("resume", opts.sessionId);
  }
  if (opts.model) parts.push("--model", opts.model);
  parts.push("--enable", "hooks");
  if (opts.skipPermissions) parts.push("--yolo");
  return parts.join(" ");
}

export function buildHarnessLaunchCommand(
  task: Task,
  sessionId: string,
  mode: HarnessLaunchMode,
  opts: { model?: AiModelId | null } = {},
): string {
  // Auto-mode is the default for every session (issue 22) — no task column and
  // no user choice feeds this. The spawn descriptor derives the same value from
  // the same helper; they must not diverge or the spawn policy rejects the
  // command this builds. See `harnessLaunchesWithSkipPermissions`.
  const skipPermissions = harnessLaunchesWithSkipPermissions(task.agent);
  const model = opts.model ?? null;
  switch (task.agent) {
    case "claude-code":
      return buildClaudeCommand({
        kind: mode,
        sessionId,
        skipPermissions,
        bareSession: !!task.claudeBareSession,
        model,
      });
    case "cursor-cli":
      return buildCursorCommand({ sessionId, skipPermissions, model });
    case "opencode":
      return buildOpencodeCommand({ mode, sessionId, model });
    case "codex":
      return buildCodexCommand({
        mode,
        sessionId,
        skipPermissions,
        model,
      });
    default:
      throw new Error(`unsupported agent for session launch: ${task.agent}`);
  }
}

export function buildFreshHarnessLaunchCommand(
  task: Task,
  sessionId: string,
  opts: { model?: AiModelId | null } = {},
): string {
  const model = opts.model ?? null;
  switch (task.agent) {
    case "claude-code":
      return buildHarnessLaunchCommand(task, sessionId, "new", { model });
    case "cursor-cli":
      return buildCursorCommand({
        sessionId,
        skipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
        model,
      });
    case "opencode":
      return buildOpencodeCommand({ mode: "new", model });
    case "codex":
      return buildCodexCommand({
        mode: "new",
        skipPermissions: harnessLaunchesWithSkipPermissions(task.agent),
        model,
      });
    default:
      throw new Error(`unsupported agent for fresh session launch: ${task.agent}`);
  }
}
