import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-sessions-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { createSession, getSession } = await import("../sessions");
const { getDb } = await import("~/db/client");
const { sessions } = await import("~/db/schema");

describe("sessions service", () => {
  beforeEach(() => {
    getDb().delete(sessions).run();
  });

  it("creates a session that belongs to no project", () => {
    const created = createSession({ title: "One", agent: "claude-code" });

    expect(Object.keys(created)).not.toContain("projectId");
    expect(getSession(created.id)).toEqual(created);
  });
});
