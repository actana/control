// The Task result watcher (#570) against a REAL SeaweedFS with real STS keys (CI job `core-shared-seaweedfs`, see
// .github/workflows/ci.yml; ADR 0041 D33). `startTaskDispatch` is what `bootPanel` calls: the Core is a fake that starts
// no process and cannot be reached, so the only way a result file written by "the Core" with its own 1-hour key can move
// the Task is the Panel reading S3 with the key it issued itself. What the in-memory fake cannot say: the real role lets
// the Panel's key read and write under the Core's folder, and `fail.md` written by the Panel is really in the bucket,
// read back with the bucket's admin identity.
//
// Without SEAWEEDFS_ENDPOINT it is skipped, and in the CI job that sets SEAWEEDFS_REQUIRED=1 it fails instead: a
// skipped proof is not a pass.
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createS3CoreShared } from "@actana/sdk/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { servePanelJwks, type PanelJwksServer } from "./_panel-jwks-server";
import { lazyShared } from "../task-dispatch/shared-factory";
import { FakeCore, collectingLog } from "../task-dispatch/__tests__/fakes";

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
  throw new Error("SEAWEEDFS_* is not set: the Panel's Task result watcher test must run against SeaweedFS in CI");
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

describe.skipIf(!configured)("the Task result watcher against real SeaweedFS and real STS keys, with the Core unreachable", () => {
  let jwks: PanelJwksServer;
  let testDb: Awaited<ReturnType<typeof openPanelTestDb>>;
  let tmpRoot: string;
  const mods = {} as {
    startTaskDispatch: typeof import("../task-dispatch").startTaskDispatch;
    stopTaskDispatch: typeof import("../task-dispatch").stopTaskDispatch;
    createTask: typeof import("../services/tasks").createTask;
    getTask: typeof import("../services/tasks").getTask;
    listTaskComments: typeof import("../services/tasks").listTaskComments;
    registerCoreFromCredential: typeof import("../services/cores").registerCoreFromCredential;
    storageKeyIssuer: typeof import("../services/storage").storageKeyIssuer;
    updateSharedFolder: typeof import("../repositories/core-shared-folders.repo").updateSharedFolder;
    operatorSessionCookie: typeof import("./_operator-session").operatorSessionCookie;
  };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-task-watch-sw-test-"));
    process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
    process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");
    testDb = await openPanelTestDb();
    const cores = await import("../services/cores");
    const storage = await import("../services/storage");
    const repo = await import("../repositories/core-shared-folders.repo");
    const dispatch = await import("../task-dispatch");
    const tasks = await import("../services/tasks");
    const session = await import("./_operator-session");
    Object.assign(mods, {
      startTaskDispatch: dispatch.startTaskDispatch,
      stopTaskDispatch: dispatch.stopTaskDispatch,
      createTask: tasks.createTask,
      getTask: tasks.getTask,
      listTaskComments: tasks.listTaskComments,
      registerCoreFromCredential: cores.registerCoreFromCredential,
      storageKeyIssuer: storage.storageKeyIssuer,
      updateSharedFolder: repo.updateSharedFolder,
      operatorSessionCookie: session.operatorSessionCookie,
    });

    // SeaweedFS may keep the JWKS it first read, so every test file signs with the CI job's one key. It reads it from
    // the Panel's own route (#566), which serves the public half of the master key stored below.
    const signingKey = fs.readFileSync(env.signingKeyFile!, "utf8");
    const router = await import("../api-router");
    jwks = await servePanelJwks(env.jwksPort, router.handleApiRequest);
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
    await new Promise((resolve) => jwks?.server.close(resolve));
    await resetPanelState(testDb);
    await closePanelTestDb(testDb);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  let n = 0;
  /** A Core with its Shared folder attached. No Core process exists: the watcher reads S3 and nothing else. */
  async function attachedCore(): Promise<string> {
    n += 1;
    const core = await mods.registerCoreFromCredential(
      { endpoint: `wss://sw-task-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
      { label: `sw task core ${n}`, pendingSharedFolder: true },
    );
    await mods.updateSharedFolder(1, core.id, { state: "attached", s3Prefix: `${env.prefix}/${core.id}/` }, Date.now());
    return core.id;
  }

  async function waitFor<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** The dispatcher the Panel boots, with a Core that starts no process and a through-the-Core mode that is down. */
  function dispatch(coreId: string) {
    const core = new FakeCore();
    const log = collectingLog();
    const throughCore = vi.fn(async () =>
      lazyShared(async () => {
        throw new Error("the Core is unreachable: it is paused");
      }),
    );
    const agent = { id: "agent_1", ownerId: 1, coreId, name: "Claude Code", harness: "claude-code" as const, model: null, flags: [] as string[], isDefault: false, createdAt: 1, updatedAt: 1 };
    mods.startTaskDispatch({
      env: {},
      throughCore,
      startSession: core.startSession,
      agents: { get: async () => agent, resolve: async () => ({ agentId: agent.id, coreId, harness: agent.harness, model: null, flags: [] }) },
      pollMs: 100,
      watchPollMs: 100,
      exitGraceMs: 300,
      log,
    });
    return { core, log, throughCore };
  }

  const assign = () => mods.createTask(1, { title: "Fix the build", description: "Red on main.", agent: "agent_1", startNow: true });
  /** The S3 object store's modification time has the second as its unit: let the dispatch's second pass before the Core writes. */
  const pastTheDispatchSecond = () => new Promise((resolve) => setTimeout(resolve, 2_200));

  it("a result file the Core wrote with its own key moves the Task to done, with the Core unreachable", async () => {
    const coreId = await attachedCore();
    const { core, log, throughCore } = dispatch(coreId);
    try {
      const task = await assign();
      await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);
      await pastTheDispatchSecond();

      // As the Core's sync does: its own 1-hour key, on its own prefix.
      const { issuer } = await mods.storageKeyIssuer();
      const key = await issuer.issue(coreId);
      const onCore = createS3CoreShared({ endpoint: env.endpoint!, bucket: env.bucket, prefix: `${env.prefix}/${coreId}`, credentials: { get: async () => key } });
      await onCore.put(`tasks/${task.id}/success.md`, "# Fixed\n\nThe lockfile was stale.\n\nACT-REPORT-END\n");

      await waitFor("the Task to be done", async () => (await mods.getTask(1, task.id)).status, (status) => status === "done");
      const agentComments = (await mods.listTaskComments(1, task.id)).filter((c) => c.authorKind === "agent");
      expect(agentComments).toHaveLength(1);
      expect(agentComments[0]!.body).toBe("# Fixed\n\nThe lockfile was stale.");
      expect(throughCore).not.toHaveBeenCalled();
      expect(log.errors).toEqual([]);
    } finally {
      await mods.stopTaskDispatch();
    }
  }, 120_000);

  it("an agent that exits with no result gets a fail.md the Panel wrote into the Core's folder in the bucket", async () => {
    const coreId = await attachedCore();
    const { core, throughCore } = dispatch(coreId);
    try {
      const task = await assign();
      await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);

      core.sessions[0]!.exit(1);

      await waitFor("the Task to fail", async () => (await mods.getTask(1, task.id)).status, (status) => status === "failed");
      const root = `${env.prefix}/${coreId}/`;
      expect((await adminKeys(root)).filter((k) => !k.endsWith("/"))).toEqual([`${root}tasks/${task.id}/fail.md`]);
      expect(throughCore).not.toHaveBeenCalled();
    } finally {
      await mods.stopTaskDispatch();
    }
  }, 120_000);
});
