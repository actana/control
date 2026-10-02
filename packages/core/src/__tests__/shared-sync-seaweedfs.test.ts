// The Shared folder's sync against a REAL SeaweedFS, with real STS keys (CI job
// `core-shared-seaweedfs`, see .github/workflows/ci.yml; #562, ADR 0041 D33). The role is
// the one in deploy/seaweedfs/iam.json.tmpl, the keys are the ones the controller's issuer
// (`@actana/sdk/shared-key`, client PR 32) asks SeaweedFS for, and the sync is the Core's.
//
// Without SEAWEEDFS_ENDPOINT it is skipped, and in the CI job that sets SEAWEEDFS_REQUIRED=1
// it fails instead: a skipped proof is not a pass.
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreLinkRequestFrame } from "@actana/sdk/core";
import { createS3CoreShared } from "@actana/sdk/shared";
import { createSeaweedfsKeyIssuer, publicJwks, type SharedKey } from "@actana/sdk/shared-key";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSharedHome } from "../shared-home-io";
import { createSharedKeyStore } from "../shared-key-store";
import { createSharedSync, type SharedSync } from "../shared-sync";

const env = {
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  adminKey: process.env.SEAWEEDFS_ADMIN_ACCESS_KEY,
  adminSecret: process.env.SEAWEEDFS_ADMIN_SECRET_KEY,
  issuer: process.env.SEAWEEDFS_OIDC_ISSUER,
  jwksPort: Number(process.env.SEAWEEDFS_JWKS_PORT),
  audience: process.env.SEAWEEDFS_OIDC_AUDIENCE ?? "actana-shared",
  bucket: process.env.SEAWEEDFS_BUCKET ?? "actana-shared",
  prefix: process.env.SEAWEEDFS_PREFIX ?? "cores",
};
const configured = Boolean(env.endpoint && env.adminKey && env.adminSecret && env.issuer && env.jwksPort);

if (!configured && process.env.SEAWEEDFS_REQUIRED === "1") {
  throw new Error("SEAWEEDFS_* is not set: the isolation test must run against SeaweedFS in CI");
}

const KEY_ID = "ci-key";

/** `PUT /<bucket>` with the static admin identity, signed with SigV4 (an empty body). Cores never hold this key. */
async function makeBucket(endpoint: string, bucket: string, accessKey: string, secretKey: string): Promise<number> {
  const url = new URL(`/${bucket}`, endpoint);
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = createHash("sha256").update("").digest("hex");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", url.pathname, "", `host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`, signedHeaders, payload].join("\n");
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), "us-east-1"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  return response.status;
}

type Machine = { coreId: string; root: string; folder: string; stateDir: string; sync: SharedSync };

