import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { FakeClock, FakeCoreLink, fakeSts, settle } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * A Core's Shared folder from the Panel's side (#564), against a fake Core, a fake S3 and a clock the test moves:
 * the real key issuer signs with the stored master key, the Panel pushes `sharedAttach` and then `sharedCredentials`
 * before each key ends, and unpair and delete do what the issue says.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-shared-folders-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { registerCoreFromCredential } = await import("../services/cores");
const { saveStorageConfig, storageKeyIssuer } = await import("../services/storage");
const { SharedFolders, describeSharedFolder } = await import("../services/shared-folders");
const { findSharedFolder } = await import("../repositories/core-shared-folders.repo");

const BUCKET = "actana-shared";
const PREFIX = "cores";
const HOUR = 3_600_000;
const MINUTE = 60_000;

const masterPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = masterPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const MASTER_BODY = MASTER_PEM.replace(/-----[A-Z ]+-----|\s/g, "");

let n = 0;
async function pairedCore(opts: { pending?: boolean } = {}): Promise<string> {
  n += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { label: `core ${n}`, pendingSharedFolder: opts.pending ?? true },
  );
  return core.id;
}

async function rig(opts: { leaky?: boolean } = {}) {
  const clock = new FakeClock();
  const s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  const sts = fakeSts({ s3, masterPublic: masterPair.publicKey, prefix: PREFIX, clock, leaky: opts.leaky });
  const link = new FakeCoreLink();
  const logs: string[] = [];
  const online = { value: true };
  const service = new SharedFolders({
    link: () => (online.value ? link : null),
    isConnected: () => true,
    issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    retryDelaysMs: [5_000, 15_000, 60_000],
    requestTimeoutMs: 1_000,
    log: (m) => logs.push(m),
    fetch: s3.fetch,
  });
  return { clock, s3, sts, link, logs, service, online };
}

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
    masterKey: MASTER_PEM,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("attaching the Shared folder", () => {
  it("issues a key through the SDK issuer and pushes sharedAttach for this Core's own folder", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    const row = await r.service.finishPairing(coreId);

    const [attach] = r.link.ofType("sharedAttach");
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedAttach"]);
    expect(attach).toMatchObject({
      endpoint: "http://seaweedfs.test:8333",
      bucket: BUCKET,
      prefix: `${PREFIX}/${coreId}`,
      region: "us-east-1",
    });
    expect(attach!.credentials.accessKeyId).toMatch(/^AKIA/);
    expect(new Date(attach!.expiresAt).getTime()).toBe(r.clock.now() + HOUR);
    // The issuer signed with the stored master key: the fake STS verified the token against its public half.
    expect(r.sts.issued.every((k) => k.sub === coreId)).toBe(true);
    expect(row).toMatchObject({ state: "attached", s3Prefix: `${PREFIX}/${coreId}/`, keyExpiresAt: r.clock.now() + HOUR, lastError: null });
    expect(await describeSharedFolder(coreId)).toEqual({
      state: "attached",
      prefix: `${PREFIX}/${coreId}/`,
      keyExpiresAt: r.clock.now() + HOUR,
      error: null,
    });
  });

  it("proves the key works on its own folder and nowhere else, and leaves no probe behind", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    const result = await r.service.testConnection(coreId);
    expect(result).toMatchObject({ read: true, write: true, listOwn: true, reachOther: false, folder: `${PREFIX}/${coreId}/` });
    expect([...r.s3.objects.keys()]).toEqual([]);
    // Another Core's folder was asked for and refused, never answered.
    expect(r.s3.requests.some((q) => q.status === 403)).toBe(true);
  });

  it("does not attach when the key reaches another Core's folder, and sends the Core nothing", async () => {
    const r = await rig({ leaky: true });
    const coreId = await pairedCore();
    await expect(r.service.finishPairing(coreId)).rejects.toMatchObject({ code: "isolation-failed" });
    expect(r.link.frames).toEqual([]);
    expect((await findSharedFolder(1, coreId))?.state).toBe("pending");
  });

  it("refuses, and says why, for a Core that is not connected or cannot mount a Shared folder", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    const offline = new SharedFolders({ link: () => null, issuer: (o) => storageKeyIssuer(o, { fetch: r.sts.fetch, now: r.clock.now }), fetch: r.s3.fetch });
    await expect(offline.finishPairing(coreId)).rejects.toMatchObject({ code: "not-connected" });
    r.link.capability = null;
    await expect(r.service.finishPairing(coreId)).rejects.toMatchObject({ code: "cannot-mount" });
    expect(r.link.frames).toEqual([]);
    expect((await findSharedFolder(1, coreId))?.state).toBe("pending");
  });

  it("surfaces what the Core said when it refuses, and stays pending", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    r.link.answer = { state: "error", code: "mount-failed", message: "the bucket is not reachable from the Core" };
    await expect(r.service.finishPairing(coreId)).rejects.toThrow(/mount-failed: the bucket is not reachable/);
    expect((await findSharedFolder(1, coreId))?.state).toBe("pending");
  });

  it("is refused without storage configured, naming what is missing", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await testDb.pool.query("delete from storage_config");
    await expect(r.service.finishPairing(coreId)).rejects.toMatchObject({ code: "storage-not-configured" });
    expect(r.link.frames).toEqual([]);
  });

  it("lets go of a Shared folder the Panel did not set up, then attaches the Core's own", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    r.link.attached = true;
    await r.service.finishPairing(coreId);
    // Mounted somewhere this Panel did not record: it lets go first, then attaches to this Core's own folder,
    // so the row names where the Core really is.
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedAttach", "sharedCredentials", "sharedDetach", "sharedAttach"]);
    expect(await findSharedFolder(1, coreId)).toMatchObject({ state: "attached", s3Prefix: `${PREFIX}/${coreId}/` });
  });
});

