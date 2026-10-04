import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { FakeClock, FakeCoreLink, fakeSts, settle } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * The storage config and its master key (#564 / #566): the key goes in through one write-only route, is sealed at
 * rest, and comes out of nowhere: not a route, not a log line, not an error message. Rotate re-issues Core keys;
 * Settings › Storage test-connection uses the same isolation probe as pairing, against a fake S3 here.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-storage-config-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { registerCoreFromCredential } = await import("../services/cores");
const { SharedFolders, resetSharedFoldersForTests, sharedFolders } = await import("../services/shared-folders");
const { storageKeyIssuer } = await import("../services/storage");

const ORIGIN = "http://panel.example.test";
const BUCKET = "actana-shared";
const PREFIX = "cores";

const masterPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = masterPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function pem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
/** The key's base64 body: what would show in any output that carried the key. */
function body(key: string): string {
  return key.replace(/-----[A-Z ]+-----|\s/g, "");
}

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

const CONFIG = {
  backend: "seaweedfs",
  endpoint: "http://seaweedfs:8333",
  bucket: BUCKET,
  prefix: "cores/",
  oidcIssuer: "https://panel.example.test",
  keyId: "k1",
};

let logged: string[];
let clock: FakeClock;
let s3: FakeS3;
let link: FakeCoreLink;
let online: { value: boolean };
let coreN = 0;

beforeEach(() => {
  resetOperatorSessionForTests();
  logged = [];
  clock = new FakeClock();
  s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  link = new FakeCoreLink();
  online = { value: true };
  const sts = fakeSts({ s3, masterPublic: masterPair.publicKey, prefix: PREFIX, clock });
  resetSharedFoldersForTests(
    new SharedFolders({
      link: () => (online.value ? link : null),
      isConnected: () => online.value,
      issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryDelaysMs: [5_000],
      requestTimeoutMs: 1_000,
      fetch: s3.fetch,
    }),
  );
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(Object(a))))).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSharedFoldersForTests(null);
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function attachedCore(): Promise<string> {
  coreN += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://core-storage-${coreN}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { label: `storage core ${coreN}`, pendingSharedFolder: true },
  );
  await sharedFolders().finishPairing(core.id);
  return core.id;
}
describe("the storage config", () => {
  it("is empty until it is set", async () => {
    const { storage } = await (await call("/api/storage")).json();
    expect(storage).toMatchObject({ configured: false, masterKeySet: false, endpoint: null });
  });

  it("refuses a first config without a master key", async () => {
    const res = await call("/api/storage", { method: "PUT", json: CONFIG });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/master key is required/);
  });

  it("normalizes the prefix and refuses a prefix that leaves the folder", async () => {
    const ok = await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: pem() } });
    expect((await ok.json()).storage.prefix).toBe("cores");
    for (const prefix of ["", "/", "a/../b", "a//b", "."]) {
      expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, prefix } })).status).toBe(400);
    }
  });

  it("refuses a backend this Panel cannot issue keys for", async () => {
    const res = await call("/api/storage", { method: "PUT", json: { ...CONFIG, backend: "nope", masterKey: pem() } });
    expect(res.status).toBe(400);
  });
});

