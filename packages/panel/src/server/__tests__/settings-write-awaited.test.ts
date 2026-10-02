import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * A settings update must not answer before the write lands (#567). On PGlite a
 * statement that was never awaited still finishes before the next one, so this
 * test slows `setAppSetting`: a controller that dropped its `await` would
 * return while the preference was still unset.
 */

const finished: string[] = [];
const slow = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = await fn(...args);
    finished.push(name);
    return result;
  };

vi.mock("../repositories/app-settings.repo", async (importOriginal) => {
  const real = await importOriginal<typeof import("../repositories/app-settings.repo")>();
  return {
    ...real,
    setAppSetting: slow("setAppSetting", real.setAppSetting),
  };
});

const testDb = await openPanelTestDb();
const { update, read } = await import("../controllers/settings.controller");
const { createOperator } = await import("../services/operator");
const { getBooleanSetting } = await import("../services/settings");

beforeEach(async () => {
  await resetPanelState(testDb);
  finished.length = 0;
  await createOperator({ name: "Ada", password: "correct-horse-battery" });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("settings write is finished before the answer", () => {
  it("update has persisted mouseGradientDisabled by the time it returns", async () => {
    const res = await update(
      new Request("http://panel.example.test/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mouseGradientDisabled: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(finished).toContain("setAppSetting");
    expect(await getBooleanSetting("mouse_gradient_disabled")).toBe(true);

    const get = await read();
    expect(await get.json()).toMatchObject({ mouseGradientDisabled: true });
  });
});
