import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-tasks-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { createProject } = await import("../projects");
const { createTask, listTasksForProject } = await import("../tasks");
const { getDb } = await import("~/db/client");
const { projects, tasks, userTerminals } = await import("~/db/schema");

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-task-project-"));
  return createProject({ name: "p", path: dir });
}

describe("tasks service", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(userTerminals).run();
    db.delete(tasks).run();
    db.delete(projects).run();
  });

  it("lists tasks for a project", () => {
    const p = makeProject();
    createTask({ projectId: p.id, title: "One", agent: "claude-code" });
    createTask({ projectId: p.id, title: "Two", agent: "claude-code" });

    expect(listTasksForProject(p.id).map((task: { title: string }) => task.title).sort()).toEqual([
      "One",
      "Two",
    ]);
  });
});
