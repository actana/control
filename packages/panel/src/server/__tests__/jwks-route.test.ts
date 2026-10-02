import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

/**
 * GET /.well-known/jwks.json (#566): the public key set SeaweedFS fetches to verify the Panel's Core tokens. No
 * session, public material only, the `kid` of the tokens the issuer signs, rotation visible, empty before a key exists.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-jwks-route-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { createOperator } = await import("../services/operator");
const { saveStorageConfig, storageKeyIssuer } = await import("../services/storage");

const ORIGIN = "http://panel.example.test";
const PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi"];

function pem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
/** The key's base64 body: what would show in any output that carried the key. */
function body(key: string): string {
  return key.replace(/-----[A-Z ]+-----|\s/g, "");
}

const CONFIG = {
  backend: "seaweedfs",
  endpoint: "http://seaweedfs:8333",
  bucket: "actana-shared",
  prefix: "cores/",
  oidcIssuer: "http://panel:7420",
  keyId: "k1",
};

/** No cookie, no key: SeaweedFS sends neither. */
async function getJwks(method = "GET"): Promise<Response> {
  const response = await handleApiRequest(new Request(`${ORIGIN}/.well-known/jwks.json`, { method }));
  if (!response) throw new Error("no response for the JWKS route");
  return response;
}

/** The token the storage service's issuer signs for a Core, caught on its way to the STS endpoint. */
async function issuedToken(): Promise<string> {
  let token = "";
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    token = new URLSearchParams(String(init?.body)).get("WebIdentityToken") ?? "";
    return new Response("<Error><Code>Stop</Code></Error>", { status: 400 });
  }) as typeof fetch;
  const { issuer } = await storageKeyIssuer(undefined, { fetch: fetchStub });
  await issuer.issue("core-a").catch(() => undefined);
  return token;
}

function verifiesWith(token: string, jwk: Record<string, unknown>): boolean {
  const [h, c, s] = token.split(".") as [string, string, string];
  return verify("sha256", Buffer.from(`${h}.${c}`), createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(s, "base64url"));
}

beforeEach(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
});

afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /.well-known/jwks.json", () => {
  it("answers an empty key set, not an error, before storage is configured", async () => {
    const res = await getJwks();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ keys: [] });
  });

  it("serves the public key under the kid of the tokens the issuer signs, with no session", async () => {
    const master = pem();
    await saveStorageConfig({ ...CONFIG, masterKey: master });

    const res = await getJwks();
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(doc.keys).toHaveLength(1);
    const jwk = doc.keys[0]!;
    expect(jwk).toMatchObject({ kty: "RSA", kid: "k1", use: "sig", alg: "RS256" });

    const token = await issuedToken();
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toMatchObject({ kid: jwk.kid, alg: "RS256" });
    expect(verifiesWith(token, jwk)).toBe(true);
  });

  it("carries no private key field and no master key, in the body or the headers", async () => {
    const master = pem();
    await saveStorageConfig({ ...CONFIG, masterKey: master });

    const res = await getJwks();
    const text = await res.text();
    const jwk = (JSON.parse(text) as { keys: Record<string, unknown>[] }).keys[0]!;
    for (const field of PRIVATE_FIELDS) expect(jwk).not.toHaveProperty(field);
    expect(Object.keys(jwk).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(text).not.toContain(body(master).slice(0, 40));
    expect(text).not.toMatch(/PRIVATE|BEGIN/);
    expect([...res.headers.values()].join("\n")).not.toContain(body(master).slice(0, 40));
  });

  it("reflects a rotation: the new key under the kid, and tokens verify with it, not with the old one", async () => {
    await saveStorageConfig({ ...CONFIG, masterKey: pem() });
    const before = ((await (await getJwks()).json()) as { keys: Record<string, unknown>[] }).keys[0]!;

    await saveStorageConfig({ ...CONFIG, keyId: "k2", masterKey: pem() });
    const after = ((await (await getJwks()).json()) as { keys: Record<string, unknown>[] }).keys[0]!;

    expect(after.kid).toBe("k2");
    expect(after.n).not.toBe(before.n);
    const token = await issuedToken();
    expect(verifiesWith(token, after)).toBe(true);
    expect(verifiesWith(token, before)).toBe(false);
  });

  it("has cache headers a JWKS can live with: public, short, and shorter while empty", async () => {
    expect((await getJwks()).headers.get("cache-control")).toBe("public, max-age=15");
    await saveStorageConfig({ ...CONFIG, masterKey: pem() });
    expect((await getJwks()).headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("is an empty set when the backend has no token signer", async () => {
    await saveStorageConfig({
      backend: "sts",
      endpoint: "http://minio:9000",
      bucket: "actana-shared",
      prefix: "cores/",
      roleArn: "arn:aws:iam::1:role/x",
      masterKey: JSON.stringify({ accessKeyId: "a", secretAccessKey: "b" }),
    });
    expect(await (await getJwks()).json()).toEqual({ keys: [] });
  });

  it("answers GET and HEAD only; a write falls through to the session gate", async () => {
    expect((await getJwks("HEAD")).status).toBe(200);
    const res = await handleApiRequest(new Request(`${ORIGIN}/.well-known/jwks.json`, { method: "POST" }));
    expect(res?.status).toBe(401);
  });
});
