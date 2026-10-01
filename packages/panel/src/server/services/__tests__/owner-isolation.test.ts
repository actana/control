import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";

/**
 * Sessions and Cores never cross owners (#567, ADR 0041 D15). ADR 0011 has one
 * Operator, and `operator` keeps `CHECK (id = 1)`, so a second owner cannot
 * exist in a real Panel. The test lifts that one constraint on its own
 * throw-away database to put a second owner in: what it proves is that the
 * services' queries are scoped by `owner_id`, which is the rule a later
 * multi-account Panel inherits.
 */

const testDb = await openPanelTestDb();
const { createPanelSession, pruneExpiredSessions, resolvePanelSession, revokeAllPanelSessions, revokePanelSession } =
  await import("../panel-sessions");
const {
  advanceCoreCursor,
  coreRegisteredAt,
  getCore,
  getCoreCursor,
  getCoreSecrets,
  listCores,
  registerCoreFromCredential,
  removeCore,
  renameCore,
  CoreRegistryError,
} = await import("../cores");

const ALICE = 1;
const BOB = 2;

const credential = (endpoint: string, bearer: string) => ({
  endpoint,
  label: "box",
  caCert: "ca",
  clientCert: "cert",
  clientKey: "key",
  bearer,
});

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [ALICE, BOB]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
  }
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("Panel sessions across owners", () => {
  it("does not resolve one owner's token as the other's session", async () => {
    const alice = await createPanelSession(Date.now(), ALICE);
    expect(await resolvePanelSession(alice.token, Date.now(), ALICE)).not.toBeNull();
    expect(await resolvePanelSession(alice.token, Date.now(), BOB)).toBeNull();
  });

  it("does not let one owner revoke another's session", async () => {
    const alice = await createPanelSession(Date.now(), ALICE);
    await revokePanelSession(alice.token, BOB);
    expect(await resolvePanelSession(alice.token, Date.now(), ALICE)).not.toBeNull();
    await revokePanelSession(alice.token, ALICE);
    expect(await resolvePanelSession(alice.token, Date.now(), ALICE)).toBeNull();
  });

  it("signs out everywhere for one owner only", async () => {
    const alice = await createPanelSession(Date.now(), ALICE);
    const bob = await createPanelSession(Date.now(), BOB);
    await revokeAllPanelSessions(BOB);
    expect(await resolvePanelSession(bob.token, Date.now(), BOB)).toBeNull();
    expect(await resolvePanelSession(alice.token, Date.now(), ALICE)).not.toBeNull();
  });

  it("prunes only the pruning owner's expired sessions", async () => {
    const past = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const aliceOld = await createPanelSession(past, ALICE);
    await pruneExpiredSessions(Date.now(), BOB);
    const { rows } = await testDb.pool.query("select 1 from panel_sessions where owner_id = $1 and expires_at < $2", [
      ALICE,
      Date.now(),
    ]);
    expect(rows.length).toBeGreaterThan(0);
    await pruneExpiredSessions(Date.now(), ALICE);
    expect(await resolvePanelSession(aliceOld.token, past, ALICE)).toBeNull();
  });
});

describe("Cores across owners", () => {
  it("lists, reads and opens the secrets of an owner's own Cores only", async () => {
    const a = await registerCoreFromCredential(credential("wss://a.example:1", "bearer-a"), { ownerId: ALICE });
    const b = await registerCoreFromCredential(credential("wss://b.example:1", "bearer-b"), { ownerId: BOB });

    expect((await listCores(ALICE)).map((c) => c.id)).toContain(a.id);
    expect((await listCores(ALICE)).map((c) => c.id)).not.toContain(b.id);
    expect((await listCores(BOB)).map((c) => c.id)).toEqual([b.id]);

    expect(await getCore(b.id, ALICE)).toBeNull();
    expect(await getCore(b.id, BOB)).not.toBeNull();
    expect(await getCoreSecrets(b.id, ALICE)).toBeNull();
    expect((await getCoreSecrets(b.id, BOB))?.bearer).toBe("bearer-b");
    expect(await getCoreCursor(b.id, ALICE)).toBe(0);
  });

  it("does not let one owner rename, advance or remove another's Core", async () => {
    const b = await registerCoreFromCredential(credential("wss://b2.example:1", "bearer-b2"), { ownerId: BOB });

    expect(await renameCore(b.id, "hijacked", ALICE)).toBeNull();
    await advanceCoreCursor(b.id, 99, ALICE);
    expect(await removeCore(b.id, ALICE)).toBe(false);

    const after = await getCore(b.id, BOB);
    expect(after?.label).toBe("box");
    expect(after?.lastEventId).toBe(0);
    expect((await getCoreSecrets(b.id, BOB))?.bearer).toBe("bearer-b2");

    expect(await removeCore(b.id, BOB)).toBe(true);
  });

  it("lets two owners register the same endpoint, and still refuses it twice for one", async () => {
    const endpoint = "wss://shared.example:1";
    const a = await registerCoreFromCredential(credential(endpoint, "bearer-a3"), { ownerId: ALICE });
    expect(await coreRegisteredAt(endpoint, ALICE)).toBe(true);
    expect(await coreRegisteredAt(endpoint, BOB)).toBe(false);

    const b = await registerCoreFromCredential(credential(endpoint, "bearer-b3"), { ownerId: BOB });
    expect(b.id).not.toBe(a.id);
    expect((await getCoreSecrets(a.id, ALICE))?.bearer).toBe("bearer-a3");
    expect((await getCoreSecrets(b.id, BOB))?.bearer).toBe("bearer-b3");

    await expect(
      registerCoreFromCredential(credential(endpoint, "bearer-again"), { ownerId: ALICE }),
    ).rejects.toThrow(CoreRegistryError);
  });
});