describe.skipIf(!configured)("the sync against real SeaweedFS and real STS keys", () => {
  let jwks: Server;
  let issuer: ReturnType<typeof createSeaweedfsKeyIssuer>;
  const roots: string[] = [];

  beforeAll(async () => {
    const file = process.env.SEAWEEDFS_SIGNING_KEY_FILE;
    const signingKey = file ? fs.readFileSync(file, "utf8") : generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const doc = JSON.stringify(publicJwks(signingKey, KEY_ID));
    // The path SeaweedFS is configured with is the Panel's route (/.well-known/jwks.json, #566). This package cannot
    // import the Panel, so the same document is served by hand here; the Panel tests of the job read the real route.
    jwks = createServer((req, res) => {
      const found = req.url === "/.well-known/jwks.json";
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      res.end(found ? doc : "{}");
    });
    await new Promise<void>((resolve) => jwks.listen(env.jwksPort, "127.0.0.1", resolve));

    // The bucket is made with the static admin identity, which Cores never receive.
    expect([200, 409]).toContain(await makeBucket(env.endpoint!, env.bucket, env.adminKey!, env.adminSecret!));

    issuer = createSeaweedfsKeyIssuer({
      endpoint: env.endpoint!,
      issuer: env.issuer!,
      audience: env.audience,
      signingKey,
      keyId: KEY_ID,
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => jwks?.close(resolve));
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const attachFrame = (coreId: string, key: SharedKey, prefix = `${env.prefix}/${coreId}`): CoreLinkRequestFrame => ({
    type: "sharedAttach",
    reqId: "r",
    endpoint: env.endpoint!,
    bucket: env.bucket,
    prefix,
    region: "us-east-1",
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, sessionToken: key.sessionToken },
    expiresAt: key.expiresAt.toISOString(),
  });

  /** A machine: its own home, its own state directory, its own sync, a new Core id. */
  async function machine(wrapFetch?: (real: typeof fetch) => typeof fetch): Promise<Machine & { key: SharedKey }> {
    const coreId = `core-s-${randomBytes(5).toString("hex")}`;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-sync-sw-")));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const home = path.join(root, "home");
    const folder = path.join(home, "shared");
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const sync = createSharedSync({
      stateDir,
      home: createSharedHome({ home, identityEnv: {} }),
      intervalMs: 3_600_000,
      ...(wrapFetch ? { fetch: wrapFetch(fetch) } : {}),
    });
    return { coreId, root, folder, stateDir, sync, key: await issuer.issue(coreId) };
  }

  const clientFor = (key: SharedKey, prefix: string) =>
    createS3CoreShared({
      endpoint: env.endpoint!,
      bucket: env.bucket,
      prefix,
      credentials: { get: async () => key },
    });

  it("machine A cannot list, read or write machine B's prefix, and each syncs only its own", async () => {
    const a = await machine();
    const b = await machine();
    fs.writeFileSync(path.join(a.folder, "from-a.txt"), "A's file");
    fs.writeFileSync(path.join(b.folder, "from-b.txt"), "B's file");
    expect(await a.sync.handle(attachFrame(a.coreId, a.key))).toMatchObject({ state: "attached" });
    expect(await b.sync.handle(attachFrame(b.coreId, b.key))).toMatchObject({ state: "attached" });
    await a.sync.idle();
    await b.sync.idle();

    // Each side's S3 holds its own file.
    const aOwn = clientFor(a.key, `${env.prefix}/${a.coreId}`);
    const bOwn = clientFor(b.key, `${env.prefix}/${b.coreId}`);
    expect((await aOwn.list("")).map((e) => e.path)).toEqual(["from-a.txt"]);
    expect((await bOwn.list("")).map((e) => e.path)).toEqual(["from-b.txt"]);

    // A's key on B's prefix: no list, no read, no write, no delete, and B's file is untouched.
    const aOnB = clientFor(a.key, `${env.prefix}/${b.coreId}`);
    for (const attempt of [() => aOnB.list(""), () => aOnB.get("from-b.txt"), () => aOnB.put("planted.txt", "x"), () => aOnB.rm("from-b.txt")]) {
      await expect(attempt()).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(new TextDecoder().decode((await bOwn.get("from-b.txt")).body)).toBe("B's file");

    // And a machine told to sync B's prefix with A's key is refused at attach, keeping nothing.
    const rogue = await machine();
    const status = await rogue.sync.handle(attachFrame(rogue.coreId, a.key, `${env.prefix}/${b.coreId}`));
    expect(status).toMatchObject({ state: "error", code: "mount-failed" });
    expect(fs.existsSync(createSharedKeyStore(rogue.stateDir).path)).toBe(false);
    expect(fs.readdirSync(rogue.folder)).toEqual([]);

    // Neither folder received the other's file.
    expect(fs.readdirSync(a.folder)).toEqual(["from-a.txt"]);
    expect(fs.readdirSync(b.folder)).toEqual(["from-b.txt"]);
    a.sync.stop();
    b.sync.stop();
  }, 60_000);

  it("a key refresh during an upload does not break it", async () => {
    // The push is made from inside the first PUT, so it lands while that upload is in flight,
    // whatever the timing of the network. Every PUT is recorded with the key it was signed with.
    const puts: Array<{ key: string; status: number }> = [];
    let push: (() => Promise<void>) | null = null;
    const m = await machine(
      (real) => async (input, init) => {
        const request = (init?.method ?? "GET").toUpperCase();
        const key = /Credential=([^/]+)\//.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
        if (request === "PUT" && push) {
          const run = push;
          push = null;
          await run();
        }
        const response = await real(input, init);
        if (request === "PUT") puts.push({ key, status: response.status });
        return response;
      },
    );
    expect(await m.sync.handle(attachFrame(m.coreId, m.key))).toMatchObject({ state: "attached" });
    await m.sync.idle();
    const names: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const name = `part-${String(i).padStart(2, "0")}.bin`;
      names.push(name);
      fs.writeFileSync(path.join(m.folder, name), Buffer.alloc(512 * 1024, i));
    }
    const fresh = await issuer.issue(m.coreId);
    expect(fresh.accessKeyId).not.toBe(m.key.accessKeyId);
    let pushed: unknown = null;
    push = async () => {
      pushed = await m.sync.handle({
        type: "sharedCredentials",
        reqId: "r2",
        credentials: { accessKeyId: fresh.accessKeyId, secretAccessKey: fresh.secretAccessKey, sessionToken: fresh.sessionToken },
        expiresAt: fresh.expiresAt.toISOString(),
      });
    };
    const report = await m.sync.pass();
    await m.sync.idle();

    expect(pushed).toMatchObject({ state: "attached" });
    expect(report.failed).toEqual([]);
    expect(createSharedKeyStore(m.stateDir).load()?.accessKeyId).toBe(fresh.accessKeyId);
    // The upload in flight when the push landed finished under the old key; what followed used the new one.
    const objectPuts = puts.filter((p) => p.status === 200);
    expect(objectPuts[0]!.key).toBe(m.key.accessKeyId);
    expect(objectPuts.some((p) => p.key === fresh.accessKeyId)).toBe(true);
    expect(puts.every((p) => p.status === 200)).toBe(true);

    const own = clientFor(fresh, `${env.prefix}/${m.coreId}`);
    const listed = await own.list("");
    expect(listed.map((e) => e.path).sort()).toEqual(names);
    expect(listed.every((e) => e.size === 512 * 1024)).toBe(true);
    m.sync.stop();
  }, 120_000);

  it("unpair copies what is in S3 into the folder and the folder keeps its contents", async () => {
    const m = await machine();
    await clientFor(m.key, `${env.prefix}/${m.coreId}`).put("docs/from-controller.md", "# written by the controller");
    fs.writeFileSync(path.join(m.folder, "mine.txt"), "mine");
    expect(await m.sync.handle(attachFrame(m.coreId, m.key))).toMatchObject({ state: "attached" });
    await m.sync.idle();
    expect(fs.readFileSync(path.join(m.folder, "docs/from-controller.md"), "utf8")).toBe("# written by the controller");

    await clientFor(m.key, `${env.prefix}/${m.coreId}`).put("late.txt", "arrived after the last pass");
    expect(await m.sync.handle({ type: "sharedDetach", reqId: "d", keepLocalCopy: true })).toEqual({
      state: "detached",
      keptLocalCopy: true,
    });
    expect(fs.readFileSync(path.join(m.folder, "late.txt"), "utf8")).toBe("arrived after the last pass");
    expect(fs.readFileSync(path.join(m.folder, "mine.txt"), "utf8")).toBe("mine");
    expect(fs.existsSync(createSharedKeyStore(m.stateDir).path)).toBe(false);
  }, 60_000);
});
