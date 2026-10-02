// The Panel's Files routes (#565) against a REAL SeaweedFS with real STS keys (CI job `core-shared-seaweedfs`, see
// .github/workflows/ci.yml; ADR 0041 D33). Through the real router, with the keys the SDK's issuer asks SeaweedFS for
// and the role in deploy/seaweedfs/iam.json.tmpl. What the in-memory fake cannot say: a Core's key really is refused on
// another Core's prefix, the signed download URL really downloads the one object with no other credential, and what the
// routes write is what is in the bucket, read back with the bucket's admin identity.
//
// Without SEAWEEDFS_ENDPOINT it is skipped, and in the CI job that sets SEAWEEDFS_REQUIRED=1 it fails instead: a
// skipped proof is not a pass.
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createS3CoreShared } from "@actana/sdk/shared";
import { publicJwks } from "@actana/sdk/shared-key";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";

const env = {
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  adminKey: process.env.SEAWEEDFS_ADMIN_ACCESS_KEY,
  adminSecret: process.env.SEAWEEDFS_ADMIN_SECRET_KEY,
  issuer: process.env.SEAWEEDFS_OIDC_ISSUER,
  jwksPort: Number(process.env.SEAWEEDFS_JWKS_PORT),
  audience: process.env.SEAWEEDFS_OIDC_AUDIENCE ?? "actana-shared",
  bucket: process.env.SEAWEEDFS_BUCKET ?? "actana-shared",
  prefix: process.env.SEAWEEDFS_PREFIX ?? "cores",
  signingKeyFile: process.env.SEAWEEDFS_SIGNING_KEY_FILE,
};
const configured = Boolean(
  env.endpoint && env.adminKey && env.adminSecret && env.issuer && env.jwksPort && env.signingKeyFile,
);

if (!configured && process.env.SEAWEEDFS_REQUIRED === "1") {
  throw new Error("SEAWEEDFS_* is not set: the Panel's isolation and delete tests must run against SeaweedFS in CI");
}

const KEY_ID = "ci-key";