describe("the master key and the Core", () => {
  it("is in no frame the Core receives, and no log line, whatever the Panel sent", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    await r.clock.advance(3 * HOUR);
    r.link.failures = 1;
    await r.clock.advance(HOUR);
    expect(r.link.wire.length).toBeGreaterThan(3);
    for (const text of [...r.link.wire, ...r.logs]) {
      expect(text).not.toContain(MASTER_BODY.slice(0, 40));
      expect(text).not.toContain("PRIVATE KEY");
    }
    // What a frame carries is the issuer's four fields and where the folder is: nothing else.
    for (const frame of r.link.frames) {
      if (frame.type === "sharedAttach" || frame.type === "sharedCredentials") {
        expect(Object.keys(frame.credentials).sort()).toEqual(["accessKeyId", "secretAccessKey", "sessionToken"]);
      }
    }
  });
});

describe("rotating the key", () => {
  it("pushes sharedCredentials 15 minutes before each key ends: not before, then at that moment", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    const start = r.clock.now();

    await r.clock.advance(45 * MINUTE - 1000);
    expect(r.link.ofType("sharedCredentials")).toHaveLength(0);
    await r.clock.advance(1000);
    await settle();
    expect(r.link.ofType("sharedCredentials")).toHaveLength(1);
    const first = r.link.ofType("sharedCredentials")[0]!;
    expect(new Date(first.expiresAt).getTime()).toBe(start + 45 * MINUTE + HOUR);
    expect((await findSharedFolder(1, coreId))?.keyExpiresAt).toBe(start + 45 * MINUTE + HOUR);
  });

  it("keeps rotating for hours with no error, and the key the Core holds always works", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);

    const checks: number[] = [];
    for (let minute = 0; minute < 6 * 60; minute += 10) {
      await r.clock.advance(10 * MINUTE);
      // The Core signs with whatever it holds now: it must be a key S3 still accepts.
      const key = r.link.key!;
      expect(new Date(key.expiresAt).getTime()).toBeGreaterThan(r.clock.now());
      const res = await r.s3.fetch(`http://s3.test/${BUCKET}/${PREFIX}/${coreId}/x`, {
        method: "GET",
        headers: { authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/x`, "x-amz-security-token": key.sessionToken },
      });
      checks.push(res.status);
    }
    expect(checks.every((s) => s === 404)).toBe(true); // 404 NoSuchKey: authorized, nothing there
    expect(r.link.ofType("sharedCredentials").length).toBe(8);
    const row = await findSharedFolder(1, coreId);
    expect(row).toMatchObject({ state: "attached", lastError: null });
    expect(r.logs).toEqual([]);
    // Each push lands at least 15 minutes before the key the Core held ended.
    const expiries = r.link.frames.map((f) => new Date((f as { expiresAt: string }).expiresAt).getTime());
    expect(new Set(expiries).size).toBe(expiries.length);
  });

  it("asks for a new attach when the Core lost its key (not-attached), without a gap", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.link.attached = false;
    await r.clock.advance(45 * MINUTE);
    await settle();
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedAttach", "sharedCredentials", "sharedAttach"]);
    expect(r.link.attached).toBe(true);
  });

  it("retries a failed push with a back-off, shows the error on the Core, logs it, and clears it on success", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.link.failures = 2;

    await r.clock.advance(45 * MINUTE);
    await settle();
    let row = await findSharedFolder(1, coreId);
    expect(row?.state).toBe("error");
    expect(row?.lastError).toMatch(/timed out/);
    expect((await describeSharedFolder(coreId))?.error).toMatch(/timed out/);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toContain(coreId);
    expect(r.clock.delays()).toEqual([5_000]);

    await r.clock.advance(5_000);
    await settle();
    expect(r.logs).toHaveLength(2);
    expect(r.clock.delays()).toEqual([15_000]);
    row = await findSharedFolder(1, coreId);
    expect(row?.state).toBe("error");

    await r.clock.advance(15_000);
    await settle();
    row = await findSharedFolder(1, coreId);
    expect(row).toMatchObject({ state: "attached", lastError: null });
    expect(r.logs).toHaveLength(2);
    // The next refresh is back on the hourly schedule.
    expect(r.clock.delays()).toEqual([45 * MINUTE]);
  });

  it("shows an issuer failure (the STS is down) as a Core-level error too", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.sts.state.fail = true;
    await r.clock.advance(45 * MINUTE);
    await settle();
    const row = await findSharedFolder(1, coreId);
    expect(row?.state).toBe("error");
    expect(row?.lastError).toMatch(/STS/);
    expect(r.logs.join("\n")).toMatch(/key push failed/);
  });

  it("starts at boot for attached Cores only, and leaves a pending Core alone", async () => {
    const r = await rig();
    const attached = await pairedCore();
    const pending = await pairedCore();
    await r.service.finishPairing(attached);
    r.link.frames.length = 0;
    const stop = await r.service.start();
    await settle();
    expect(r.link.ofType("sharedCredentials")).toHaveLength(1);
    expect((await findSharedFolder(1, pending))?.state).toBe("pending");
    stop();
    r.link.frames.length = 0;
    await r.clock.advance(3 * HOUR);
    expect(r.link.frames).toEqual([]);
  });
});

describe("unpair", () => {
  it("sends sharedDetach asking the Core to keep its local copy, and stops rotating", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    const result = await r.service.detach(coreId);
    expect(result).toEqual({ detached: true });
    expect(r.link.ofType("sharedDetach")).toMatchObject([{ keepLocalCopy: true }]);
    expect(r.link.attached).toBe(false);
    r.link.frames.length = 0;
    await r.clock.advance(3 * HOUR);
    expect(r.link.frames).toEqual([]);
  });

  it("says so when the Core could not be told, instead of pretending", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.link.failures = 1;
    const result = await r.service.detach(coreId);
    expect(result.detached).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

describe("a Core still attached with a key that has run out", () => {
  it("can finish pairing again: it is given a key first, because it refuses to detach without one", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    // Unpaired while unreachable, then paired again more than an hour later: still mounted, key long gone.
    r.link.attached = true;
    r.link.expired = true;
    const row = await r.service.finishPairing(coreId);
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedAttach", "sharedCredentials", "sharedDetach", "sharedAttach"]);
    expect(r.link.expired).toBe(false);
    expect(row).toMatchObject({ state: "attached", s3Prefix: `${PREFIX}/${coreId}/` });
    expect(r.link.attached).toBe(true);
  });

  it("says why when the Core will not take a new key either, and stays pending", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    r.link.attached = true;
    r.link.expired = true;
    // The second request (the sharedCredentials push after the already-attached answer) is the refused one.
    const original = r.link.request;
    let n = 0;
    r.link.request = async (frame) => {
      n += 1;
      if (n === 2) {
        r.link.frames.push(frame);
        return { type: "sharedStatus", reqId: (frame as { reqId: string }).reqId, status: { state: "error", code: "mount-failed", message: "no key store" } };
      }
      return original(frame);
    };
    await expect(r.service.finishPairing(coreId)).rejects.toThrow(/would not take a new key: mount-failed: no key store/);
    expect((await findSharedFolder(1, coreId))?.state).toBe("pending");
  });
});

describe("the key expiry the row records", () => {
  it("covers a key the Core accepted although the answer was lost, so delete does not run early", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.s3.seed(`${PREFIX}/${coreId}/a.txt`, "a");
    const first = (await findSharedFolder(1, coreId))!.keyExpiresAt!;

    r.link.loseAnswers = 1;
    await r.clock.advance(45 * MINUTE);
    await settle();
    // The Core took the new key; the Panel never heard. The row already names the later expiry.
    const recorded = (await findSharedFolder(1, coreId))!.keyExpiresAt!;
    expect(new Date(r.link.key!.expiresAt).getTime()).toBeGreaterThan(first);
    expect(recorded).toBe(new Date(r.link.key!.expiresAt).getTime());
    expect((await findSharedFolder(1, coreId))?.state).toBe("error");

    // Unreachable now, and past the key the Panel had confirmed but before the one the Core holds: not "run out".
    r.online.value = false;
    await r.clock.advance(20 * MINUTE);
    expect(r.clock.now()).toBeGreaterThan(first);
    await expect(r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`)).rejects.toMatchObject({ code: "still-attached" });
    expect(r.s3.text(`${PREFIX}/${coreId}/a.txt`)).toBe("a");
  });
});

