import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";

/**
 * The API key service (#572): the plaintext is shown once and stored nowhere,
 * only a sha256 and a prefix are kept, a revoked key never authenticates, and a
 * key reaches the Cores it was given and no other owner's.
 */

// A pass-through spy, so a test can see that the compare really goes through timingSafeEqual.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, default: real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const testDb = await openPanelTestDb();
const { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey, scopeReaches } = await import("../api-keys");
const { NotFoundError, ValidationError } = await import("../../errors");

const A = 1;
const B = 2;
const ALL = ALL_API_KEY_PERMISSIONS;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
});
beforeEach(async () => {
  await resetPanelState(testDb);
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
    for (const c of ["a", "b"]) {
      await testDb.pool.query(
        "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, 'c', $3, 1, 1)",
        [`${c}-${id}`, id, `https://${c}-${id}`],
      );
    }
  }
});
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("createApiKey", () => {
  it("returns the plaintext once, and stores only its sha256 and a display prefix", async () => {
    const { apiKey, key } = await createApiKey(A, { name: "ci", permissions: ALL }, 1000);
    expect(key).toMatch(/^ak_1_[A-Za-z0-9_-]{43}$/);
    expect(apiKey).toMatchObject({ name: "ci", allCores: true, coreIds: [], createdAt: 1000, revokedAt: null });
    expect(key.startsWith(apiKey.prefix)).toBe(true);
    expect(apiKey.prefix).toHaveLength("ak_1_".length + 6);
    const { rows } = await testDb.pool.query("select * from api_keys");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toBe(sha(key));
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(key.slice("ak_1_".length));
    expect(JSON.stringify(await listApiKeys(A))).not.toContain(key.slice("ak_1_".length + 6));
    expect(JSON.stringify(await listApiKeys(A))).not.toContain(rows[0]!.key_hash);
  });

  it("mints a different key each time", async () => {
    const one = await createApiKey(A, { name: "one", permissions: ALL });
    const two = await createApiKey(A, { name: "two", permissions: ALL });
    expect(one.key).not.toBe(two.key);
  });

  it("never writes the plaintext to any table or to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { key } = await createApiKey(A, { name: "quiet", coreIds: ["a-1"], permissions: ALL });
    await authenticateApiKey(key);
    await authenticateApiKey(`${key}x`);
    const secret = key.slice("ak_1_".length);
    const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
    for (const s of spies) s.mockRestore();
    for (const table of ["api_keys", "api_key_cores", "cores", "operator", "panel_sessions", "tasks", "agents"]) {
      const { rows } = await testDb.pool.query(`select * from ${table}`);
      expect(JSON.stringify(rows), table).not.toContain(secret);
    }
    expect(logged).not.toContain(secret);
  });

  it("refuses a blank or over-long name, an empty restriction, and a Core that is not the owner's", async () => {
    await expect(createApiKey(A, { name: "   ", permissions: ALL })).rejects.toBeInstanceOf(ValidationError);
    await expect(createApiKey(A, { name: "x".repeat(81), permissions: ALL })).rejects.toBeInstanceOf(ValidationError);
    await expect(createApiKey(A, { name: "k", coreIds: [], permissions: ALL })).rejects.toBeInstanceOf(ValidationError);
    await expect(createApiKey(A, { name: "k", coreIds: ["a-1", "a-2"], permissions: ALL })).rejects.toBeInstanceOf(ValidationError);
    await expect(createApiKey(A, { name: "k", coreIds: ["nope"], permissions: ALL })).rejects.toBeInstanceOf(ValidationError);
    expect((await testDb.pool.query("select count(*)::int as n from api_keys")).rows[0]).toEqual({ n: 0 });
  });
});

