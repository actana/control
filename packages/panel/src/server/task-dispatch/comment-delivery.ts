import { CoreSession } from "@actana/sdk/core";
import type { TaskCommentDelivery } from "~/shared/task-wire";
import { coreLinkManager } from "../services/core-link-manager";
import { addTaskComment, findCurrentTaskSession, getTask, type TaskComment } from "../services/tasks";
import { consoleDispatchLog, messageOf, type Clock, type DispatchLog } from "./types";

/**
 * A comment on a running Task goes into its Session, "now" mode (#935): typed into the harness mid-turn, through the Panel's
 * own link to the Core, the way a re-assign types its pointer into a live harness (`sendIntoRunningSession`).
 *
 * The comment is always stored first (it is the Task's note). This only decides whether it is also typed. It is not typed when
 *  - the Task is not `in_progress`;
 *  - the Task's Session state is `needs-input` (#949): the Session is parked on a dialog, and text typed into it would answer
 *    an approval by accident (#924). The Core refuses a stamped write into such a Session as well (`blocked`), so a state the
 *    Panel has not heard of yet is still refused there; the text goes through `deliver`, the stamped write, for that reason;
 *  - there is no recorded Session, no live link, or the Core does not take the write.
 * A refusal is kept as a note: a system comment on the Task says why, and the answer carries the same reason.
 *
 * The Session's reply is not a new path: the Agent reports through its result file, which the result watcher turns into a Task
 * comment, as it does for every attempt.
 */

/** Longest comment text typed into a Session; a harness composer scrolls, collapses or swallows a longer one. */
export const MAX_DELIVERED_COMMENT_CHARS = 800;

/** One line of plain text: every control character (ESC, Ctrl-C, DEL, C1) and run of whitespace becomes one space, so nothing typed can steer the harness's terminal. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
}

/** The line typed into the Session: one line of plain text, the author named, cut when long. */
export function commentTypedLine(taskId: string, comment: Pick<TaskComment, "authorName" | "body">): string {
  const flat = oneLine(comment.body);
  const cut = flat.length > MAX_DELIVERED_COMMENT_CHARS;
  const text = cut ? `${Array.from(flat).slice(0, MAX_DELIVERED_COMMENT_CHARS).join("")} ... (cut: read the whole comment on the Task)` : flat;
  return `New comment on your Task ${taskId} from ${oneLine(comment.authorName)}: ${text}`;
}

/** A live Session a line can be typed into, as the delivery needs it. */
export type SessionTyper = {
  /** The stamped write (`CoreSession.deliver`): false when the Core did not take it, `blocked` included. */
  deliver(text: string): Promise<{ ok: boolean }>;
  dispose(): void;
};

export type CommentDeliveryDeps = {
  /** Attach to a Session on a Core; throws when there is no live link. Default: the Panel's own link. */
  attach?: (coreId: string, sessionId: string) => Promise<SessionTyper>;
  now?: Clock;
  log?: DispatchLog;
};

let attachOverride: ((coreId: string, sessionId: string) => Promise<SessionTyper>) | null = null;

/** A test hands in the Core's end of the link; `null` puts the Panel's own link back. */
export function setSessionTyperForTests(attach: typeof attachOverride): void {
  attachOverride = attach;
}

async function attachOnCore(coreId: string, sessionId: string): Promise<SessionTyper> {
  const sdk = coreLinkManager().client(coreId)?.sdk;
  if (!sdk) throw new Error("there is no live link to this Core");
  return CoreSession.attach(sdk, { sessionId });
}

async function typeInto(typer: SessionTyper, line: string): Promise<string | null> {
  // The text and then the return, two writes (never glued): the SDK's rule for a message that starts a turn.
  if (!(await typer.deliver(line)).ok) return "the Core did not take it (the Session is waiting on a dialog, or its process has ended)";
  if (!(await typer.deliver("\r")).ok) return "the Core did not take the return after it";
  return null;
}

/** Why this stored comment is not typed, or null when it may be tried. Reads the Task as it is now. */
async function refusalFor(ownerId: number, taskId: string): Promise<string | null> {
  const task = await getTask(ownerId, taskId);
  if (task.status !== "in_progress") return `the Task is ${task.status}, not running`;
  if (task.sessionState === "needs-input") return "the Session is waiting for input: nothing is typed into it";
  return null;
}

export async function deliverCommentNow(ownerId: number, taskId: string, comment: TaskComment, deps: CommentDeliveryDeps = {}): Promise<TaskCommentDelivery> {
  const log = deps.log ?? consoleDispatchLog;
  let reason = await refusalFor(ownerId, taskId);
  if (reason === null) {
    const target = await findCurrentTaskSession(ownerId, taskId);
    if (!target) {
      reason = "the Task has no Session recorded";
    } else {
      let typer: SessionTyper | null = null;
      try {
        typer = await (deps.attach ?? attachOverride ?? attachOnCore)(target.coreId, target.sessionId);
        reason = await typeInto(typer, commentTypedLine(taskId, comment));
      } catch (err) {
        // A Session another client holds the lock on, a link that went away, a PTY that ended.
        reason = messageOf(err);
      } finally {
        typer?.dispose();
      }
    }
  }
  if (reason === null) {
    log.info(`task ${taskId}: comment ${comment.id} typed into its Session`);
    return { mode: "now", delivered: true };
  }
  log.info(`task ${taskId}: comment ${comment.id} kept as a note, not typed into the Session: ${reason}`);
  await addTaskComment(
    ownerId,
    taskId,
    { authorKind: "system", authorName: "Panel", body: `Not typed into the Session: ${reason}. The comment above is kept as a note.` },
    (deps.now ?? Date.now)(),
  ).catch((err) => log.error(`task ${taskId}: could not note the refused delivery: ${messageOf(err)}`));
  return { mode: "now", delivered: false, reason };
}
