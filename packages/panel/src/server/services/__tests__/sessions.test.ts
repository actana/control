import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-sessions-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { createProject } = await import("../projects");
const { createSession, listSessionsForProject } = await import("../sessions");
const { getDb } = await import("~/db/client");
const { projects, sessions } = await import("~/db/schema");

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-session-project-"));
  return createProject({ name: "p", path: dir });
}

describe("sessions service", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(sessions).run();
    db.delete(projects).run();
  });

  it("lists sessions for a project", () => {
    const p = makeProject();
    createSession({ projectId: p.id, title: "One", agent: "claude-code" });
    createSession({ projectId: p.id, title: "Two", agent: "claude-code" });

    expect(listSessionsForProject(p.id).map((session: { title: string }) => session.title).sort()).toEqual([
      "One",
      "Two",
    ]);
  });
});