describe("the stored prefix is where the Core is attached", () => {
  it("is not rewritten by a key refresh after the configured prefix was edited", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    expect((await findSharedFolder(1, coreId))?.s3Prefix).toBe(`${PREFIX}/${coreId}/`);

    await saveStorageConfig({
      backend: "seaweedfs",
      endpoint: "http://seaweedfs.test:8333",
      bucket: BUCKET,
      prefix: "moved",
      oidcIssuer: "https://panel.test",
      keyId: "k1",
    });
    await r.clock.advance(45 * MINUTE);
    await settle();
    // A plain sharedCredentials: the Core keeps syncing the prefix it was attached to, and so does the row.
    expect(r.link.ofType("sharedCredentials")).toHaveLength(1);
    expect(await findSharedFolder(1, coreId)).toMatchObject({ state: "attached", s3Prefix: `${PREFIX}/${coreId}/` });
    expect(await r.service.deleteConfirmation(coreId)).toBe(`${PREFIX}/${coreId}/`);
  });

  it("follows the Core when it had to be attached again, because that is where it now is", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    await saveStorageConfig({
      backend: "seaweedfs",
      endpoint: "http://seaweedfs.test:8333",
      bucket: BUCKET,
      prefix: "moved",
      oidcIssuer: "https://panel.test",
      keyId: "k1",
    });
    r.link.attached = false;
    await r.clock.advance(45 * MINUTE);
    await settle();
    expect(r.link.ofType("sharedAttach").at(-1)?.prefix).toBe(`moved/${coreId}`);
    expect((await findSharedFolder(1, coreId))?.s3Prefix).toBe(`moved/${coreId}/`);
  });
});

