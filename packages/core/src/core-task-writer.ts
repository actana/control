// The Core's one way to change a task row.
//
// A Core-owned Task's status, title and icon are Core state (ADR 0004/0005),
// and two callers now change them: the Panel, over the core-link's
// `tasksMutate` frame, and the Core itself — the hook receiver settling a
// harness's status, the PTY exit settling a dead session, the title generator
// naming a new one (issue 84). Both go through here, so a row never changes
// without the matching event landing in the log the Panel replays from.
//
// The write is Core-local by construction: the mutation port writes this
// Core's SQLite and the event port appends to this Core's event log. Nothing
// here round-trips through the Panel, and nothing here needs a Panel to be
// connected — an event appended while the link is down is replayed off the
// cursor when it comes back.

import type {
  CoreLinkTaskMutation,
  CoreLinkTaskSnapshot,
} from "@actana/shared/core-link-frames";
import type { TaskStatus } from "@actana/shared/domain";
import type { CoreMutationPort, CoreQueryPort, EventLogPort } from "./pty-core-link-server";

const FINISHED_TASK_STATUS: TaskStatus = "finished";

export type CoreTaskWriterPorts = {
  /** Writes the row. Absent on a PTY-only Core; every write then answers `null`. */
  mutationPort: CoreMutationPort | null;
  /** Reads the row's prior facts. Absent means "no prior status known". */
  queryPort: CoreQueryPort | null;
  /** Appends the events. Absent means no event is recorded (tests, PTY-only Core). */
  eventLog: EventLogPort | null;
};

/**
 * Apply a task mutation to this Core's database and append the events that
 * describe it. Returns the resulting snapshot, or `null` when the mutation
 * targeted a row this Core does not have — the same answer the core-link
 * frame carries, so a caller never has to tell "wrote nothing" from "no such
 * row" by a different route. Throws what the mutation port throws (invalid
 * input); the core-link server turns that into an `error` frame.
 */
export class CoreTaskWriter {
  constructor(private readonly ports: CoreTaskWriterPorts) {}

  mutate(mutation: CoreLinkTaskMutation): CoreLinkTaskSnapshot | null {
    const { mutationPort } = this.ports;
    if (!mutationPort) return null;
    const previousStatus = this.priorTaskStatus(mutation);
    const task = mutationPort.mutateTask(mutation);
    if (task) this.recordTaskMutation(mutation, task, previousStatus);
    return task;
  }

  /** This Core's current row for `taskId`, or `null` when it has none. */
  readTask(taskId: string): CoreLinkTaskSnapshot | null {
    return this.ports.queryPort?.getTask(taskId) ?? null;
  }

  /**
   * Record a task mutation in the event log so a reconnecting Panel learns
   * about the change via the same `subscribe` / `event` / `eventsReplayed`
   * replay path the PTY lifecycle events use (issue 04).
   *
   * On `update`, the kind depends on which fields the frame carried:
   *  - `icon` set (with no other patched field) → `task:iconChanged` — the
   *    Panel's live query wants to route icon-only edits distinctly from other
   *    task updates so a reconnecting Panel replays the change through the
   *    existing `subscribe`/`event`/`eventsReplayed` path (issue 09).
   *  - `pinned` set (with no other patched field) → `task:pinnedChanged` —
   *    same rationale as icon (issue 10). Pin toggles are frequent and
   *    consumers that only track pinned state (e.g. the SessionGrid pinned
   *    filter) can subscribe distinctly.
   *  - anything else → `task:updated` (unchanged).
   *
   * On `create`, the kind is always `task:created` — a new row's icon is part
   * of the initial snapshot the tasks list carries, not a discrete change.
   *
   * On `delete`, the kind is `task:deleted` — the same name the Panel server
   * emits when it deletes a Panel-owned row, so a reconnecting Panel replays a
   * Core-owned delete through the handler it already has (it prunes that
   * session's stored finish notifications keyed on the event's `taskId`).
   *
   * A transition into `finished` additionally appends `session:finished`
   * (issue 20) — the event ADR 0008 built the Panel's notification on and no
   * Core ever produced. It is additional, not a replacement: the live query
   * still needs the `task:updated` event for the same mutation.
   */
  private recordTaskMutation(
    mutation: CoreLinkTaskMutation,
    task: CoreLinkTaskSnapshot,
    previousStatus: string | null,
  ): void {
    const { eventLog } = this.ports;
    if (!eventLog) return;
    const kind =
      mutation.op === "create"
        ? "task:created"
        : mutation.op === "delete"
          ? "task:deleted"
          : isOnlyPatchedField(mutation, "icon")
            ? "task:iconChanged"
            : isOnlyPatchedField(mutation, "pinned")
              ? "task:pinnedChanged"
              : "task:updated";
    const payload = JSON.stringify({ taskId: task.taskId, projectId: task.projectId });
    eventLog.appendEvent(kind, payload, { taskId: task.taskId });
    this.recordSessionFinish(mutation, task, previousStatus);
  }

