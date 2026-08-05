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
 * tab's panel link, addressed to a `coreId`, and the Core that answers is
 * the only process that writes its own database (ADR 0004). Callers name the
 * Core; they never learn how it is reached.
 *
 * Throws on transport failure or a Core-side error frame so the caller can
 * surface it in the picker/dialog. Returns `null` when the mutation targeted a
 * missing row — and, on a Panel-owned `delete`, always: that endpoint answers
 * with no body, so a deleted row and a missing one look the same from here.
 *
 * A null `coreId` names a row in the Panel's own database — the last rows not
 * owned by a Core — and is written over the Panel's HTTP API instead. That
 * arm disappears with those rows. It understands `delete`, plus `title`,
 * `pinned`, and `archived` on an `update`; anything else on the patch is
 * dropped.
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
  if (mutation.op === "delete") {
    // The DELETE route answers 204 with no body, so there is no row to echo
    // back the way the Core's delete does. Every delete caller awaits the
    // promise and ignores the value, so null is the honest answer rather than
    // a fabricated snapshot or an extra GET to fetch a row about to vanish.
    await api.deleteTask(mutation.taskId);
    return null;
  }
  if (mutation.op !== "update") {
    throw new Error(`cannot ${mutation.op} a task that no Core owns`);
  }
  const patch = {
    ...(mutation.title !== undefined ? { title: mutation.title } : {}),
    ...(mutation.pinned !== undefined ? { pinned: mutation.pinned } : {}),
  };
  // `archived` is not a column the PATCH route accepts: archive/restore are
  // their own endpoints because flipping the flag also clears the pending
  // question and emits `task:archived`/`task:restored`. Apply the plain
  // columns first, then flip archived, so the returned snapshot carries both.
  // An archive-only patch skips the PATCH round trip; an empty patch with no
  // archived flag still goes through it, so a no-op mutation returns the row.
  let task =
    Object.keys(patch).length > 0 || mutation.archived === undefined
      ? (await api.updateTask(mutation.taskId, patch)).task
      : null;
  if (mutation.archived !== undefined) {
    const flipped = mutation.archived
      ? await api.archiveTask(mutation.taskId)
      : await api.restoreTask(mutation.taskId);
    task = flipped.task;
  }
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