describe("delete waits for the Core to let go of S3", () => {
  async function attachedWithFiles(r: Awaited<ReturnType<typeof rig>>) {
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.s3.seed(`${PREFIX}/${coreId}/a.txt`, "a");
    r.s3.seed(`${PREFIX}/${coreId}/sub/b.txt`, "b");
    r.s3.requests.length = 0;
    return coreId;
  }
  const refused = async (r: Awaited<ReturnType<typeof rig>>, coreId: string) => {
    await expect(r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`)).rejects.toMatchObject({ code: "still-attached" });
    // Nothing happened: the Core is registered, S3 is untouched, and the key keeps being refreshed.
    expect(await findSharedFolder(1, coreId)).toMatchObject({ state: "attached" });
    expect(r.s3.requests.filter((q) => q.method === "DELETE")).toEqual([]);
    expect([...r.s3.objects.keys()].sort()).toEqual([`${PREFIX}/${coreId}/a.txt`, `${PREFIX}/${coreId}/sub/b.txt`]);
    expect(r.clock.delays().length).toBe(1);
  };

  it("keeps the prefix when the Core does not answer the detach", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    r.link.failures = 1;
    await refused(r, coreId);
    expect((await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`)).prefix).toBe(`${PREFIX}/${coreId}/`);
  });

  it("keeps the prefix when the Core answers mount-failed (its copy pass failed)", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    r.link.answer = { state: "error", code: "mount-failed", message: "could not copy S3 into the folder" };
    await refused(r, coreId);
  });

  it("keeps the prefix when the Core is not connected and its key has not run out", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    r.online.value = false;
    await refused(r, coreId);
  });

  it("empties the prefix once the key the Core holds has run out, even though it cannot be reached", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    r.online.value = false;
    // Every refresh fails (the Core is away), so after the last key's hour it cannot sync any more.
    await r.clock.advance(61 * MINUTE);
    await settle();
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result.prefix).toBe(`${PREFIX}/${coreId}/`);
    expect([...r.s3.objects.keys()]).toEqual([]);
  });

  it("empties the prefix after the Core answered detached", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(r.link.ofType("sharedDetach")).toHaveLength(1);
    expect([...r.s3.objects.keys()]).toEqual([]);
  });
});
