import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * The storage config and its master key (#564): the key goes in through one write-only route, is sealed at
 * rest, and comes out of nowhere: not a route, not a log line, not an error message.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-storage-config-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");

const ORIGIN = "http://panel.example.test";

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
  bucket: "actana-shared",
  prefix: "cores/",
  oidcIssuer: "https://panel.example.test",
  keyId: "k1",
};

let logged: string[];

beforeEach(() => {
  resetOperatorSessionForTests();
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(Object(a))))).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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
    const res = await call("/api/storage", { method: "PUT", json: { ...CONFIG, backend: "r2", masterKey: pem() } });
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
      ["backend", "bucket", "configured", "endpoint", "keyId", "masterKeySet", "oidcAudience", "oidcIssuer", "prefix", "region", "updatedAt"],
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
});
