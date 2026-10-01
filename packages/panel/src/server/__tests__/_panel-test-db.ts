import { installPanelDb } from "~/db/panel-db-handle";
import { createTestDb, type TestDb } from "~/db/test-db";

/**
 * The Panel's database for one test file (#567): the real migrations on PGlite,
 * or on a real server when `AC_TEST_DATABASE_URL` is set, with every repository
 * routed through it. One per file, because a PGlite start-up costs seconds;
 * `resetPanelState` empties it between tests.
 */
export async function openPanelTestDb(): Promise<TestDb> {
  const db = await createTestDb();
  installPanelDb(db.db);
  return db;
}

/** Back to first boot: no Operator, and with it no sessions, Cores or secrets. */
export async function resetPanelState(db: TestDb): Promise<void> {
  await db.pool.query("truncate operator cascade");
}

export async function closePanelTestDb(db: TestDb): Promise<void> {
  installPanelDb(null);
  await db.close();
}