describe("the master key", () => {
  it("is never returned by any route, in any answer, and never logged", async () => {
    const key = pem();
    const secret = body(key);
    const bodies: string[] = [];
    const take = async (res: Response) => {
      bodies.push(await res.text());
      return res;
    };

    expect((await take(await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: key } }))).status).toBe(200);
    await take(await call("/api/storage"));
    // An edit that does not carry a key answers without one, and keeps the one stored.
    await take(await call("/api/storage", { method: "PUT", json: { ...CONFIG, bucket: "other-bucket" } }));
    // A refused write quotes nothing of what was sent.
    await take(await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: `-----BEGIN PRIVATE KEY-----\n${secret.slice(0, 40)}\n-----END PRIVATE KEY-----` } }));
    await take(await call("/api/storage", { method: "PUT", json: { ...CONFIG, backend: "nope", masterKey: key } }));
    // No route offers it: every shape a credentials route could take.
    for (const p of ["/api/storage/key", "/api/storage/master-key", "/api/storage/credentials", "/api/storage/secret"]) {
      for (const method of ["GET", "POST", "PUT"]) await take(await call(p, { method }));
    }
    // Cores and the v1 surface carry no storage fields.
    await take(await call("/api/cores"));

    for (const text of bodies) expect(text).not.toContain(secret.slice(0, 40));
    for (const line of logged) expect(line).not.toContain(secret.slice(0, 40));

    const { storage } = await (await call("/api/storage")).json();
    expect(storage).toMatchObject({ configured: true, masterKeySet: true, bucket: "other-bucket" });
    expect(Object.keys(storage).sort()).toEqual(
      [
        "accountId",
        "anonKey",
        "backend",
        "bucket",
        "configured",
        "endpoint",
        "issuerEndpoint",
        "keyId",
        "masterKeyRotatedAt",
        "masterKeySet",
        "oidcAudience",
        "oidcIssuer",
        "parentAccessKeyId",
        "prefix",
        "region",
        "roleArn",
        "updatedAt",
        "uploadSizeLimitBytes",
      ].sort(),
    );
  });

  it("is sealed at rest: the column holds no PEM, and opens only through the Panel's secret mechanism", async () => {
    const key = pem();
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: key } });
    const { rows } = await testDb.pool.query("select master_key_sealed from storage_config");
    const stored = Buffer.from(rows[0].master_key_sealed as Uint8Array);
    expect(stored.includes(Buffer.from(body(key).slice(0, 40)))).toBe(false);
    expect(stored.includes(Buffer.from("PRIVATE KEY"))).toBe(false);
    const { openSecret } = await import("../services/secrets-at-rest");
    expect(openSecret(stored)).toBe(key);
  });

  it("is rotated by a write, and kept by an edit that carries none", async () => {
    const first = pem();
    const second = pem();
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: first } });
    const { openSecret } = await import("../services/secrets-at-rest");
    const read = async () =>
      openSecret(Buffer.from((await testDb.pool.query("select master_key_sealed from storage_config")).rows[0].master_key_sealed as Uint8Array));
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, prefix: "other" } });
    expect(await read()).toBe(first);
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: second } });
    expect(await read()).toBe(second);
  });

  it("is accepted as one line, the way a password box delivers a pasted PEM, and sealed in its proper shape", async () => {
    const key = pem();
    const oneLine = key.replace(/\n/g, "");
    expect(oneLine).not.toContain("\n");
    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: oneLine } })).status).toBe(200);
    const { openSecret } = await import("../services/secrets-at-rest");
    const stored = (await testDb.pool.query("select master_key_sealed from storage_config")).rows[0].master_key_sealed as Uint8Array;
    expect(openSecret(Buffer.from(stored))).toBe(key);
  });

  it("is refused when it is not an RSA private key, without repeating what was sent", async () => {
    const res = await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: "hunter2-not-a-key" } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: ec } })).status).toBe(400);
  });

  it("records when it was rotated, and an edit without a key does not move that time", async () => {
    const first = pem();
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: first } });
    const { storage: afterSet } = await (await call("/api/storage")).json();
    expect(afterSet.masterKeyRotatedAt).toEqual(expect.any(Number));
    const rotatedAt = afterSet.masterKeyRotatedAt as number;
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, bucket: "actana-shared-2" } });
    const { storage: afterEdit } = await (await call("/api/storage")).json();
    expect(afterEdit.masterKeyRotatedAt).toBe(rotatedAt);
    expect(afterEdit.bucket).toBe("actana-shared-2");
    await new Promise((r) => setTimeout(r, 5));
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: pem() } });
    const { storage: afterRotate } = await (await call("/api/storage")).json();
    expect(afterRotate.masterKeyRotatedAt).toBeGreaterThan(rotatedAt);
  });

  it("stores the upload size limit and defaults it to 512 MiB", async () => {
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: pem() } });
    const { storage } = await (await call("/api/storage")).json();
    expect(storage.uploadSizeLimitBytes).toBe(512 * 1024 * 1024);
    await call("/api/storage", { method: "PUT", json: { ...CONFIG, uploadSizeLimitBytes: 64 * 1024 * 1024 } });
    const { storage: next } = await (await call("/api/storage")).json();
    expect(next.uploadSizeLimitBytes).toBe(64 * 1024 * 1024);
  });

  it("accepts the STS, Supabase and R2 backends with their master material shapes", async () => {
    for (const [backend, masterKey, extra] of [
      [
        "sts",
        JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" }),
        { roleArn: "arn:aws:iam::1:role/r", issuerEndpoint: "https://sts.example.test" },
      ],
      ["r2", "cf-api-token-example", { accountId: "acct", parentAccessKeyId: "parent" }],
      ["supabase", JSON.stringify({ serviceRoleKey: "srk", jwtSecret: "jwt" }), { anonKey: "anon", issuerEndpoint: "https://xyz.supabase.co" }],
    ] as const) {
      const res = await call("/api/storage", {
        method: "PUT",
        json: { ...CONFIG, backend, masterKey, oidcIssuer: undefined, keyId: undefined, ...extra },
      });
      expect(res.status, backend).toBe(200);
      const { storage } = await res.json();
      expect(storage.backend).toBe(backend);
      expect(storage.masterKeySet).toBe(true);
      expect(JSON.stringify(storage)).not.toMatch(/AKIAEXAMPLE|secret|cf-api-token|srk|jwt/);
    }
  });

  it("keeps the STS AssumeRole URL apart from the S3 host, and refuses an STS save with no AssumeRole URL", async () => {
    const sts = {
      ...CONFIG,
      backend: "sts",
      masterKey: JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" }),
      roleArn: "arn:aws:iam::1:role/r",
      oidcIssuer: undefined,
      keyId: undefined,
    };
    const missing = await call("/api/storage", { method: "PUT", json: sts });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/STS AssumeRole URL/);
    const ok = await call("/api/storage", { method: "PUT", json: { ...sts, endpoint: "https://s3.example.test", issuerEndpoint: "https://sts.example.test/" } });
    expect(ok.status).toBe(200);
    const { storage } = await ok.json();
    expect(storage.endpoint).toBe("https://s3.example.test");
    expect(storage.issuerEndpoint).toBe("https://sts.example.test");
  });

  it("takes the Supabase project URL for the issuer and derives the S3 host from it when none is given", async () => {
    const supabase = {
      ...CONFIG,
      backend: "supabase",
      masterKey: JSON.stringify({ serviceRoleKey: "srk", jwtSecret: "jwt" }),
      anonKey: "anon",
      oidcIssuer: undefined,
      keyId: undefined,
    };
    expect((await call("/api/storage", { method: "PUT", json: { ...supabase, endpoint: "" } })).status).toBe(400);
    const res = await call("/api/storage", { method: "PUT", json: { ...supabase, endpoint: "", issuerEndpoint: "https://xyz.supabase.co" } });
    expect(res.status).toBe(200);
    const { storage } = await res.json();
    expect(storage.issuerEndpoint).toBe("https://xyz.supabase.co");
    expect(storage.endpoint).toBe("https://xyz.supabase.co/storage/v1/s3");
  });

  it("has no issuer endpoint for SeaweedFS or R2, whatever is sent", async () => {
    const res = await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: MASTER_PEM, issuerEndpoint: "https://ignored.test" } });
    expect(res.status).toBe(200);
    expect((await res.json()).storage.issuerEndpoint).toBeNull();
  });

  it("refuses a backend change that carries no new master material", async () => {
    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: MASTER_PEM } })).status).toBe(200);
    const res = await call("/api/storage", {
      method: "PUT",
      json: {
        ...CONFIG,
        backend: "sts",
        roleArn: "arn:aws:iam::1:role/r",
        issuerEndpoint: "https://sts.example.test",
        oidcIssuer: undefined,
        keyId: undefined,
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/backend.*master key/i);
    const { storage } = await (await call("/api/storage")).json();
    expect(storage.backend).toBe("seaweedfs");
  });
});

