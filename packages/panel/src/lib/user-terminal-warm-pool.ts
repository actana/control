import type { UserTerminal } from "~/db/schema";
import type { ScopedProject } from "~/lib/scoped-project";
import { newClientId } from "@actana/shared/client-id";
import { getCorePtyBridge } from "~/lib/panel-bridge";
import { prefetchTerminalModules } from "~/lib/prefetch-terminal-modules";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from "~/shared/pty-size";


export type UserTerminalWarmSlot = {
  signature: string;
  /** The Core the warm PTY is running on. */
  coreId: string;
  clientTerminalId: string;
  ptyId: string;
  draftTerminal: UserTerminal;
  cwd: string;
};

let warmSlot: UserTerminalWarmSlot | null = null;
let warmPreparing: Promise<UserTerminalWarmSlot | null> | null = null;
let warmGeneration = 0;

/**
 * Warm pool only covers interactive shell terminals (no launch startCommand).
 * The Core is part of the signature: the same path on two machines is two
 * different shells, and handing one out for the other would drop the operator
 * into the wrong filesystem.
 */
export function userTerminalWarmSignature(coreId: string, cwd: string): string {
  return `${coreId}\u0000${cwd}`;
}

function buildDraftTerminal(
  clientTerminalId: string,
  project: ScopedProject,
  cwd: string,
): UserTerminal {
  const now = Date.now();
  return {
    id: clientTerminalId,
    projectId: project.id,
    name: "Terminal",
    cwd,
    startCommand: null,
    position: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function discardUserTerminalWarmSlot(): Promise<void> {
  // Bump the generation so any in-flight prepare is invalidated, then tear down.
  warmGeneration += 1;
  await discardUserTerminalWarmSlotQuiet();
}

async function discardUserTerminalWarmSlotQuiet(): Promise<void> {
  warmPreparing = null;
  const slot = warmSlot;
  warmSlot = null;
  if (slot) {
    await getCorePtyBridge(slot.coreId)?.kill(slot.ptyId).catch(() => undefined);
  }
}

export function peekUserTerminalWarmSlot(
  coreId: string | null | undefined,
  cwd: string,
): UserTerminalWarmSlot | null {
  const slot = warmSlot;
  if (!slot || !coreId) return null;
  return slot.signature === userTerminalWarmSignature(coreId, cwd) ? slot : null;
}

export function takeUserTerminalWarmSlot(
  coreId: string | null | undefined,
  cwd: string,
): UserTerminalWarmSlot | null {
  const slot = peekUserTerminalWarmSlot(coreId, cwd);
  if (!slot) return null;
  warmSlot = null;
  return slot;
}

export async function prepareUserTerminalWarmSlot(input: {
  project: ScopedProject;
  coreId: string | null | undefined;
  cwd: string;
}): Promise<UserTerminalWarmSlot | null> {
  const { coreId } = input;
  const pty = getCorePtyBridge(coreId);
  if (!pty || !coreId || !input.cwd) return null;

  const signature = userTerminalWarmSignature(coreId, input.cwd);
  if (warmSlot?.signature === signature) return warmSlot;

  warmGeneration += 1;
  const generation = warmGeneration;
  warmPreparing = (async () => {
    await discardUserTerminalWarmSlotQuiet();
    if (generation !== warmGeneration) return null;

    void prefetchTerminalModules();

    const clientTerminalId = newClientId("ut");
    const draftTerminal = buildDraftTerminal(clientTerminalId, input.project, input.cwd);
    const ptySize = { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };

    try {
      const { ptyId } = await pty.spawn({
        taskId: clientTerminalId,
        cwd: input.cwd,
        command: "",
        cols: ptySize.cols,
        rows: ptySize.rows,
        shell: true,
      });
      if (generation !== warmGeneration) {
        await pty.kill(ptyId).catch(() => undefined);
        return null;
      }

      const slot: UserTerminalWarmSlot = {
        signature,
        coreId,
        clientTerminalId,
        ptyId,
        draftTerminal,
        cwd: input.cwd,
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

export function replenishUserTerminalWarmSlot(input: {
  project: ScopedProject;
  coreId: string | null | undefined;
  cwd: string;
}) {
  void prepareUserTerminalWarmSlot(input);
}
