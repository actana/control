import type { Task } from "~/db/schema";
import type { TaskAgent } from "@actana/shared/domain";
import type { ScopedProject } from "~/lib/scoped-project";
import { agentSupportsSkipPermissions } from "@actana/shared/agents";
import { newClientId } from "@actana/shared/client-id";
import { newSessionId } from "~/lib/agent-command";
import { buildOptimisticTask } from "~/lib/optimistic-task";
import { commandForTask } from "~/lib/terminal-store";
import { getCorePtyBridge } from "~/lib/panel-bridge";
import { api } from "~/lib/api";
import { getTerminalColorScheme } from "~/lib/terminal-options";
import { TITLE_WAITING } from "~/lib/task-sentinels";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from "~/shared/pty-size";

export type SessionCreatePayload = {
  agent: TaskAgent;
  skipPermissions: boolean;
  bareSession: boolean;
};

export type SessionWarmSlot = {
  signature: string;
  /** The Core the warm PTY is running on. */
  coreId: string;
  clientTaskId: string;
  ptyId: string;
  draftTask: Task;
  payload: SessionCreatePayload;
};

let warmSlot: SessionWarmSlot | null = null;
let warmPreparing: Promise<SessionWarmSlot | null> | null = null;
let warmGeneration = 0;

/**
 * The Core is part of the signature: a warm agent is a process on one specific
 * machine, and the same project path on two Cores is two different checkouts.
 */
export function sessionCreateSignature(
  coreId: string,
  payload: SessionCreatePayload,
  cwd: string,
): string {
  return [
    coreId,
    cwd,
    payload.agent,
    payload.skipPermissions ? "1" : "0",
    payload.bareSession ? "1" : "0",
    // A warm slot pre-spawns the agent PTY with the theme captured at prepare
    // time (COLORFGBG). Include the theme so switching light/dark
    // invalidates a slot warmed under the old theme — otherwise a new session
    // would claim a stale-theme agent. On claim, takeSessionWarmSlot recomputes
    // this fresh, so a theme mismatch falls through to a cold spawn.
    getTerminalColorScheme(),
  ].join("\0");
}

function buildDraftTask(
  clientTaskId: string,
  project: ScopedProject,
  payload: SessionCreatePayload,
  claudeSessionId: string | null,
): Task {
  return buildOptimisticTask({
    id: clientTaskId,
    projectId: project.id,
    agent: payload.agent,
    claudeSessionId,
    claudeSkipPermissions: agentSupportsSkipPermissions(payload.agent)
      ? payload.skipPermissions
      : false,
    claudeBareSession: payload.agent === "claude-code" ? payload.bareSession : false,
  });
}

export function defaultSessionPayload(project: {
  rememberAgentSettings?: boolean;
  savedAgent?: TaskAgent | null;
  savedSkipPermissions?: boolean;
  savedBareSession?: boolean;
}): SessionCreatePayload {
  const agent = project.savedAgent ?? "claude-code";
  return {
    agent,
    skipPermissions: !!project.savedSkipPermissions,
    bareSession:
      project.rememberAgentSettings && project.savedAgent === "claude-code"
        ? !!project.savedBareSession
        : false,
  };
}

export async function discardSessionWarmSlot(): Promise<void> {
  // Bump the generation so any in-flight prepare is invalidated, then tear down.
  warmGeneration += 1;
  await discardSessionWarmSlotQuiet();
}

async function discardSessionWarmSlotQuiet(): Promise<void> {
  warmPreparing = null;
  const slot = warmSlot;
  warmSlot = null;
  if (slot) {
    await getCorePtyBridge(slot.coreId)?.kill(slot.ptyId).catch(() => undefined);
  }
}

export function peekSessionWarmSlot(
  coreId: string | null | undefined,
  payload: SessionCreatePayload,
  cwd: string,
): SessionWarmSlot | null {
  const slot = warmSlot;
  if (!slot || !coreId) return null;
  return slot.signature === sessionCreateSignature(coreId, payload, cwd) ? slot : null;
}

export function takeSessionWarmSlot(
  coreId: string | null | undefined,
  payload: SessionCreatePayload,
  cwd: string,
): SessionWarmSlot | null {
  const slot = peekSessionWarmSlot(coreId, payload, cwd);
  if (!slot) return null;
  warmSlot = null;
  return slot;
}

export async function prepareSessionWarmSlot(input: {
  project: ScopedProject;
  coreId: string | null | undefined;
  payload: SessionCreatePayload;
}): Promise<SessionWarmSlot | null> {
  const { coreId } = input;
  const pty = getCorePtyBridge(coreId);
  if (!pty || !coreId || !input.project.path) return null;

  const signature = sessionCreateSignature(coreId, input.payload, input.project.path);
  if (warmSlot?.signature === signature) return warmSlot;

  warmGeneration += 1;
  const generation = warmGeneration;
  warmPreparing = (async () => {
    await discardSessionWarmSlotQuiet();
    if (generation !== warmGeneration) return null;

    const usesPersistedSession =
      input.payload.agent === "claude-code" || input.payload.agent === "cursor-cli";
    const claudeSessionId = usesPersistedSession ? newSessionId() : null;
    const clientTaskId = newClientId("t");
    const draftTask = buildDraftTask(
      clientTaskId,
      input.project,
      input.payload,
      claudeSessionId,
    );

    try {
      const { ptyId } = await pty.spawn({
        taskId: clientTaskId,
        cwd: input.project.path,
        command: commandForTask(draftTask),
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
        agent: draftTask.agent,
        dangerouslySkipPermissions: draftTask.claudeSkipPermissions,
        missionControlTheme: getTerminalColorScheme(),
      });
      if (generation !== warmGeneration) {
        await pty.kill(ptyId).catch(() => undefined);
        return null;
      }

      const slot: SessionWarmSlot = {
        signature,
        coreId,
        clientTaskId,
        ptyId,
        draftTask,
        payload: input.payload,
      };
      warmSlot = slot;
      return slot;
    } catch {
      return null;
    } finally {
      warmPreparing = null;
    }
  })();

  return warmPreparing;
}

export function replenishSessionWarmSlot(input: {
  project: ScopedProject;
  coreId: string | null | undefined;
  payload: SessionCreatePayload;
}) {
  void prepareSessionWarmSlot(input);
}

/** Persist a claimed warm slot task row using the ids the PTY was already started with. */
export async function persistWarmSlotTask(
  projectId: string,
  slot: SessionWarmSlot,
): Promise<Task> {
  const { task } = await api.createTaskInternal(projectId, {
    id: slot.clientTaskId,
    title: TITLE_WAITING,
    agent: slot.payload.agent,
    claudeSessionId: slot.draftTask.claudeSessionId,
    claudeBareSession:
      slot.payload.agent === "claude-code" ? slot.payload.bareSession : undefined,
    claudeSkipPermissions: agentSupportsSkipPermissions(slot.payload.agent)
      ? slot.payload.skipPermissions
      : undefined,
  });
  return task;
}
