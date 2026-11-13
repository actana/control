import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auto-retry-settings-test-"));
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
delete process.env.AC_SECRETS_KEY;

const testDb = await openPanelTestDb();
const {
  getAutoRetrySettings,
  isCorePaused,
  listPausedCores,
  recordCoreRetry,
  resumeAutoRetryOnCore,
  setAutoRetrySettings,
} = await import("../auto-retry-settings");

const A = 1;
const MIN = 60_000;

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (1, 'A', 'h', 1, 1) on conflict do nothing",
  );
});
beforeEach(async () => {
  await testDb.pool.query("delete from app_settings where key like 'tasks.autoRetry.%'");
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("auto-retry instance settings", () => {
  it("defaults to on with a ceiling of 3", async () => {
    expect(await getAutoRetrySettings(A)).toEqual({ enabled: true, maxAttemptsCeiling: 3 });
  });

  it("stores the kill switch and the ceiling, each on its own", async () => {
    expect(await setAutoRetrySettings(A, { enabled: false })).toEqual({ enabled: false, maxAttemptsCeiling: 3 });
    expect(await setAutoRetrySettings(A, { maxAttemptsCeiling: 2 })).toEqual({ enabled: false, maxAttemptsCeiling: 2 });
    expect(await getAutoRetrySettings(A)).toEqual({ enabled: false, maxAttemptsCeiling: 2 });
    const { rows } = await testDb.pool.query("select key, value from app_settings where key like 'tasks.autoRetry.%' order by key");
    expect(rows).toEqual([
      { key: "tasks.autoRetry.enabled", value: "false" },
      { key: "tasks.autoRetry.maxAttemptsCeiling", value: "2" },
    ]);
  });

  it("refuses a ceiling outside 1..3 and writes nothing", async () => {
    for (const bad of [0, 4, 1.5, Number.NaN]) {
      await expect(setAutoRetrySettings(A, { maxAttemptsCeiling: bad })).rejects.toThrow(/1 to 3/);
    }
    await expect(setAutoRetrySettings(A, { enabled: "no" as unknown as boolean })).rejects.toThrow();
    expect(await getAutoRetrySettings(A)).toEqual({ enabled: true, maxAttemptsCeiling: 3 });
  });

  it("falls back to the defaults on a damaged stored value", async () => {
    await testDb.pool.query("insert into app_settings (owner_id, key, value) values (1, 'tasks.autoRetry.maxAttemptsCeiling', '9')");
    expect(await getAutoRetrySettings(A)).toEqual({ enabled: true, maxAttemptsCeiling: 3 });
  });
});

describe("per-Core circuit breaker", () => {
  it("trips on the third auto-retry within 60 minutes, once", async () => {
    expect(await recordCoreRetry(A, "core-a", 0)).toEqual({ tripped: false });
    expect(await recordCoreRetry(A, "core-a", 10 * MIN)).toEqual({ tripped: false });
    expect(await isCorePaused(A, "core-a")).toBe(false);
    expect(await recordCoreRetry(A, "core-a", 59 * MIN)).toEqual({ tripped: true });
    expect(await listPausedCores(A)).toEqual(["core-a"]);
    expect(await isCorePaused(A, "core-a")).toBe(true);
    expect(await recordCoreRetry(A, "core-a", 60 * MIN)).toEqual({ tripped: false });
    expect(await listPausedCores(A)).toEqual(["core-a"]);
  });

  it("does not count retries older than the window", async () => {
    await recordCoreRetry(A, "core-a", 0);
    await recordCoreRetry(A, "core-a", 30 * MIN);
    expect(await recordCoreRetry(A, "core-a", 61 * MIN)).toEqual({ tripped: false });
    expect(await isCorePaused(A, "core-a")).toBe(false);
  });

  it("counts each Core on its own", async () => {
    await recordCoreRetry(A, "core-a", 0);
    await recordCoreRetry(A, "core-b", 1);
    await recordCoreRetry(A, "core-a", 2);
    expect(await recordCoreRetry(A, "core-b", 3)).toEqual({ tripped: false });
    expect(await listPausedCores(A)).toEqual([]);
  });

  it("an operator resume unpauses the Core and forgets its recent retries", async () => {
    for (const t of [0, 1, 2]) await recordCoreRetry(A, "core-a", t);
    await recordCoreRetry(A, "core-b", 3);
    await resumeAutoRetryOnCore(A, "core-a");
    expect(await listPausedCores(A)).toEqual([]);
    expect(await recordCoreRetry(A, "core-a", 4)).toEqual({ tripped: false });
    await resumeAutoRetryOnCore(A, "core-never-paused");
  });
});