describe("rotate re-issues Core keys", () => {
  it("a PUT with a master key pushes sharedCredentials; a PUT without one does not", async () => {
    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: MASTER_PEM } })).status).toBe(200);
    await attachedCore();
    expect(link.ofType("sharedAttach")).toHaveLength(1);
    link.frames.length = 0;

    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: MASTER_PEM } })).status).toBe(200);
    await settle();
    expect(link.ofType("sharedCredentials")).toHaveLength(1);
    expect(link.ofType("sharedAttach")).toHaveLength(0);
    link.frames.length = 0;

    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, bucket: "actana-shared" } })).status).toBe(200);
    await settle();
    expect(link.ofType("sharedCredentials")).toHaveLength(0);
    expect(link.frames).toEqual([]);
  });
});

describe("per-Core rows and test connection", () => {
  it("GET /api/storage lists each Core's folder size and key expiry from listStorageCores", async () => {
    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: MASTER_PEM } })).status).toBe(200);
    const coreId = await attachedCore();
    s3.seed(`${PREFIX}/${coreId}/note.txt`, "hello-size");
    const { cores } = await (await call("/api/storage")).json();
    expect(cores).toEqual([
      expect.objectContaining({
        coreId,
        label: expect.stringMatching(/^storage core /),
        prefix: `${PREFIX}/${coreId}/`,
        sizeBytes: 10,
        keyExpiresAt: expect.any(Number),
        state: "attached",
        offline: false,
      }),
    ]);
  });

  it("POST /api/storage/test proves isolation on the fake S3 without a registered Core", async () => {
    expect((await call("/api/storage", { method: "PUT", json: { ...CONFIG, masterKey: MASTER_PEM } })).status).toBe(200);
    const res = await call("/api/storage/test", { method: "POST", json: {} });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({ read: true, write: true, listOwn: true, reachOther: false });
    expect(result.folder).toMatch(new RegExp(`^${PREFIX}/probe_`));
    expect([...s3.objects.keys()].every((k) => !k.includes(".panel-probe-"))).toBe(true);
  });
});
