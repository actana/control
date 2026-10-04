import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { FakeClock, fakeSts, SyncingCore } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * The pairing-time attach, as a table (#564, R4 and R5 of the review of PR 634): every combination of the six facts
 * that can differ, the one action the Panel takes for it, and the invariant that holds in all of them: **neither side
 * ever deletes or empties data because the other side is missing or empty.** The table is in the PR body; this file
 * is that table, run against a Core that models the Core's sync (a key push runs a deleting pass, a detach only
 * copies, a fresh attach never deletes).
 *
 * Facts, per row:
 *   coreRow   `exists`: the machine's mount is this Core's own folder; `deleted`: it is mounted on the folder of an earlier
 *             Core, which was deleted (the new Core has a new id, so a new folder) and the Panel does not know that folder
 *   attached  the machine is still mounted at all
 *   key       valid or expired (only a mounted Core has one)
 *   s3        the folder the machine is mounted on holds its files, or was emptied (a delete)
 *   local     `~/shared` holds files, or is empty
 *   reachable the core-link is up
 *
 * Actions (what the Panel does, and the only things it does):
 *   not connected  send nothing; the Core stays pending.
 *   attach         `sharedAttach` to this Core's own folder: with no record the first pass copies and never deletes.
 *   detach, attach `sharedDetach` (a pull that copies S3 into the folder and deletes nothing), then `sharedAttach`.
 *   left as it is  `sharedDetach` was refused (the key has run out): stop. No key is ever sent to a Core that is still
 *                  attached, because a key makes it run a full pass and, with its folder emptied, it would delete its
 *                  own files. The Core stays pending, with the reason.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-attach-table-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { registerCoreFromCredential } = await import("../services/cores");
const { saveStorageConfig, storageKeyIssuer } = await import("../services/storage");
const { SharedFolders } = await import("../services/shared-folders");
const { findSharedFolder } = await import("../repositories/core-shared-folders.repo");

const BUCKET = "actana-shared";
const PREFIX = "cores";
const master = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FILES = ["a.txt", "b.txt"];

type Row = {
  coreRow: "exists" | "deleted";
  attached: boolean;
  key: "valid" | "expired";
  s3: "present" | "deleted";
  local: "contents" | "empty";
  reachable: boolean;
};
type Action = "not connected" | "attach" | "detach, attach" | "left as it is";

/** The table: the one correct action for a row. */
function actionFor(row: Row): Action {
  if (!row.reachable) return "not connected";
  if (!row.attached) return "attach";
  return row.key === "valid" ? "detach, attach" : "left as it is";
}

const rows: Row[] = [];
for (const coreRow of ["exists", "deleted"] as const)
  for (const attached of [true, false])
    for (const key of ["valid", "expired"] as const)
      for (const s3 of ["present", "deleted"] as const)
        for (const local of ["contents", "empty"] as const)
          for (const reachable of [true, false]) rows.push({ coreRow, attached, key, s3, local, reachable });

beforeEach(async () => {
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await saveStorageConfig({
    backend: "seaweedfs",
    endpoint: "http://seaweedfs.test:8333",
    bucket: BUCKET,
    prefix: PREFIX,
    oidcIssuer: "https://panel.test",
    keyId: "k1",
    masterKey: master.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
});
afterEach(async () => {
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let n = 0;
async function run(row: Row) {
  n += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://table-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { pendingSharedFolder: true },
  );
  const clock = new FakeClock();
  const fakeS3 = new FakeS3(BUCKET);
  fakeS3.clock = clock.now;
  const sts = fakeSts({ s3: fakeS3, masterPublic: master.publicKey, prefix: PREFIX, clock });

  const ownFolder = `${PREFIX}/${core.id}`;
  const mountedOn = row.coreRow === "exists" ? ownFolder : `${PREFIX}/core_earlier_deleted`;
  const world = new Map<string, string>();
  // Files the machine synced before, and what each side holds now.
  const hasRemote = row.s3 === "present";
  if (hasRemote) for (const f of FILES) world.set(`${mountedOn}/${f}`, f);
  // An unrelated Core's folder, which no row may touch.
  world.set(`${PREFIX}/core_unrelated/keep.txt`, "keep");
  const machine = new SyncingCore(world, row.local === "contents" ? FILES : [], ownFolder);
  if (row.attached) machine.attachedTo(mountedOn, FILES, row.key === "expired");

  const service = new SharedFolders({
    link: () => (row.reachable ? machine : null),
    isConnected: () => true,
    issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    retryDelaysMs: [5_000],
    requestTimeoutMs: 1_000,
    log: () => {},
    fetch: fakeS3.fetch,
  });

  const localBefore = new Set(machine.local);
  const worldBefore = new Map(world);
  let error: Error | null = null;
  try {
    await service.finishPairing(core.id);
  } catch (err) {
    error = err as Error;
  }
  const row_ = await findSharedFolder(1, core.id);
  return { core, machine, world, worldBefore, localBefore, error, state: row_?.state, ownFolder };
}

describe("the pairing-time attach, every row of the table", () => {
  it("has the 64 combinations of the six facts", () => {
    expect(rows).toHaveLength(64);
    expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(64);
  });

  it.each(rows.map((r) => [JSON.stringify(r), r] as const))("%s", async (_name, row) => {
    const out = await run(row);
    const action = actionFor(row);
    const types = out.machine.frames.map((f) => f.type);

    // The invariant, in every row: no file the machine held and no object in the world's S3 is gone afterwards.
    for (const name of out.localBefore) expect(out.machine.local?.has(name), `local ${name}`).toBe(true);
    for (const [key] of out.worldBefore) expect(out.world.has(key), `s3 ${key}`).toBe(true);
    // Another Core's folder is never touched, and no key is ever sent to a Core that is still attached.
    expect(out.world.get(`${PREFIX}/core_unrelated/keep.txt`)).toBe("keep");
    if (row.attached) expect(types).not.toContain("sharedCredentials");

    if (action === "not connected") {
      expect(types).toEqual([]);
      expect(out.error?.message).toMatch(/not connected/);
      expect(out.state).toBe("pending");
    } else if (action === "attach") {
      expect(types).toEqual(["sharedAttach"]);
      expect(out.error).toBeNull();
      expect(out.state).toBe("attached");
      expect(out.machine.mount).toBe(out.ownFolder);
    } else if (action === "detach, attach") {
      expect(types).toEqual(["sharedAttach", "sharedDetach", "sharedAttach"]);
      expect(out.error).toBeNull();
      expect(out.state).toBe("attached");
      expect(out.machine.mount).toBe(out.ownFolder);
    } else {
      expect(types).toEqual(["sharedAttach", "sharedDetach"]);
      expect(out.error?.message).toMatch(/still attached to a Shared folder from an earlier pairing/);
      expect(out.state).toBe("pending");
      // Left exactly as it was.
      expect(out.machine.mount).toBe(row.coreRow === "exists" ? out.ownFolder : `${PREFIX}/core_earlier_deleted`);
      expect(out.machine.local).toEqual(out.localBefore);
    }
  }, 30_000);
});
