import { generateKeyPairSync, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { generatePairingCode } from "@actana/shared/pairing-code";
import { derivePairingCodeKey, hashPairingCode } from "@actana/shared/pairing-store";
import { CORE_PAIRING_NAMES, composeCoreHttpRoutes } from "@actana/core/core-pairing-wiring";
import { corePairingStore } from "@actana/core/core-pairing-store";
import { createPairing } from "@actana/sdk/pairing/server";
import { fingerprintOf } from "@actana/sdk/pairing";
import { PtyCoreLinkServer } from "@actana/core/pty-core-link-server";
import type { PtyCore } from "@actana/core/pty-manager";
import type { EventLogPort } from "@actana/core/pty-core-link-server";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { FakeClock, FakeCoreLink, fakeSts } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * Pairing from the Panel ends with the Shared folder (#564), driven the way a browser drives it, against a real Core:
 * the Core's own `PtyCoreLinkServer` behind a real mTLS socket, redeeming a real pairing code, receiving the
 * Shared-folder frames over the real core-link. The key issuer is the real SDK one signing with the stored master
 * key; S3 and STS are in-memory fakes (the real SeaweedFS runs in `shared-folders-seaweedfs.test.ts`, in CI).
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-shared-pairing-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { resetCoreLinkManagerForTests } = await import("../services/core-link-manager");
const { registerCoreFromCredential } = await import("../services/cores");
const { SharedFolders, resetSharedFoldersForTests } = await import("../services/shared-folders");
const { storageKeyIssuer } = await import("../services/storage");

const ORIGIN = "http://panel.example.test";
const SECRET = "panel-shared-pairing-suite-secret-at-least-32-bytes";
const CORE_UUID = "5c1d0e72-4b3f-4a21-9d6c-8e2f3b5a7c01";
const BUCKET = "actana-shared";
const PREFIX = "cores";
const MASTER = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = MASTER.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const MASTER_BODY = MASTER_PEM.replace(/-----[A-Z ]+-----|\s/g, "");

async function call(pathname: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { cookie: await operatorSessionCookie() };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    }),
  );
  if (!response) throw new Error(`no API response for ${pathname}`);
  return response;
}

// ─── A real Core ──────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const { port } = address;
        probe.close(() => resolve(port));
      } else {
        probe.close();
        reject(new Error("no port"));
      }
    });
  });
}

function mockCore(): PtyCore {
  return {
    setEmitTarget: () => {},
    spawn: async () => ({ ptyId: "pty-1" }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    killLaunchProcesses: async () => ({ ptyCount: 0, ports: [] }),
    killPtysUnderPath: async () => ({ ptyCount: 0 }),
    findBySession: () => ({ ptyId: null }),
    sessionIdForPty: () => null,
    replay: () => ({ data: "", nextSeq: 0 }),
    killAll: () => {},
  } as unknown as PtyCore;
}

function emptyEventLog(): EventLogPort {
  return { appendEvent: () => 0, getLastEventId: () => 0, readEventTail: () => [] };
}


type Rig = {
  address: string;
  origin: string;
  fingerprint: string;
  core: FakeCoreLink;
  openSession(): Promise<{ sessionId: string; code: string }>;
};

const running: PtyCoreLinkServer[] = [];
const tempDirs: string[] = [];

async function startCore(opts: { announceShared?: boolean } = {}): Promise<Rig> {
  const material = await generateCertMaterial({ hosts: ["127.0.0.1"] });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-shared-pairing-"));
  tempDirs.push(dir);
  const store = corePairingStore(path.join(dir, "pairing.json"));
  const codeKey = derivePairingCodeKey(SECRET);
  const pairing = createPairing({
    store,
    material: {
      caCert: material.ca.cert,
      caKey: material.ca.key,
      serverCert: material.server.cert,
      serverKey: material.server.key,
      clientCert: material.client.cert,
      clientKey: material.client.key,
      bearerSecret: SECRET,
      coreId: "core_paired",
      coreUuid: CORE_UUID,
      serverHosts: ["127.0.0.1"],
    },
    endpointScheme: "wss",
    port,
    publicHosts: ["127.0.0.1"],
    names: CORE_PAIRING_NAMES,
    clientLabel: "session-or-client",
    onRevoked: () => {},
  });
  // The Core's side of the Shared folder: answers the three frames the way the Core's sync does, and keeps them.
  const core = new FakeCoreLink();
  const server = new PtyCoreLinkServer(mockCore(), {
    eventLog: emptyEventLog(),
    port,
    host: "127.0.0.1",
    tls: { caCert: material.ca.cert, serverCert: material.server.cert, serverKey: material.server.key },
    authVerifier: (bearer) => verifyBearer(bearer, SECRET),
    httpRoutes: composeCoreHttpRoutes(pairing.redeem),
    isPreAuthPath: pairing.gate.isPreAuthPath,
    ...(opts.announceShared === false
      ? {}
      : {
          shared: { version: 1, backend: "local" } as const,
          sharedPort: {
            handle: async (frame) => {
              const answer = await core.request(frame);
              if (answer.type !== "sharedStatus") throw new Error("unexpected answer");
              return answer.status;
            },
          },
        }),
  });
  running.push(server);
  await waitForListening(port, material.ca.cert);
  return {
    address: `127.0.0.1:${port}`,
    origin: `https://127.0.0.1:${port}`,
    fingerprint: fingerprintOf(new X509Certificate(material.ca.cert).raw),
    core,
    openSession: async () => {
      const code = generatePairingCode();
      const sessionId = `ps_${running.length}_${Date.now().toString(16)}`;
      await store.createSession({
        id: sessionId,
        label: "the-panel",
        codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
        now: Date.now(),
      });
      return { sessionId, code };
    },
  };
}

/**
 * Readiness, observed on a route that is not the pairing one — a probe there
 * would spend a rate-limit attempt before a test had started.
 */
async function waitForListening(port: number, caCert: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          { host: "127.0.0.1", port, path: "/healthz", method: "GET", ca: caCert, agent: false },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end();
      });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}


