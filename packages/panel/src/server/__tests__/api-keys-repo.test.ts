import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";

/**
 * Two owners, one table (#572, ADR 0041 D15). `operator` keeps `CHECK (id = 1)`,
 * so the test lifts it on its own throw-away database to put a second owner in.
 */

const testDb = await openPanelTestDb();
const { findApiKeyById, findApiKeyCoreIds, findApiKeys, findApiKeysByPrefix, insertApiKey, revokeApiKeyRow } = await import(
  "../repositories/api-keys.repo"
);

const A = 1;
const B = 2;

const key = (ownerId: number, id: string, prefix = "ak_p") => ({
  id,
  ownerId,
  name: id,
  prefix,
  keyHash: `hash-${id}`,
  allCores: true,
  createdAt: 10,
  revokedAt: null,
});

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, 'c', $3, 1, 1)",
      [`core-${id}`, id, `https://core-${id}`],
    );
  }
  expect((await insertApiKey(key(A, "a-1"), null)).kind).toBe("ok");
  expect((await insertApiKey(key(B, "b-1"), ["core-2"])).kind).toBe("ok");
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("API keys of two owners", () => {
  it("lists, reads and looks up by prefix only the asking owner's keys", async () => {
    expect((await findApiKeys(A)).map((k) => k.id)).toEqual(["a-1"]);
    expect((await findApiKeys(B)).map((k) => k.id)).toEqual(["b-1"]);
    expect(await findApiKeyById(B, "a-1")).toBeNull();
    expect((await findApiKeysByPrefix(A, "ak_p")).map((k) => k.id)).toEqual(["a-1"]);
    expect([...(await findApiKeyCoreIds(A)).keys()]).toEqual([]);
    expect([...(await findApiKeyCoreIds(B)).entries()]).toEqual([["b-1", ["core-2"]]]);
  });

  it("will not revoke another owner's key", async () => {
    expect(await revokeApiKeyRow(B, "a-1", 99)).toBeNull();
    expect((await findApiKeyById(A, "a-1"))!.revokedAt).toBeNull();
    expect((await revokeApiKeyRow(A, "a-1", 99))!.revokedAt).toBe(99);
    expect(await revokeApiKeyRow(A, "a-1", 100)).toBeNull();
    expect((await findApiKeyById(A, "a-1"))!.revokedAt).toBe(99);
  });

  it("will not restrict a key to another owner's Core, and writes nothing when it refuses", async () => {
    expect(await insertApiKey(key(A, "a-2"), ["core-2"])).toEqual({ kind: "no-core" });
    expect(await insertApiKey(key(A, "a-3"), ["core-1", "core-2"])).toEqual({ kind: "no-core" });
    expect(await findApiKeyById(A, "a-2")).toBeNull();
    expect(await findApiKeyById(A, "a-3")).toBeNull();
  });
});
