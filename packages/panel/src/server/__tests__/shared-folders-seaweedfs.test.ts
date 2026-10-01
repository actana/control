// The Panel's Shared-folder service against a REAL SeaweedFS with real STS keys (CI job `core-shared-seaweedfs`, see
// .github/workflows/ci.yml; #564, ADR 0041 D33). The role is the one in deploy/seaweedfs/iam.json.tmpl, the keys are the
// ones the SDK's issuer asks SeaweedFS for with the master key the Panel stored (sealed, in Postgres), and the Core on the
// other end of the core-link is a fake. What it proves that the in-memory fake cannot: a key issued for one Core really
// is refused on another Core's prefix, and deleting a Core empties its own prefix and not one object of any other, which
// is read back with the bucket's static admin identity (listing the whole bucket), not with the keys under test.
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
import { FakeClock, FakeCoreLink } from "./_shared-fakes";

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

describe.skipIf(!configured)("the Panel's Shared folders against real SeaweedFS and real STS keys", () => {
  let jwks: Server;
  let testDb: Awaited<ReturnType<typeof openPanelTestDb>>;
  let tmpRoot: string;
  const mods = {} as {
    registerCoreFromCredential: typeof import("../services/cores").registerCoreFromCredential;
    storageKeyIssuer: typeof import("../services/storage").storageKeyIssuer;
    SharedFolders: typeof import("../services/shared-folders").SharedFolders;
    saveStorageConfig: typeof import("../services/storage").saveStorageConfig;
    findSharedFolder: typeof import("../repositories/core-shared-folders.repo").findSharedFolder;
    getCore: typeof import("../services/cores").getCore;
  };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-shared-sw-test-"));
    process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
    process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
    testDb = await openPanelTestDb();
    const cores = await import("../services/cores");
    const storage = await import("../services/storage");
    const folders = await import("../services/shared-folders");
    const repo = await import("../repositories/core-shared-folders.repo");
    Object.assign(mods, {
      registerCoreFromCredential: cores.registerCoreFromCredential,
      getCore: cores.getCore,
      storageKeyIssuer: storage.storageKeyIssuer,
      saveStorageConfig: storage.saveStorageConfig,
      SharedFolders: folders.SharedFolders,
      findSharedFolder: repo.findSharedFolder,
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

    const { operatorSessionCookie } = await import("./_operator-session");
    await operatorSessionCookie();
    // The master key goes in the way the Panel takes it, and the issuer reads it back out of the sealed column.
    await mods.saveStorageConfig({
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
  async function pairedCore(): Promise<string> {
    n += 1;
    const core = await mods.registerCoreFromCredential(
      { endpoint: `wss://sw-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
      { label: `sw core ${n}`, pendingSharedFolder: true },
    );
    return core.id;
  }

  /** One fake Core per Core id, as there are real machines: two Cores never share a mount. */
  function service() {
    const clock = new FakeClock();
    const links = new Map<string, FakeCoreLink>();
    const linkOf = (coreId: string) => {
      if (!links.has(coreId)) links.set(coreId, new FakeCoreLink());
      return links.get(coreId)!;
    };
    return {
      linkOf,
      clock,
      service: new mods.SharedFolders({
        link: linkOf,
        isConnected: () => true,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      }),
    };
  }

  /** A Core's own client for its own folder, with a key the real issuer gave it. */
  async function folderOf(coreId: string) {
    const { issuer } = await mods.storageKeyIssuer();
    const key = await issuer.issue(coreId);
    return createS3CoreShared({
      endpoint: env.endpoint!,
      bucket: env.bucket,
      prefix: `${env.prefix}/${coreId}`,
      credentials: { get: async () => key },
    });
  }

  it("finishes a pairing with a real key: the Core is attached, and the connection test proved isolation on the real role", async () => {
    const { service: s, linkOf } = service();
    const coreId = await pairedCore();
    const link = linkOf(coreId);
    const proof = await s.testConnection(coreId);
    expect(proof).toMatchObject({ read: true, write: true, listOwn: true, reachOther: false, folder: `${env.prefix}/${coreId}/` });

    const row = await s.finishPairing(coreId);
    expect(row).toMatchObject({ state: "attached", s3Prefix: `${env.prefix}/${coreId}/` });
    const [attach] = link.ofType("sharedAttach");
    expect(attach).toMatchObject({ bucket: env.bucket, prefix: `${env.prefix}/${coreId}` });
    // The key the Core was handed works on its own folder, on a real server, and only there.
    const key = { ...attach!.credentials, expiresAt: new Date(attach!.expiresAt) };
    const own = createS3CoreShared({ endpoint: env.endpoint!, bucket: env.bucket, prefix: attach!.prefix, credentials: { get: async () => key } });
    await own.put("hello.txt", "hi");
    expect(new TextDecoder().decode((await own.get("hello.txt")).body)).toBe("hi");
    const other = createS3CoreShared({ endpoint: env.endpoint!, bucket: env.bucket, prefix: `${env.prefix}/core_not_this_one`, credentials: { get: async () => key } });
    await expect(other.list("")).rejects.toMatchObject({ code: "forbidden" });
    await expect(other.put("planted.txt", "x")).rejects.toMatchObject({ code: "forbidden" });
  }, 90_000);

  it("deletes the Core and exactly its own prefix: not one object of any other prefix is touched", async () => {
    const { service: s, linkOf } = service();
    const a = await pairedCore();
    const b = await pairedCore();
    await s.finishPairing(a);
    await s.finishPairing(b);

    // Names that merely start like A's folder, and another Core's folder, each written with that name's own key.
    const lookalikeDash = `${a}-2`;
    const lookalikeSuffix = `${a}x`;
    const own = await folderOf(a);
    await own.put("a.txt", "a");
    await own.put("sub/b.txt", "b");
    await own.put("sub/deeper/c.txt", "c");
    await own.mkdir("empty-folder/");
    const others: Record<string, string[]> = {
      [b]: ["keep.txt", "dir/keep2.txt"],
      [lookalikeDash]: ["y.txt"],
      [lookalikeSuffix]: ["z.txt"],
    };
    for (const [id, names] of Object.entries(others)) {
      const f = await folderOf(id);
      for (const name of names) await f.put(name, id);
    }
    const before = await adminKeys(`${env.prefix}/`);
    const ownBefore = before.filter((k) => k.startsWith(`${env.prefix}/${a}/`));
    const foreignBefore = before.filter((k) => !k.startsWith(`${env.prefix}/${a}/`));
    expect(ownBefore.length).toBeGreaterThanOrEqual(3);
    // The bucket is shared with the Core's own test in the same job, so there is more than the four written here;
    // the claim is that none of it, whoever wrote it, is touched.
    expect(foreignBefore.length).toBeGreaterThanOrEqual(4);

    // Anything but the exact prefix removes nothing.
    await expect(s.deleteCore(a, `${env.prefix}/${a}`)).rejects.toMatchObject({ code: "confirmation" });
    expect(await adminKeys(`${env.prefix}/`)).toEqual(before);
    expect(await mods.getCore(a)).not.toBeNull();

    const result = await s.deleteCore(a, `${env.prefix}/${a}/`);
    expect(result.prefix).toBe(`${env.prefix}/${a}/`);

    expect(await mods.getCore(a)).toBeNull();
    expect(linkOf(a).ofType("sharedDetach")).toMatchObject([{ keepLocalCopy: true }]);
    const after = await adminKeys(`${env.prefix}/`);
    expect(after.filter((k) => k.startsWith(`${env.prefix}/${a}/`))).toEqual([]);
    // Every other object in the bucket under the Cores' prefix is still there, byte for byte the same set.
    expect(after).toEqual(foreignBefore);
    expect(await mods.getCore(b)).not.toBeNull();
    expect((await mods.findSharedFolder(1, b))?.state).toBe("attached");
    // B's own key still reads B's own files: a listing is the direct children, so the nested file shows as its folder.
    const bOwn = await folderOf(b);
    expect((await bOwn.list("")).map((e) => e.path).sort()).toEqual(["dir", "keep.txt"]);
    expect(new TextDecoder().decode((await bOwn.get("dir/keep2.txt")).body)).toBe(b);
  }, 120_000);
});