let clock: FakeClock;
let s3: FakeS3;
let logged: string[];

async function configureStorage(): Promise<void> {
  const res = await call("/api/storage", {
    method: "PUT",
    json: {
      backend: "seaweedfs",
      endpoint: "http://seaweedfs.test:8333",
      bucket: BUCKET,
      prefix: PREFIX,
      oidcIssuer: "https://panel.test",
      keyId: "k1",
      masterKey: MASTER_PEM,
    },
  });
  expect(res.status).toBe(200);
}

beforeEach(() => {
  resetOperatorSessionForTests();
  clock = new FakeClock();
  s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  const sts = fakeSts({ s3, masterPublic: MASTER.publicKey, prefix: PREFIX, clock });
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  resetSharedFoldersForTests(
    new SharedFolders({
      issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryDelaysMs: [5_000],
      fetch: s3.fetch,
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSharedFoldersForTests(null);
  resetCoreLinkManagerForTests();
  for (const server of running.splice(0)) server.close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  await resetPanelState(testDb);
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

type ListedCore = {
  id: string;
  dial: { state: string };
  sharedFolder?: { state: string; prefix: string | null; keyExpiresAt: number | null; error: string | null };
};

async function listed(): Promise<ListedCore[]> {
  return ((await (await call("/api/cores")).json()) as { cores: ListedCore[] }).cores;
}

/** Pair from the Panel (redeem step), and wait for the link: the Core is registered with its folder pending. */
async function pairedFromPanel(rig: Rig): Promise<string> {
  const { sessionId, code } = await rig.openSession();
  const res = await call("/api/cores/pairing", {
    method: "POST",
    json: { address: rig.address, code, sessionId, expectedFingerprint: rig.fingerprint, label: "workstation" },
  });
  expect(res.status).toBe(201);
  const { core } = (await res.json()) as { core: ListedCore };
  await vi.waitFor(async () => expect((await listed()).find((c) => c.id === core.id)?.dial.state).toBe("connected"), {
    timeout: 10_000,
  });
  // The ready frame with `shared` has arrived by the time the dial reports connected.
  return core.id;
}

describe("the last step of pairing", () => {
  it("leaves a Core paired from the Panel pending, and refuses to finish it without storage", async () => {
    const rig = await startCore();
    const id = await pairedFromPanel(rig);
    expect((await listed()).find((c) => c.id === id)?.sharedFolder).toEqual({
      state: "pending",
      prefix: null,
      keyExpiresAt: null,
      error: null,
    });

    const refused = await call(`/api/cores/${id}/pairing/finish`, { method: "POST", json: {} });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/Storage is not configured/);
    expect(rig.core.frames).toEqual([]);
    expect((await listed()).find((c) => c.id === id)?.sharedFolder?.state).toBe("pending");
  }, 40_000);

  it("attaches the Core's own folder over the real core-link and only then reports it paired", async () => {
    const rig = await startCore();
    const id = await pairedFromPanel(rig);
    await configureStorage();

    const tested = await call(`/api/cores/${id}/shared/test`, { method: "POST" });
    expect(tested.status).toBe(200);
    expect((await tested.json()).result).toMatchObject({ read: true, write: true, listOwn: true, reachOther: false });
    expect(rig.core.frames).toEqual([]);

    const finished = await call(`/api/cores/${id}/pairing/finish`, { method: "POST", json: {} });
    expect(finished.status).toBe(200);
    const { core } = (await finished.json()) as { core: ListedCore };
    expect(core.sharedFolder).toMatchObject({ state: "attached", prefix: `${PREFIX}/${id}/`, error: null });
    expect(core.sharedFolder!.keyExpiresAt).toBe(clock.now() + 3_600_000);

    expect(rig.core.frames.map((f) => f.type)).toEqual(["sharedAttach"]);
    expect(rig.core.ofType("sharedAttach")[0]).toMatchObject({ bucket: BUCKET, prefix: `${PREFIX}/${id}` });
    expect(rig.core.attached).toBe(true);
    expect((await listed()).find((c) => c.id === id)?.sharedFolder?.state).toBe("attached");
  }, 40_000);

  it("stays pending, with the reason, when the Core cannot mount a Shared folder", async () => {
    const rig = await startCore({ announceShared: false });
    const id = await pairedFromPanel(rig);
    await configureStorage();
    const res = await call(`/api/cores/${id}/pairing/finish`, { method: "POST", json: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cannot mount a Shared folder/);
    expect((await listed()).find((c) => c.id === id)?.sharedFolder?.state).toBe("pending");
  }, 40_000);

  it("does not ask a Core registered before 0.5.0 for storage: no folder, and nothing to finish", async () => {
    await operatorSessionCookie();
    const legacy = await registerCoreFromCredential({
      endpoint: "wss://legacy.test:7777",
      caCert: "ca",
      clientCert: "cert",
      clientKey: "key",
      bearer: "b",
    });
    expect((await listed()).find((c) => c.id === legacy.id)).not.toHaveProperty("sharedFolder");
    await configureStorage();
    expect((await call(`/api/cores/${legacy.id}/pairing/finish`, { method: "POST", json: {} })).status).toBe(404);
  });

  it("never lets the master key into a response, a log line or a frame the Core received", async () => {
    const rig = await startCore();
    const id = await pairedFromPanel(rig);
    await configureStorage();
    const texts: string[] = [];
    const take = async (res: Response) => void texts.push(await res.clone().text());
    await take(await call("/api/storage"));
    await take(await call(`/api/cores/${id}/shared/test`, { method: "POST" }));
    await take(await call(`/api/cores/${id}/pairing/finish`, { method: "POST", json: {} }));
    await take(await call("/api/cores"));
    await take(await call(`/api/cores/${id}`));
    await clock.advance(3 * 3_600_000);
    expect(rig.core.ofType("sharedCredentials").length).toBeGreaterThan(0);
    for (const text of [...texts, ...rig.core.wire, ...logged]) {
      expect(text).not.toContain(MASTER_BODY.slice(0, 40));
      expect(text).not.toContain("PRIVATE KEY");
    }
  }, 40_000);
});

async function attachedCore(rig: Rig): Promise<string> {
  const id = await pairedFromPanel(rig);
  await configureStorage();
  expect((await call(`/api/cores/${id}/pairing/finish`, { method: "POST", json: {} })).status).toBe(200);
  rig.core.frames.length = 0;
  rig.core.wire.length = 0;
  s3.requests.length = 0;
  return id;
}

describe("unpair", () => {
  it("sends sharedDetach, forgets the Core, and leaves the S3 prefix alone", async () => {
    const rig = await startCore();
    const id = await attachedCore(rig);
    s3.seed(`${PREFIX}/${id}/report.md`, "kept");

    const res = await call(`/api/cores/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(rig.core.ofType("sharedDetach")).toMatchObject([{ keepLocalCopy: true }]);
    expect(rig.core.attached).toBe(false);
    expect((await listed()).find((c) => c.id === id)).toBeUndefined();
    expect(s3.text(`${PREFIX}/${id}/report.md`)).toBe("kept");
    // No timer is left to push a key to a Core that was unpaired.
    expect(clock.delays()).toEqual([]);
  }, 40_000);

  it("still forgets a Core it could not tell, and says it could not", async () => {
    const rig = await startCore();
    const id = await attachedCore(rig);
    rig.core.failures = 1;
    const res = await call(`/api/cores/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ detached: false, detachError: expect.stringMatching(/./) });
    expect((await listed()).find((c) => c.id === id)).toBeUndefined();
  }, 40_000);
});

describe("delete", () => {
  function seedFolders(id: string): void {
    s3.seed(`${PREFIX}/${id}/a.txt`, "a");
    s3.seed(`${PREFIX}/${id}/sub/b.txt`, "b");
    s3.seed(`${PREFIX}/${id}/sub/deeper/c.txt`, "c");
    // Everything that is not this Core's folder, including names that merely start the same.
    s3.seed(`${PREFIX}/core_other/x.txt`, "other");
    s3.seed(`${PREFIX}/${id}-2/y.txt`, "lookalike");
    s3.seed(`${PREFIX}/${id}x/z.txt`, "lookalike");
    s3.seed(`${PREFIX}/${id}`, "a file named like the folder");
    s3.seed("readme.txt", "bucket root");
    s3.seed(`other-prefix/${id}/w.txt`, "same id under another prefix");
  }

  it("asks for the exact prefix, and removes nothing for anything else", async () => {
    const rig = await startCore();
    const id = await attachedCore(rig);
    seedFolders(id);
    const before = [...s3.objects.keys()].sort();

    for (const confirmPrefix of ["", id, `${PREFIX}/${id}`, `${PREFIX}/${id}/ `, `${PREFIX}/`, `${PREFIX}/${id}-2/`]) {
      const res = await call(`/api/cores/${id}/delete`, { method: "POST", json: { confirmPrefix } });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain(`${PREFIX}/${id}/`);
    }
    expect((await listed()).find((c) => c.id === id)).toBeDefined();
    expect([...s3.objects.keys()].sort()).toEqual(before);
    expect(s3.requests.filter((q) => q.method === "DELETE")).toEqual([]);
    expect(rig.core.frames).toEqual([]);
  }, 40_000);

  it("removes the Core, then exactly its own prefix and not one object more", async () => {
    const rig = await startCore();
    const id = await attachedCore(rig);
    seedFolders(id);
    s3.requests.length = 0;

    const res = await call(`/api/cores/${id}/delete`, { method: "POST", json: { confirmPrefix: `${PREFIX}/${id}/` } });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { prefix: string; removed: number };
    expect(answer.prefix).toBe(`${PREFIX}/${id}/`);
    expect(answer.removed).toBeGreaterThan(0);

    expect((await listed()).find((c) => c.id === id)).toBeUndefined();
    expect([...s3.objects.keys()].sort()).toEqual(
      [
        "readme.txt",
        `${PREFIX}/${id}`,
        `${PREFIX}/${id}-2/y.txt`,
        `${PREFIX}/${id}x/z.txt`,
        `${PREFIX}/core_other/x.txt`,
        `other-prefix/${id}/w.txt`,
      ].sort(),
    );
    const deletes = s3.requests.filter((q) => q.method === "DELETE");
    expect(deletes.length).toBeGreaterThan(0);
    for (const q of deletes) expect(q.key.startsWith(`${PREFIX}/${id}/`)).toBe(true);
    // The Core stopped syncing and kept its files.
    expect(rig.core.ofType("sharedDetach")).toMatchObject([{ keepLocalCopy: true }]);
    expect(clock.delays()).toEqual([]);
    // It is gone: the same request again finds nothing.
    expect((await call(`/api/cores/${id}/delete`, { method: "POST", json: { confirmPrefix: `${PREFIX}/${id}/` } })).status).toBe(404);
  }, 40_000);

  it("says which prefix it could not empty when S3 refuses, after the Core is already gone", async () => {
    const rig = await startCore();
    const id = await attachedCore(rig);
    seedFolders(id);
    const real = s3.fetch;
    const failing: typeof fetch = async (input, init) =>
      (init?.method ?? "GET").toUpperCase() === "DELETE"
        ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 })
        : real(input, init);
    resetSharedFoldersForTests(
      new SharedFolders({
        issuer: (o) => storageKeyIssuer(o, { fetch: fakeSts({ s3, masterPublic: MASTER.publicKey, prefix: PREFIX, clock }).fetch, now: clock.now }),
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        fetch: failing,
      }),
    );
    const res = await call(`/api/cores/${id}/delete`, { method: "POST", json: { confirmPrefix: `${PREFIX}/${id}/` } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(`${PREFIX}/${id}/`);
    expect((await listed()).find((c) => c.id === id)).toBeUndefined();
    expect(logged.join("\n")).toContain(`could not empty ${PREFIX}/${id}/`);
  }, 40_000);
});