  /**
   * Append `session:finished` when a mutation moved a task into `finished` —
   * and only then. Two things have to hold, and both are load-bearing.
   *
   * The mutation must be the one that set the status: the resulting snapshot
   * alone would say `finished` for every later write to the same row, so
   * archiving, pinning, or renaming a finished Session — the most routine
   * things to do with one — would each raise a fresh notification.
   *
   * And the row must not have been finished already, so a retried exit patch
   * or a second tab racing the first cannot raise a second notification. That
   * is what the prior status is for; the snapshot cannot tell the two apart.
   *
   * The payload carries what the Panel's finish normalizer reads: the task id
   * (as `id`, its preferred key), the project id, the project name, and the
   * task title. Without the last two the toast reads "Project" / "Session",
   * which is the degraded output this event exists to avoid. The project name
   * is the one field not on the task snapshot; it is read through the query
   * port, and omitted when no query port is wired (a PTY-only Core).
   */
  private recordSessionFinish(
    mutation: CoreLinkTaskMutation,
    task: CoreLinkTaskSnapshot,
    previousStatus: string | null,
  ): void {
    const { eventLog, queryPort } = this.ports;
    if (!eventLog) return;
    if (!patchesFinishedStatus(mutation)) return;
    if (task.status !== FINISHED_TASK_STATUS) return;
    if (previousStatus === FINISHED_TASK_STATUS) return;
    const projectName = queryPort
      ?.listProjects()
      .find((p) => p.projectId === task.projectId)?.name;
    const payload = JSON.stringify({
      id: task.taskId,
      taskId: task.taskId,
      projectId: task.projectId,
      ...(projectName ? { projectName } : {}),
      taskTitle: task.title,
    });
    eventLog.appendEvent("session:finished", payload, { taskId: task.taskId });
  }

  /**
   * The status a task carried before a mutation is applied, or `null` when
   * there is nothing to read — an unknown row, a Core with no query port, or
   * a mutation that could not produce a finish. Only a patch that could pays
   * for the read; nothing else consults the prior status.
   */
  private priorTaskStatus(mutation: CoreLinkTaskMutation): string | null {
    if (!patchesFinishedStatus(mutation)) return null;
    return this.ports.queryPort?.getTask(mutation.taskId)?.status ?? null;
  }
}

/**
 * Is this the mutation that sets `finished`? A snapshot that says `finished`
 * is not enough — every later write to a finished row says the same.
 */
function patchesFinishedStatus(
  mutation: CoreLinkTaskMutation,
): mutation is Extract<CoreLinkTaskMutation, { op: "update" }> {
  return mutation.op === "update" && mutation.status === FINISHED_TASK_STATUS;
}

/**
 * Which columns an `update` mutation actually patches. One list, so a new
 * field on the mutation cannot be forgotten by the "was this the only thing
 * that changed?" checks below — which is exactly how an icon-plus-something
 * patch would otherwise keep announcing itself as an icon-only change.
 */
function patchedFields(mutation: CoreLinkTaskMutation): string[] {
  if (mutation.op !== "update") return [];
  const { op: _op, taskId: _taskId, ...patch } = mutation;
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field)
    // `titleManuallySet` qualifies the `title` beside it rather than being a
    // change of its own; counting it would make every rename a mixed edit.
    .filter((field) => field !== "titleManuallySet");
}

/**
 * Detect an update mutation whose only patched column is `field` — the
 * narrowing that keeps the dedicated `task:iconChanged` (issue 09) and
 * `task:pinnedChanged` (issue 10) kinds meaningful. Anything patched alongside
 * degrades the frame back to `task:updated`, which is fine: a consumer that
 * only cares about icon subscribes to the dedicated kind, and a mixed edit
 * already invalidates the whole row through the generic one.
 */
function isOnlyPatchedField(mutation: CoreLinkTaskMutation, field: string): boolean {
  const patched = patchedFields(mutation);
  return patched.length === 1 && patched[0] === field;
}
