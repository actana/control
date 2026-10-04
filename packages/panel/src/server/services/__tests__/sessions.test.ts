import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const { createOperator } = await import("../operator");
const { createSession, getSession } = await import("../sessions");

beforeEach(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("sessions service", () => {
  it("creates a session that belongs to no project", async () => {
    const created = await createSession({ title: "One", agent: "claude-code" });

    expect(Object.keys(created)).not.toContain("projectId");
    expect(await getSession(created.id)).toEqual(created);
  });
});
