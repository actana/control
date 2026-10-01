import { asc, eq } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import { taskComments, tasks } from "~/db/pg-schema";
import type { NewTaskCommentRow, TaskCommentRow } from "./tasks.repo";

/** Every query here filters on `owner_id` (ADR 0041 D15). */

export async function findCommentsForTask(ownerId: number, taskId: string): Promise<TaskCommentRow[]> {
  return panelDb()
    .select()
    .from(taskComments)
    .where(ownedBy(taskComments, ownerId, eq(taskComments.taskId, taskId)))
    .orderBy(asc(taskComments.seq));
}

/**
 * Add a comment to this owner's Task. Null, with nothing written, when the
 * owner has no such Task. A second agent comment with the same source file
 * throws Postgres' unique violation; the service names it.
 */
export async function insertComment(row: NewTaskCommentRow): Promise<TaskCommentRow | null> {
  return panelDb().transaction(async (tx) => {
    const found = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(ownedBy(tasks, row.ownerId, eq(tasks.id, row.taskId)))
      .limit(1);
    if (found.length === 0) return null;
    const [stored] = await tx.insert(taskComments).values({ ...row, ownerId: row.ownerId }).returning();
    return stored!;
  });
}