describe("authenticateApiKey", () => {
  it("runs a key as its owner, with every Core by default", async () => {
    const { apiKey, key } = await createApiKey(A, { name: "all", permissions: ALL });
    const principal = await authenticateApiKey(key);
    expect(principal).toEqual({ ownerId: A, keyId: apiKey.id, scope: { allCores: true }, permissions: new Set(ALL) });
    expect(scopeReaches(principal!.scope, "a-1")).toBe(true);
    expect(scopeReaches(principal!.scope, "anything")).toBe(true);
  });

  it("restricts a key to the Cores it was given", async () => {
    const { key } = await createApiKey(A, { name: "one", coreIds: ["a-1", "a-1"], permissions: ALL });
    const principal = await authenticateApiKey(key);
    expect(principal!.scope.allCores).toBe(false);
    expect(scopeReaches(principal!.scope, "a-1")).toBe(true);
    expect(scopeReaches(principal!.scope, "b-1")).toBe(false);
  });

  it("runs owner B's key as B, and never reaches A's Cores", async () => {
    const { key } = await createApiKey(B, { name: "b", permissions: ALL });
    const principal = await authenticateApiKey(key);
    expect(principal!.ownerId).toBe(B);
    await expect(createApiKey(B, { name: "x", coreIds: ["a-1"], permissions: ALL })).rejects.toBeInstanceOf(ValidationError);
  });

  it("cannot be claimed by another owner: a key with the owner part rewritten is unknown", async () => {
    const { key } = await createApiKey(A, { name: "a", permissions: ALL });
    expect(await authenticateApiKey(key.replace("ak_1_", "ak_2_"))).toBeNull();
  });

  it("rejects malformed, unknown, truncated and altered keys", async () => {
    const { key } = await createApiKey(A, { name: "a", permissions: ALL });
    for (const bad of ["", "ak_1_", "nope", `${key}x`, key.slice(0, -1), `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`]) {
      expect(await authenticateApiKey(bad), bad).toBeNull();
    }
  });

  it("compares the hashes with timingSafeEqual on equal-length buffers", async () => {
    const { timingSafeEqual: compare } = vi.mocked(await import("node:crypto"));
    compare.mockClear();
    const { key } = await createApiKey(A, { name: "a", permissions: ALL });
    expect(await authenticateApiKey(key)).not.toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
    const [stored, presented] = compare.mock.calls[0]!;
    expect(Buffer.byteLength(stored as Buffer)).toBe(32);
    expect(Buffer.byteLength(presented as Buffer)).toBe(32);
    expect(Buffer.from(presented as Buffer).toString("hex")).toBe(sha(key));
  });

  it("does not let a stored hash of the wrong length authenticate", async () => {
    const { apiKey, key } = await createApiKey(A, { name: "a", permissions: ALL });
    await testDb.pool.query("update api_keys set key_hash = 'abcd' where id = $1", [apiKey.id]);
    expect(await authenticateApiKey(key)).toBeNull();
  });
});

describe("revokeApiKey", () => {
  it("makes the key stop authenticating at once, and for good", async () => {
    const { apiKey, key } = await createApiKey(A, { name: "a", permissions: ALL });
    expect(await authenticateApiKey(key)).not.toBeNull();
    const revoked = await revokeApiKey(A, apiKey.id, 5000);
    expect(revoked.revokedAt).toBe(5000);
    expect(await authenticateApiKey(key)).toBeNull();
    expect((await revokeApiKey(A, apiKey.id, 9000)).revokedAt).toBe(5000);
    expect(await authenticateApiKey(key)).toBeNull();
    await expect(testDb.pool.query("update api_keys set revoked_at = null where id = $1", [apiKey.id])).rejects.toThrow(
      /api_keys_revocation_is_final/,
    );
    expect(await authenticateApiKey(key)).toBeNull();
  });

  it("does not find, or revoke, another owner's key", async () => {
    const { apiKey, key } = await createApiKey(A, { name: "a", permissions: ALL });
    await expect(revokeApiKey(B, apiKey.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await authenticateApiKey(key)).not.toBeNull();
    expect((await listApiKeys(B))).toEqual([]);
  });

  it("revokes a restricted key and keeps its Cores in the list", async () => {
    const { apiKey } = await createApiKey(A, { name: "a", coreIds: ["b-1", "a-1"], permissions: ALL });
    expect((await revokeApiKey(A, apiKey.id)).coreIds).toEqual(["a-1", "b-1"]);
  });
});

describe("a restricted key whose Cores were forgotten", () => {
  it("reaches none, and does not turn into a key that reaches all", async () => {
    const { key } = await createApiKey(A, { name: "a", coreIds: ["a-1"], permissions: ALL });
    await testDb.pool.query("delete from cores where id = 'a-1'");
    const principal = await authenticateApiKey(key);
    expect(principal!.scope).toEqual({ allCores: false, coreIds: new Set() });
    expect(scopeReaches(principal!.scope, "b-1")).toBe(false);
  });
});
