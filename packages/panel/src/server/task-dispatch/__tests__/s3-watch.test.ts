import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createS3CoreShared } from "@actana/sdk/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "../../__tests__/_panel-test-db";
import { FakeClock, fakeSts } from "../../__tests__/_shared-fakes";
import { FakeS3 } from "../../__tests__/_shared-s3-fake";
import { lazyShared } from "../shared-factory";
import { FakeCore, collectingLog } from "./fakes";

/**
 * The Task result watcher reads the Shared folder in S3 (#570), through the same per-Core S3 mode and the same
 * server-held key the Files tab uses (#565), so a result is seen while the Core is paused. These go through
 * `startTaskDispatch`, which is what `bootPanel` calls: the real Tasks service on a real database, the real storage
 * settings and key issuer, a fake S3 that answers only for the keys it issued, and a Core that cannot be reached at
 * all: every call of the through-the-Core mode fails, and no test here may use it.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-task-s3-watch-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("../../__tests__/_operator-session");
const { registerCoreFromCredential } = await import("../../services/cores");
const { saveStorageConfig, storageKeyIssuer } = await import("../../services/storage");
const { updateSharedFolder } = await import("../../repositories/core-shared-folders.repo");
const { CoreS3Shared } = await import("../../services/core-s3-shared");
const { createTask, getTask, listTaskComments } = await import("../../services/tasks");
const { startTaskDispatch, stopTaskDispatch, TASK_TIMEOUT_ENV } = await import("../index");

const OWNER = 1;
const BUCKET = "actana-shared";
const PREFIX = "cores";
const ENDPOINT = "http://seaweedfs.test:8333";
const masterPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = masterPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const report = (text: string) => `${text}\n\nACT-REPORT-END\n`;

let n = 0;
/** A paired Core with its Shared folder attached. Nothing here can reach it. */
async function attachedCore(): Promise<string> {
  n += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://paused-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { label: `core ${n}`, pendingSharedFolder: true },
  );
  await updateSharedFolder(OWNER, core.id, { state: "attached", s3Prefix: `${PREFIX}/${core.id}/` }, Date.now());
  return core.id;
}

async function waitFor<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function rig(coreId: string, env: NodeJS.ProcessEnv = {}) {
  const clock = new FakeClock();
  const s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  const sts = fakeSts({ s3, masterPublic: masterPair.publicKey, prefix: PREFIX, clock });
  const modes = new CoreS3Shared({
    issuer: (ownerId) => storageKeyIssuer(ownerId, { fetch: sts.fetch, now: clock.now }),
    s3: ({ target, folder, key }) =>
      createS3CoreShared({
        endpoint: target.endpoint,
        bucket: target.bucket,
        prefix: folder.replace(/\/+$/, ""),
        region: target.region,
        credentials: { get: async () => key },
        fetch: s3.fetch,
        now: clock.now,
      }),
    now: clock.now,
  });
  const core = new FakeCore();
  const log = collectingLog();
  // A client for a Core is built without a connection, so building one works; every call to it fails.
  const throughCore = vi.fn(async () =>
    lazyShared(async () => {
      throw new Error("the Core is unreachable: it is paused");
    }),
  );
  const agent = {
    id: "agent_1",
    ownerId: OWNER,
    coreId,
    name: "Claude Code",
    harness: "claude-code" as const,
    model: null,
    flags: [] as string[],
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  };
  startTaskDispatch({
    env,
    modes,
    throughCore,
    startSession: core.startSession,
    agents: {
      get: async () => agent,
      resolve: async () => ({ agentId: agent.id, coreId, harness: agent.harness, model: null, flags: [] }),
    },
    now: clock.now,
    pollMs: 15,
    watchPollMs: 15,
    exitGraceMs: 10_000,
    log,
  });
  return { clock, s3, sts, core, log, throughCore };
}

const assign = (clock: FakeClock) =>
  createTask(OWNER, { title: "Fix the build", description: "Red on main.", agent: "agent_1", startNow: true }, clock.now());

