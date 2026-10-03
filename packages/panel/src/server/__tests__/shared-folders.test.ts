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
const { getCore } = await import("../services/cores");
const { coreLinkManager } = await import("../services/core-link-manager");

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
  const machine: {
    calls: Array<{ coreId: string; registered: boolean; frames: string[] }>;
    result: { state: "emptied"; removed: number } | { state: "kept"; reason: string; removed: number };
    throws: string | null;
    /** Runs while the machine's folder is being emptied: the window between the detach and the Core's removal. */
    during: (() => Promise<void>) | null;
  } = { calls: [], result: { state: "emptied", removed: 2 }, throws: null, during: null };
  const service = new SharedFolders({
    link: () => (online.value ? link : null),
    isConnected: () => online.value,
    emptyMachineFolder: async (id) => {
      // Recorded with whether the Core was still registered: its credentials go with its row.
      machine.calls.push({ coreId: id, registered: (await getCore(id)) !== null, frames: link.frames.map((f) => f.type) });
      if (machine.during) await machine.during();
      if (machine.throws) throw new Error(machine.throws);
      return machine.result;
    },
    issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    retryDelaysMs: [5_000, 15_000, 60_000],
    requestTimeoutMs: 1_000,
    log: (m) => logs.push(m),
    fetch: s3.fetch,
  });
  return { clock, s3, sts, link, logs, service, online, machine };
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
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedAttach", "sharedDetach", "sharedAttach"]);
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
  it("is not given a key and is left as it is: a key would make it sync", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    // Unpaired while unreachable, then paired again more than an hour later: still mounted, key long gone.
    r.link.attached = true;
    r.link.expired = true;
    await expect(r.service.finishPairing(coreId)).rejects.toThrow(/still attached to a Shared folder from an earlier pairing/);
    // Asked to let go, refused for its key, and nothing else was sent: above all no sharedCredentials.
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedAttach", "sharedDetach"]);
    expect(r.link.attached).toBe(true);
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

    // Past the key the Panel had confirmed but before the one the Core holds: not "run out". The Core is connected and
    // does not answer the detach, so it may still be syncing.
    await r.clock.advance(20 * MINUTE);
    r.link.failures = 1;
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

  it("keeps everything when the Core is not connected and its key is live: its own sync would mirror the purge", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    r.online.value = false;
    await refused(r, coreId);
    expect(r.machine.calls).toEqual([]);
  });

  it("finishes on the Panel once the key has run out, and says the machine's folder was kept and why", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    r.online.value = false;
    await r.clock.advance(61 * MINUTE);
    await settle();
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result).toMatchObject({ prefix: `${PREFIX}/${coreId}/`, machineFolder: { state: "kept", removed: 0 } });
    expect(result.machineFolder.state === "kept" && result.machineFolder.reason).toMatch(/could not be reached.*key has run out/);
    expect(r.machine.calls).toEqual([]);
    expect(await getCore(coreId)).toBeNull();
    expect([...r.s3.objects.keys()]).toEqual([]);
    expect(r.logs.some((m) => m.includes("~/shared on the machine was kept"))).toBe(true);
  });

  it("names a refusal accurately for a connected Core whose key has run out", async () => {
    const r = await rig();
    const coreId = await attachedWithFiles(r);
    // Its key runs out while the link is down; it is then back, and refuses the detach for the expired key.
    r.online.value = false;
    await r.clock.advance(61 * MINUTE);
    await settle();
    r.online.value = true;
    r.link.answer = { state: "error", code: "mount-failed", message: "the key has expired" };
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result.machineFolder.state === "kept" && result.machineFolder.reason).toMatch(/did not let go of S3 \(mount-failed: the key has expired\), and its key has run out/);
    expect(r.machine.calls).toEqual([]);
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

describe("delete empties the machine's Shared folder (ADR 0041 D12, D38)", () => {
  async function attached(r: Awaited<ReturnType<typeof rig>>) {
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.s3.seed(`${PREFIX}/${coreId}/a.txt`, "a");
    return coreId;
  }

  it("asks the Core to detach, then empties its folder while the Core is still registered, then S3", async () => {
    const r = await rig();
    const coreId = await attached(r);
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result).toEqual({ prefix: `${PREFIX}/${coreId}/`, removed: 1, machineFolder: { state: "emptied", removed: 2 } });
    // One call, for this Core, after the detach, before its credentials went with the row.
    expect(r.machine.calls).toEqual([{ coreId, registered: true, frames: ["sharedAttach", "sharedDetach"] }]);
    expect(await getCore(coreId)).toBeNull();
    expect([...r.s3.objects.keys()]).toEqual([]);
  });

  it("does it for a Core whose folder was never attached (a pending pairing)", async () => {
    const r = await rig();
    const coreId = await pairedCore();
    const result = await r.service.deleteCore(coreId, coreId);
    expect(result.machineFolder).toEqual({ state: "emptied", removed: 2 });
    expect(r.machine.calls).toHaveLength(1);
  });

  it("is not done by unpair: the machine keeps ~/shared and its contents", async () => {
    const r = await rig();
    const coreId = await attached(r);
    expect(await r.service.detach(coreId)).toEqual({ detached: true });
    expect(r.machine.calls).toEqual([]);
  });

  it("is not asked of a Core that refused the detach: nothing is removed and the machine is untouched", async () => {
    const r = await rig();
    const coreId = await attached(r);
    r.link.answer = { state: "error", code: "mount-failed", message: "could not copy S3 into the folder" };
    await expect(r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`)).rejects.toMatchObject({ code: "still-attached" });
    expect(r.machine.calls).toEqual([]);
    expect(await getCore(coreId)).not.toBeNull();
  });

  it("is not asked of a Core whose link dropped after the detach, and the delete still finishes", async () => {
    const r = await rig();
    const coreId = await attached(r);
    // Answered the detach, then the link went away before the Files request.
    const original = r.link.request;
    r.link.request = async (frame) => {
      const answer = await original(frame);
      if (frame.type === "sharedDetach") r.online.value = false;
      return answer;
    };
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result.machineFolder).toEqual({ state: "kept", reason: "the Core is not connected", removed: 0 });
    expect(r.machine.calls).toEqual([]);
    expect(await getCore(coreId)).toBeNull();
  });

  it("finishes and reports what stayed when the folder could not be emptied", async () => {
    const r = await rig();
    const coreId = await attached(r);
    r.machine.result = { state: "kept", reason: "~/shared on the machine is a symlink, not a folder, so it was left alone", removed: 0 };
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result.machineFolder).toMatchObject({ state: "kept", removed: 0 });
    expect(await getCore(coreId)).toBeNull();
    expect([...r.s3.objects.keys()]).toEqual([]);
  });

  it("finishes when asking the Core's Files API throws", async () => {
    const r = await rig();
    const coreId = await attached(r);
    r.machine.throws = "socket hang up";
    const result = await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(result.machineFolder).toEqual({ state: "kept", reason: "socket hang up", removed: 0 });
    expect(await getCore(coreId)).toBeNull();
  });

  it("still needs the typed prefix: nothing is touched on a wrong confirmation", async () => {
    const r = await rig();
    const coreId = await attached(r);
    await expect(r.service.deleteCore(coreId, "nope")).rejects.toMatchObject({ code: "confirmation" });
    expect(r.machine.calls).toEqual([]);
    expect(r.link.ofType("sharedDetach")).toHaveLength(0);
  });
});

describe("delete and unpair stop key pushes before the Core is told to let go (#564)", () => {
  async function attached(r: Awaited<ReturnType<typeof rig>>) {
    const coreId = await pairedCore();
    await r.service.finishPairing(coreId);
    r.s3.seed(`${PREFIX}/${coreId}/a.txt`, "a");
    return coreId;
  }
  /** What the Core received after the detach: nothing, or the Core was handed a key while it was being deleted. */
  const after = (r: Awaited<ReturnType<typeof rig>>) => {
    const types = r.link.frames.map((f) => f.type);
    return types.slice(types.indexOf("sharedDetach") + 1);
  };
  /** Hold the next `sharedCredentials` before the Core sees it, as a push already in flight is. */
  function holdNextCredentials(r: Awaited<ReturnType<typeof rig>>) {
    const real = r.link.request;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    r.link.request = async (frame) => {
      if (frame.type === "sharedCredentials" && !held) {
        held = true;
        await gate;
      }
      return real(frame);
    };
    return { release, wasHeld: () => held };
  }
  const connect = (coreId: string) =>
    (coreLinkManager() as unknown as { set(id: string, s: { coreId: string; state: "connected"; lastSeenAt: number }): void }).set(coreId, {
      coreId,
      state: "connected",
      lastSeenAt: 1,
    });

  it("does not let a scheduled refresh re-attach the Core while its folder is being emptied", async () => {
    const r = await rig();
    const coreId = await attached(r);
    r.machine.during = async () => {
      await r.clock.advance(45 * MINUTE);
      await settle();
    };
    await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    expect(r.machine.calls).toHaveLength(1);
    expect(after(r)).toEqual([]);
    expect(r.link.attached).toBe(false);
    expect(r.clock.delays()).toEqual([]);
  });

  it("does not let a refresh on reconnect re-attach the Core while its folder is being emptied", async () => {
    const r = await rig();
    const coreId = await attached(r);
    const stop = await r.service.start();
    await settle();
    r.link.frames.length = 0;
    r.link.attached = true;
    r.machine.during = async () => {
      connect(coreId);
      await settle();
    };
    await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    stop();
    expect(r.machine.calls).toHaveLength(1);
    expect(r.link.frames.map((f) => f.type)).toEqual(["sharedDetach"]);
    expect(r.link.attached).toBe(false);
    expect(r.clock.delays()).toEqual([]);
  });

  it("does not let a push already in flight re-attach the Core, nor re-arm its timer", async () => {
    const r = await rig();
    const coreId = await attached(r);
    const held = holdNextCredentials(r);
    await r.clock.advance(45 * MINUTE);
    expect(held.wasHeld()).toBe(true);
    r.machine.during = async () => {
      held.release();
      await settle();
    };
    await r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`);
    await settle();
    expect(after(r)).toEqual(["sharedCredentials"]);
    expect(r.link.attached).toBe(false);
    expect(r.clock.delays()).toEqual([]);
    expect(await findSharedFolder(1, coreId)).toBeNull();
  });

  it("does the same for unpair: a refresh in flight cannot re-attach the Core that was told to leave", async () => {
    const r = await rig();
    const coreId = await attached(r);
    const held = holdNextCredentials(r);
    await r.clock.advance(45 * MINUTE);
    expect(held.wasHeld()).toBe(true);
    const unpair = r.service.detach(coreId);
    await settle();
    held.release();
    await unpair;
    await settle();
    expect(after(r)).toEqual(["sharedCredentials"]);
    expect(r.link.attached).toBe(false);
    expect(r.clock.delays()).toEqual([]);
  });

  it("keeps the Core's key fresh again when the delete is refused with 409", async () => {
    const r = await rig();
    const coreId = await attached(r);
    r.link.failures = 1;
    await expect(r.service.deleteCore(coreId, `${PREFIX}/${coreId}/`)).rejects.toMatchObject({ code: "still-attached" });
    r.link.frames.length = 0;
    await r.clock.advance(0);
    expect(r.link.ofType("sharedCredentials")).toHaveLength(1);
    expect(r.link.attached).toBe(true);
    expect(r.clock.delays().length).toBe(1);
  });
});
