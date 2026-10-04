import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createS3CoreShared } from "@actana/sdk/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import { FakeClock, fakeSts } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * The Files service across owners (#565, ADR 0041 D15). ADR 0011 has one Operator, and `operator` keeps
 * `CHECK (id = 1)`, so the test lifts that one constraint on its own throw-away database to put a second owner in (as
 * `owner-isolation.test.ts` does): what it proves is that a call runs as the owner it names, on that owner's Cores and
 * with that owner's storage, and that a key one owner's call cached is never a way into the other's folder.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-shared-files-owners-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { registerCoreFromCredential, removeCore } = await import("../services/cores");
const { saveStorageConfig, storageKeyIssuer } = await import("../services/storage");
const { SharedFiles } = await import("../services/shared-files");
const { updateSharedFolder } = await import("../repositories/core-shared-folders.repo");

const ALICE = 1;
const BOB = 2;
const BUCKET = "actana-shared";
const PREFIX = "cores";
const masterPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = masterPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let n = 0;
async function coreOf(ownerId: number): Promise<string> {
  n += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://owners-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { label: `core ${n}`, ownerId, pendingSharedFolder: true },
  );
  await updateSharedFolder(ownerId, core.id, { state: "attached", s3Prefix: `${PREFIX}/${core.id}/` }, Date.now());
  return core.id;
}

function rig() {
  const clock = new FakeClock();
  const s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  const sts = fakeSts({ s3, masterPublic: masterPair.publicKey, prefix: PREFIX, clock });
  const service = new SharedFiles({
    issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
    s3: ({ target, folder, key }) =>
      createS3CoreShared({
        endpoint: target.endpoint,
        bucket: target.bucket,
        prefix: folder.replace(/\/+$/, ""),
        credentials: { get: async () => key },
        fetch: s3.fetch,
        now: clock.now,
      }),
    now: clock.now,
  });
  return { s3, sts, service, clock };
}

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [ALICE, BOB]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
  }
});
beforeEach(async () => {
  for (const owner of [ALICE, BOB]) {
    await saveStorageConfig(
      { backend: "seaweedfs", endpoint: "http://seaweedfs.test:8333", bucket: BUCKET, prefix: PREFIX, oidcIssuer: "https://panel.test", keyId: "k1", masterKey: MASTER_PEM },
      owner,
    );
  }
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the Files service across owners", () => {
  it("gives each owner their own Core's folder and the other's Core as 'no such Core', with no key issued and no S3 request", async () => {
    const { s3, sts, service } = rig();
    const aliceCore = await coreOf(ALICE);
    const bobCore = await coreOf(BOB);
    s3.seed(`${PREFIX}/${aliceCore}/alice.txt`, "A");
    s3.seed(`${PREFIX}/${bobCore}/bob.txt`, "B");

    expect((await service.list(ALICE, aliceCore, "")).entries.map((e) => e.name)).toEqual(["alice.txt"]);
    expect((await service.list(BOB, bobCore, "")).entries.map((e) => e.name)).toEqual(["bob.txt"]);
    const issued = sts.issued.length;
    const requests = s3.requests.length;

    // Bob asks for Alice's Core, with every operation. Alice's key is in the service's cache by now: it must not matter.
    await expect(service.list(BOB, aliceCore, "")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.details(BOB, aliceCore, "alice.txt")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.downloadUrl(BOB, aliceCore, "alice.txt")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.search(BOB, aliceCore, "alice")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.summary(BOB, aliceCore, 0)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.mkdir(BOB, aliceCore, "planted/")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.upload(BOB, aliceCore, "planted.txt", null, 0)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.rename(BOB, aliceCore, "alice.txt", "mine.txt")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.move(BOB, aliceCore, "alice.txt", "d/")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.remove(BOB, aliceCore, "alice.txt")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.list(ALICE, bobCore, "")).rejects.toMatchObject({ name: "NotFoundError" });

    expect(sts.issued).toHaveLength(issued);
    expect(s3.requests).toHaveLength(requests);
    expect(s3.text(`${PREFIX}/${aliceCore}/alice.txt`)).toBe("A");
    expect(s3.objects.has(`${PREFIX}/${aliceCore}/mine.txt`)).toBe(false);
  });

  it("stops serving a Core the moment it is removed, even with its key still cached", async () => {
    const { s3, service } = rig();
    const core = await coreOf(ALICE);
    s3.seed(`${PREFIX}/${core}/f.txt`, "x");
    await service.list(ALICE, core, "");
    await removeCore(core, ALICE);
    await expect(service.list(ALICE, core, "")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.remove(ALICE, core, "f.txt")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(s3.text(`${PREFIX}/${core}/f.txt`)).toBe("x");
  });
});
