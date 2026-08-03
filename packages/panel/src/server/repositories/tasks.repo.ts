import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "~/db/client";
import { tasks } from "~/db/schema";
import type { Task } from "~/db/schema";

export function findAllTasks(): Task[] {
  return getDb().select().from(tasks).all();
}

// Tasks whose status claims a live agent process. Used by the startup sweep:
// at Panel boot no PTYs exist yet, so any such task is an orphan of a
// previous run.
export function findActiveLocalTasks(): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["running", "needs-input"]))
    .all();
}

export function findTasksByProjectId(projectId: string): Task[] {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.createdAt))
    .all();
}

// Hot path (every task read + status poll). Hoist the prepared statement once
// so drizzle/better-sqlite3 skips re-parsing and re-planning the query on each
// call. Lazily built on first use because getDb() must open the connection
// first. `sql.placeholder` binds the id per call.
function buildFindTaskByIdStmt() {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.id, sql.placeholder("id")))
    .prepare();
}
let findTaskByIdStmt: ReturnType<typeof buildFindTaskByIdStmt> | null = null;

export function findTaskById(id: string): Task | null {
  if (!findTaskByIdStmt) findTaskByIdStmt = buildFindTaskByIdStmt();
  return (findTaskByIdStmt.get({ id }) as Task | undefined) ?? null;
}

export function insertTask(row: Task): void {
  getDb().insert(tasks).values(row).run();
}

export function updateTaskRow(id: string, patch: Partial<Task>): void {
  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run();
}

export function deleteTaskRow(id: string): number {
  const result = getDb().delete(tasks).where(eq(tasks.id, id)).run();
  return result.changes;
}

export type TaskSessionRef = {
  taskId: string;
  projectId: string;
  claudeSessionId: string;
};

export function findTasksWithClaudeSessionId(): TaskSessionRef[] {
  const rows = getDb()
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      claudeSessionId: tasks.claudeSessionId,
    })
    .from(tasks)
    .where(sql`${tasks.claudeSessionId} IS NOT NULL`)
    .all();
  return rows.map((r) => ({
    taskId: r.taskId,
    projectId: r.projectId,
    claudeSessionId: r.claudeSessionId!,
  }));
}