beforeEach(async () => {
  resetOperatorSessionForTests();
  await operatorSessionCookie();
  await saveStorageConfig({
    backend: "seaweedfs",
    endpoint: ENDPOINT,
    bucket: BUCKET,
    prefix: PREFIX,
    oidcIssuer: "https://panel.test",
    keyId: "k1",
    masterKey: MASTER_PEM,
  });
});
afterEach(async () => {
  await stopTaskDispatch();
  await resetPanelState(testDb);
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the Core is unreachable and a result file in S3 still moves the Task", { timeout: 30_000 }, () => {
  it("success.md becomes done with the report as an agent comment", async () => {
    const coreId = await attachedCore();
    const { clock, s3, core, log, throughCore } = await rig(coreId);
    const task = await assign(clock);
    await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);

    // Written by the agent on the Core, synced to S3 after the dispatch.
    s3.seed(`${PREFIX}/${coreId}/tasks/${task.id}/success.md`, report("# Fixed\n\nThe lockfile was stale."), clock.now() + 1_000);

    await waitFor("the Task to be done", async () => (await getTask(OWNER, task.id)).status, (status) => status === "done");
    const comments = await listTaskComments(OWNER, task.id);
    const agentComments = comments.filter((c) => c.authorKind === "agent");
    expect(agentComments).toHaveLength(1);
    expect(agentComments[0]!.body).toBe("# Fixed\n\nThe lockfile was stale.");
    expect(throughCore).not.toHaveBeenCalled();
    // Where a read that failed would show: the watcher logs it, and there is none.
    expect(log.errors).toEqual([]);
    expect(s3.requests.some((r) => r.method === "GET" && r.key.endsWith(`tasks/${task.id}/success.md`))).toBe(true);
  });

  it("fail.md and partial-1.md move it to failed and partial", async () => {
    const coreId = await attachedCore();
    const { clock, s3, core } = await rig(coreId);
    const failing = await assign(clock);
    await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);
    s3.seed(`${PREFIX}/${coreId}/tasks/${failing.id}/fail.md`, report("could not reproduce"), clock.now() + 1_000);
    await waitFor("failed", async () => (await getTask(OWNER, failing.id)).status, (status) => status === "failed");

    const partial = await assign(clock);
    await waitFor("the second Session", async () => core.starts.length, (count) => count === 2);
    s3.seed(`${PREFIX}/${coreId}/tasks/${partial.id}/partial-1.md`, report("half done"), clock.now() + 1_000);
    await waitFor("partial", async () => (await getTask(OWNER, partial.id)).status, (status) => status === "partial");
  });

  it("an agent that exits with no result gets a fail.md written to S3, not through the Core", async () => {
    const coreId = await attachedCore();
    const { clock, s3, core, throughCore } = await rig(coreId);
    const task = await assign(clock);
    await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);

    core.sessions[0]!.exit(1);
    await clock.advance(11_000);

    await waitFor("the Task to fail", async () => (await getTask(OWNER, task.id)).status, (status) => status === "failed");
    expect(s3.text(`${PREFIX}/${coreId}/tasks/${task.id}/fail.md`)).toContain("exited (code 1) without writing a result file");
    expect(s3.requests.some((r) => r.method === "PUT" && r.key === `${PREFIX}/${coreId}/tasks/${task.id}/fail.md`)).toBe(true);
    expect(throughCore).not.toHaveBeenCalled();
  });

  it("a Task that runs past the timeout gets a fail.md written to S3", async () => {
    const coreId = await attachedCore();
    const { clock, s3, core, throughCore } = await rig(coreId, { [TASK_TIMEOUT_ENV]: "2" });
    const task = await assign(clock);
    await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);

    await clock.advance(2 * 60_000 + 1);

    await waitFor("the Task to fail", async () => (await getTask(OWNER, task.id)).status, (status) => status === "failed");
    expect(s3.text(`${PREFIX}/${coreId}/tasks/${task.id}/fail.md`)).toContain("no result within 2 minutes");
    expect(throughCore).not.toHaveBeenCalled();
  });

  it("a Task that runs past the life of its Core's key keeps reading with a new one", async () => {
    const coreId = await attachedCore();
    const { clock, s3, sts, core, log } = await rig(coreId);
    const task = await assign(clock);
    await waitFor("the Session to start", async () => core.starts.length, (count) => count === 1);
    const issuedAtDispatch = sts.issued.length;

    // The key lives an hour and the timeout is the same: well past the key's refresh point, short of the timeout.
    await clock.advance(55 * 60_000);
    s3.seed(`${PREFIX}/${coreId}/tasks/${task.id}/success.md`, report("done late"), clock.now() + 1_000);

    await waitFor("the Task to be done", async () => (await getTask(OWNER, task.id)).status, (status) => status === "done");
    expect(sts.issued.length).toBeGreaterThan(issuedAtDispatch);
    expect(log.errors).toEqual([]);
  });
});