/** A request to the gateway with the static admin identity, signed with SigV4. Cores and the Panel's issuer never hold it. */
async function admin(method: "GET" | "PUT", pathname: string, query: Record<string, string> = {}): Promise<Response> {
  const url = new URL(pathname, env.endpoint!);
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k]!)}`)
    .join("&");
  if (canonicalQuery) url.search = canonicalQuery;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = createHash("sha256").update("").digest("hex");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [
    method,
    url.pathname,
    canonicalQuery,
    `host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payload,
  ].join("\n");
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${env.adminSecret}`, day), "us-east-1"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return fetch(url, {
    method,
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${env.adminKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

/** Every object key in the bucket under `prefix`, as the admin identity sees them (paged). */
async function adminKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  for (;;) {
    const res = await admin("GET", `/${env.bucket}`, { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
    expect(res.status).toBe(200);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1]!);
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!token) return keys.sort();
  }
}

describe.skipIf(!configured)("the Panel's Files routes against real SeaweedFS and real STS keys", () => {
  let jwks: Server;
  let testDb: Awaited<ReturnType<typeof openPanelTestDb>>;
  let tmpRoot: string;
  const mods = {} as {
    handleApiRequest: typeof import("../api-router").handleApiRequest;
    registerCoreFromCredential: typeof import("../services/cores").registerCoreFromCredential;
    storageKeyIssuer: typeof import("../services/storage").storageKeyIssuer;
    updateSharedFolder: typeof import("../repositories/core-shared-folders.repo").updateSharedFolder;
    operatorSessionCookie: typeof import("./_operator-session").operatorSessionCookie;
  };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-shared-files-sw-test-"));
    process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
    process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
    testDb = await openPanelTestDb();
    const cores = await import("../services/cores");
    const storage = await import("../services/storage");
    const repo = await import("../repositories/core-shared-folders.repo");
    const router = await import("../api-router");
    const session = await import("./_operator-session");
    Object.assign(mods, {
      handleApiRequest: router.handleApiRequest,
      registerCoreFromCredential: cores.registerCoreFromCredential,
      storageKeyIssuer: storage.storageKeyIssuer,
      updateSharedFolder: repo.updateSharedFolder,
      operatorSessionCookie: session.operatorSessionCookie,
    });

    // SeaweedFS may keep the JWKS it first read, so every test file signs with the CI job's one key.
    const signingKey = fs.readFileSync(env.signingKeyFile!, "utf8");
    const doc = JSON.stringify(publicJwks(signingKey, KEY_ID));
    jwks = createServer((req, res) => {
      res.writeHead(req.url === "/jwks.json" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/jwks.json" ? doc : "{}");
    });
    await new Promise<void>((resolve) => jwks.listen(env.jwksPort, "127.0.0.1", resolve));
    expect([200, 409]).toContain((await admin("PUT", `/${env.bucket}`)).status);

    await mods.operatorSessionCookie();
    await storage.saveStorageConfig({
      backend: "seaweedfs",
      endpoint: env.endpoint!,
      bucket: env.bucket,
      prefix: env.prefix,
      oidcIssuer: env.issuer!,
      oidcAudience: env.audience,
      keyId: KEY_ID,
      masterKey: signingKey,
    });
  }, 90_000);

  afterAll(async () => {
    await new Promise((resolve) => jwks?.close(resolve));
    await resetPanelState(testDb);
    await closePanelTestDb(testDb);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  let n = 0;
  /** A Core with its Shared folder attached. No Core process exists: the routes read S3 and nothing else. */
  async function attachedCore(): Promise<string> {
    n += 1;
    const core = await mods.registerCoreFromCredential(
      { endpoint: `wss://sw-files-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
      { label: `sw files core ${n}`, pendingSharedFolder: true },
    );
    await mods.updateSharedFolder(1, core.id, { state: "attached", s3Prefix: `${env.prefix}/${core.id}/` }, Date.now());
    return core.id;
  }

  async function call(pathname: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}): Promise<Response> {
    const headers: Record<string, string> = { cookie: await mods.operatorSessionCookie() };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const res = await mods.handleApiRequest(
      new Request(`http://panel.example.test${pathname}`, {
        method: init.method ?? "GET",
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      }),
    );
    return res!;
  }
  const files = (coreId: string, leaf = "", query = "") => `/api/cores/${coreId}/shared/files${leaf ? `/${leaf}` : ""}${query}`;
  const q = (p: string) => `?path=${encodeURIComponent(p)}`;
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const names = (listing: Record<string, any>): string[] => listing.entries.map((e: { name: string }) => e.name);

  it("writes, lists, renames, moves and deletes through the routes, and the bucket holds exactly that", async () => {
    const a = await attachedCore();
    const root = `${env.prefix}/${a}/`;
    expect((await call(files(a, "mkdir"), { method: "POST", json: { path: "brand/specs/" } })).status).toBe(200);
    for (const p of ["brand/readme.md", "brand/src/a.ts", "brand/src/deep/b.ts"]) {
      expect((await call(files(a, "upload", q(p)), { method: "PUT", body: p })).status).toBe(200);
    }
    const listed = await json(await call(files(a, "", q("brand"))));
    expect(names(listed)).toEqual(["specs", "src", "readme.md"]);
    expect(listed.entries.find((e: { name: string }) => e.name === "src").itemCount).toBe(2);

    expect(await json(await call(files(a, "rename"), { method: "POST", json: { path: "brand/readme.md", name: "README.md" } }))).toEqual({ path: "brand/README.md" });
    expect(await json(await call(files(a, "move"), { method: "POST", json: { path: "brand/src/", to: "brand/specs/" } }))).toEqual({ path: "brand/specs/src" });
    const keys = (await adminKeys(root)).filter((k) => !k.endsWith("/")).map((k) => k.slice(root.length));
    expect(keys).toEqual(["brand/README.md", "brand/specs/src/a.ts", "brand/specs/src/deep/b.ts"]);

    expect((await call(files(a, "delete"), { method: "POST", json: { path: "brand/" } })).status).toBe(200);
    expect((await adminKeys(root)).filter((k) => !k.endsWith("/"))).toEqual([]);
  }, 120_000);

  it("downloads one object through its 5-minute signed URL, with nothing but the URL", async () => {
    const a = await attachedCore();
    expect((await call(files(a, "upload", q("reports/r1.md")), { method: "PUT", body: "report one" })).status).toBe(200);
    expect((await call(files(a, "upload", q("reports/r2.md")), { method: "PUT", body: "report two" })).status).toBe(200);
    const signed = await json(await call(files(a, "download-url"), { method: "POST", json: { path: "reports/r1.md" } }));
    expect(new URL(signed.url).searchParams.get("X-Amz-Expires")).toBe("300");
    const res = await fetch(signed.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("report one");
    // The URL is for that object: the same signature on its neighbour is refused.
    const other = new URL(signed.url);
    other.pathname = other.pathname.replace("r1.md", "r2.md");
    expect((await fetch(other)).status).toBeGreaterThanOrEqual(400);
  }, 90_000);

  it("never shows one Core another Core's folder, and a stored folder that is not its own is refused", async () => {
    const a = await attachedCore();
    const b = await attachedCore();
    expect((await call(files(a, "upload", q("only-a.txt")), { method: "PUT", body: "A" })).status).toBe(200);
    expect((await call(files(b, "upload", q("only-b.txt")), { method: "PUT", body: "B" })).status).toBe(200);
    expect(names(await json(await call(files(a, "", q("")))))).toEqual(["only-a.txt"]);
    expect(names(await json(await call(files(b, "", q("")))))).toEqual(["only-b.txt"]);
    expect((await call(files(a, "details", q("only-b.txt")))).status).toBe(404);
    expect((await call(files(a, "details", q(`../${b}/only-b.txt`)))).status).toBe(400);

    // The row names B's folder for A: refused by the Panel before the store is asked.
    await mods.updateSharedFolder(1, a, { s3Prefix: `${env.prefix}/${b}/` }, Date.now());
    expect((await call(files(a, "", q("")))).status).toBe(400);
    // And a key issued for A, used on B's prefix, is refused by the real role: the store enforces it, not only the Panel.
    const { issuer } = await mods.storageKeyIssuer();
    const keyOfA = await issuer.issue(a);
    const onB = createS3CoreShared({ endpoint: env.endpoint!, bucket: env.bucket, prefix: `${env.prefix}/${b}`, credentials: { get: async () => keyOfA } });
    await expect(onB.list("")).rejects.toMatchObject({ code: "forbidden" });
    await expect(onB.rm("only-b.txt")).rejects.toMatchObject({ code: "forbidden" });
    expect(await adminKeys(`${env.prefix}/${b}/`)).toContain(`${env.prefix}/${b}/only-b.txt`);
  }, 120_000);
});
