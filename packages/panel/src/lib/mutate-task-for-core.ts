import type {
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";
import { isTaskStatus } from "@actana/shared/domain";
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
 * arm disappears with those rows. It understands `delete`, plus every field
 * an `update` carries: `title` (with `titleManuallySet`), `pinned`, `icon`,
 * `claudeSessionId`, `status`, and `archived`. Keep it that way — a caller
 * that names a field this arm quietly drops believes it wrote.
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
  // Every column the PATCH route accepts, so a frame that reaches this arm
  // writes what the same frame would have written on a Core. A field silently
  // missing here is not a no-op — it is a caller that believes it wrote.
  const patch = {
    ...(mutation.title !== undefined ? { title: mutation.title } : {}),
    ...(mutation.title !== undefined && mutation.titleManuallySet !== undefined
      ? { titleManuallySet: mutation.titleManuallySet }
      : {}),
    ...(mutation.pinned !== undefined ? { pinned: mutation.pinned } : {}),
    ...(mutation.icon !== undefined ? { icon: mutation.icon } : {}),
    ...(mutation.claudeSessionId !== undefined
      ? { claudeSessionId: mutation.claudeSessionId }
      : {}),
  };
  // Neither `status` nor `archived` is a column the PATCH route accepts, and
  // each has its own endpoint for the same reason: the status route clears the
  // pending question and emits `session:finished` on a finish, archive/restore
  // clear the question and emit `task:archived`/`task:restored`. Apply the
  // plain columns first, then status, then archived, so the returned snapshot
  // carries every leg. A patch that has other work to do skips the PATCH round
  // trip; an otherwise-empty mutation still goes through it, so a no-op
  // mutation returns the row.
  //
  // The frame's status is a free-form string (a Core's vocabulary is its own);
  // the Panel's own route accepts only the statuses it knows, so a word it
  // doesn't recognize is dropped rather than sent for a 400.
  const status = isTaskStatus(mutation.status) ? mutation.status : undefined;
  let task =
    Object.keys(patch).length > 0 || (status === undefined && mutation.archived === undefined)
      ? (await api.updateTask(mutation.taskId, patch)).task
      : null;
  if (status !== undefined) {
    task = (await api.updateTaskStatus(mutation.taskId, { status })).task;
  }
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
    titleManuallySet: task.titleManuallySet,
    claudeSessionId: task.claudeSessionId,
    icon: task.icon,
    agent: task.agent,
    status: task.status,
    archived: task.archived,
    pinned: task.pinned,
    updatedAt: task.updatedAt,
  };
}
