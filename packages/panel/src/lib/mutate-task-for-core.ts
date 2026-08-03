import type {
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";
import { getPanelBridge } from "~/lib/panel-bridge";
import { api } from "~/lib/api";

/**
 * Route a task mutation to whichever Core owns the row (ADR 0005).
 *
 * For a Core-owned row there is one transport: the mutation is a frame on this
 * tab's panel link, addressed to a `coreId`, and the Harness that answers is
 * the only process that writes its own database (ADR 0004). Callers name the
 * Core; they never learn how it is reached.
 *
 * Throws on transport failure or a Harness-side error frame so the caller can
 * surface it in the picker/dialog. Returns `null` when the mutation targeted a
 * missing row.
 *
 * A null `coreId` names a row in the Panel's own database — the last rows not
 * owned by a Harness — and is written over the Panel's HTTP API instead. That
 * arm disappears with those rows.
 */
export async function mutateTaskForCore(
  coreId: string | null | undefined,
  mutation: CoreLinkTaskMutation,
): Promise<CoreLinkTaskSnapshot | null> {
  if (!coreId) return mutatePanelLocalTask(mutation);
  const bridge = getPanelBridge();
  if (!bridge) throw new Error("Not connected to the Panel — cannot mutate task");
  return bridge.mutateTask(coreId, mutation);
}

async function mutatePanelLocalTask(
  mutation: CoreLinkTaskMutation,
): Promise<CoreLinkTaskSnapshot | null> {
  if (mutation.op !== "update") {
    throw new Error(`cannot ${mutation.op} a task that no Core owns`);
  }
  const { task } = await api.updateTask(mutation.taskId, {
    ...(mutation.title !== undefined ? { title: mutation.title } : {}),
    ...(mutation.pinned !== undefined ? { pinned: mutation.pinned } : {}),
  });
  if (!task) return null;
  return {
    taskId: task.id,
    projectId: task.projectId,
    title: task.title,
    icon: task.icon,
    agent: task.agent,
    status: task.status,
    archived: task.archived,
    pinned: task.pinned,
    updatedAt: task.updatedAt,
  };
}
