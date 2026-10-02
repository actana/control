import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createS3CoreShared } from "@actana/sdk/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import { FakeClock, fakeSts, settle } from "./_shared-fakes";
import { FakeS3 } from "./_shared-s3-fake";

/**
 * Task attachments (#568 step 3, #571): `POST /api/tasks` and `POST /api/tasks/:id/comments` as multipart, through the
 * real router, session gate and key issuer, on a fake S3 that answers only for the keys it issued. What is asserted: the
 * files land under the Task's Core prefix as `tasks/<id>/attachments/…`, as the Task's owner; every path is confined;
 * a result file's name is no collision; a Task started with files is a draft until every file is written and stays one
 * when a write fails; and a second owner reaches nothing of the first's.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-task-attachments-test-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");
const { registerCoreFromCredential } = await import("../services/cores");
const { saveStorageConfig, storageKeyIssuer } = await import("../services/storage");
const { SharedFiles, resetSharedFilesForTests } = await import("../services/shared-files");
const { updateSharedFolder } = await import("../repositories/core-shared-folders.repo");
const tasksService = await import("../services/tasks");
const { createTaskWithAttachments } = await import("../services/task-attachments");
const { classifyTaskEntry } = await import("~/shared/task-report");

const ORIGIN = "http://panel.example.test";
const BUCKET = "actana-shared";
const PREFIX = "cores";
const MASTER = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MASTER_PEM = MASTER.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const LIMIT = 64;
const A = 1;
const B = 2;

let n = 0;
async function attachedCore(owner = A, state: "attached" | "pending" = "attached"): Promise<string> {
  n += 1;
  const core = await registerCoreFromCredential(
    { endpoint: `wss://att-core-${n}.test:7777`, caCert: "ca", clientCert: "cert", clientKey: "key", bearer: "b" },
    { label: `core ${n}`, ownerId: owner, pendingSharedFolder: true },
  );
  if (state === "attached") await updateSharedFolder(owner, core.id, { state: "attached", s3Prefix: `${PREFIX}/${core.id}/` }, Date.now());
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ($1,$2,$3,'claude-code','claude-code','{}',true,1,1)",
    [`agent-${core.id}`, owner, core.id],
  );
  return core.id;
}

let rigState: { clock: FakeClock; s3: FakeS3; sts: ReturnType<typeof fakeSts> };
function rig() {
  const clock = new FakeClock();
  const s3 = new FakeS3(BUCKET);
  s3.clock = clock.now;
  const sts = fakeSts({ s3, masterPublic: MASTER.publicKey, prefix: PREFIX, clock });
  resetSharedFilesForTests(
    new SharedFiles({
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
    }),
  );
  rigState = { clock, s3, sts };
  return rigState;
}

async function call(pathname: string, init: { method?: string; body?: BodyInit; json?: unknown; cookie?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== false) headers.cookie = await operatorSessionCookie();
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await handleApiRequest(
    new Request(`${ORIGIN}${pathname}`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
  );
  return res!;
}

/** A multipart request as the dialog sends it: the JSON body, then each file with its path. */
function form(json: unknown, files: { path: string; content: string }[] = []): FormData {
  const f = new FormData();
  f.set("json", JSON.stringify(json));
  f.set("paths", JSON.stringify(files.map((x) => x.path)));
  for (const x of files) f.append("files", new File([x.content], x.path.split("/").pop()!));
  return f;
}
const createWith = (json: unknown, files: { path: string; content: string }[], cookie = true) => call("/api/tasks", { body: form(json, files), cookie });
const key = (core: string, taskId: string, rel: string) => `${PREFIX}/${core}/tasks/${taskId}/attachments/${rel}`;
const writes = () => rigState.s3.requests.filter((r) => r.method === "PUT");
const statusOf = async (id: string, owner = A) => (await tasksService.getTask(owner, id)).status;
const taskCount = async () => Number((await testDb.pool.query("select count(*) as c from tasks")).rows[0].c);

beforeAll(async () => {
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  await testDb.pool.query("insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'owner-2', 'h', 1, 1)");
  for (const owner of [A, B]) {
    await saveStorageConfig(
      { backend: "seaweedfs", endpoint: "http://seaweedfs.test:8333", bucket: BUCKET, prefix: PREFIX, oidcIssuer: "https://panel.test", keyId: "k1", masterKey: MASTER_PEM, uploadSizeLimitBytes: LIMIT },
      owner,
    );
  }
});
beforeEach(() => void rig());
afterEach(() => resetSharedFilesForTests(null));
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a Task created with attachments", () => {
  it("is a draft with its files under shared/tasks/<id>/attachments/ in its Core's prefix, folder tree kept", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const res = await createWith({ title: "Fix it", coreId: core, agent: `agent-${core}` }, [
      { path: "brief.md", content: "# brief" },
      { path: "design/mock/a.png", content: "png" },
    ]);
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(task.status).toBe("draft");
    expect(s3.text(key(core, task.id, "brief.md"))).toBe("# brief");
    expect(s3.text(key(core, task.id, "design/mock/a.png"))).toBe("png");
    // Nothing but the Task's own folder was written, and nothing outside this Core's prefix.
    expect([...s3.objects.keys()].every((k) => k.startsWith(`${PREFIX}/${core}/tasks/${task.id}/attachments/`))).toBe(true);
    // The agent is told what was attached the way it is told everything the operator said: as a user comment.
    const comments = await tasksService.listTaskComments(A, task.id);
    expect(comments.map((c) => c.authorKind)).toEqual(["user"]);
    expect(comments[0]!.body).toContain(`~/shared/tasks/${task.id}/attachments/`);
    expect(comments[0]!.body).toContain("- design/mock/a.png");
  });

  it("with Start now is assigned only after every file is written, and never before", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    // Hold the second PUT: the first file is in, the Task must still be a draft.
    let puts = 0;
    const held = s3.hold((r) => r.method === "PUT" && ++puts === 2);
    const pending = createWith({ title: "Go", coreId: core, agent: `agent-${core}`, startNow: true }, [
      { path: "one.txt", content: "1" },
      { path: "two.txt", content: "2" },
    ]);
    await held.reached;
    const rows = (await testDb.pool.query("select id, status from tasks where core_id = $1", [core])).rows as { id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(s3.text(key(core, rows[0].id, "one.txt"))).toBe("1");
    expect(s3.objects.has(key(core, rows[0].id, "two.txt"))).toBe(false);
    held.release();
    const res = await pending;
    expect(res.status).toBe(201);
    expect((await res.json()).task.status).toBe("assigned");
    expect(s3.text(key(core, rows[0].id, "two.txt"))).toBe("2");
    const history = await testDb.pool.query("select to_status from task_status_history where task_id = $1 order by seq", [rows[0]!.id]);
    expect((history.rows as { to_status: string }[]).map((r) => r.to_status)).toEqual(["draft", "assigned"]);
  });

  it("keeps the Task a draft, and says which file and why, when a write goes over the upload limit as it is read", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    // The service's own limit counts the bytes as they arrive: a stream that outgrows its declared size is refused mid-write.
    const lying = { path: "grows.bin", size: 1, stream: () => new Blob(["z".repeat(LIMIT + 1)]).stream() };
    const err = await createTaskWithAttachments(A, { title: "Over", coreId: core, agent: `agent-${core}`, startNow: true }, [lying], "op").catch((e) => e);
    expect(err).toMatchObject({ name: "TaskAttachmentError", path: "grows.bin" });
    expect(err.message).toContain("grows.bin");
    expect(await statusOf(err.taskId)).toBe("draft");
    expect(s3.objects.has(key(core, err.taskId, "grows.bin"))).toBe(false);
  });

  it("keeps the Task a draft when the Core has no Shared folder to write to", async () => {
    const core = await attachedCore(A, "pending");
    const res = await createWith({ title: "No folder", coreId: core, agent: `agent-${core}`, startNow: true }, [{ path: "a.txt", content: "a" }]);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("a.txt");
    expect(await statusOf(body.taskId)).toBe("draft");
    expect(writes()).toHaveLength(0);
  });

  it("keeps the Task a draft when a later file's write is refused by the store", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const first = s3.hold((r) => r.method === "PUT");
    const pending = createWith({ title: "Half", coreId: core, agent: `agent-${core}`, startNow: true }, [
      { path: "a.txt", content: "a" },
      { path: "b.txt", content: "b" },
    ]);
    await first.reached;
    // The key the Panel holds is revoked while the first write is in flight: the store says 403 to the next call.
    s3.keys.clear();
    first.release();
    const res = await pending;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(await statusOf(body.taskId)).toBe("draft");
  });

  it("puts a file called success.md, fail.md, partial-1.md or attempt-1.log in attachments/, never where the dispatcher watches", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const names = ["success.md", "fail.md", "partial-1.md", "attempt-1.log", "attempt-2-success.md"];
    const res = await createWith({ title: "Names", coreId: core, agent: `agent-${core}`, startNow: true }, names.map((p) => ({ path: p, content: "x" })));
    const { task } = await res.json();
    const folder = `${PREFIX}/${core}/tasks/${task.id}/`;
    for (const name of names) {
      expect(s3.objects.has(`${folder}attachments/${name}`)).toBe(true);
      // The key straight under the Task's folder is what the watcher reads: it is empty.
      expect(s3.objects.has(`${folder}${name}`)).toBe(false);
      // And the name the watcher would classify for what is written is not a result.
      expect(classifyTaskEntry(`attachments/${name}`)).toEqual({ kind: "other" });
    }
    // The control: the same names straight under the Task's folder ARE results.
    expect(classifyTaskEntry("success.md").kind).toBe("result");
  });

  it("refuses a path that leaves the attachments folder, before anything is created or written", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const before = await taskCount();
    for (const bad of ["../escape.txt", "a/../../b.txt", "/abs.txt", "a//b.txt", "a\\b.txt", "dir/", ".", ""]) {
      const res = await createWith({ title: "Bad", coreId: core }, [{ path: bad, content: "x" }]);
      expect(res.status, `path ${JSON.stringify(bad)}`).toBe(400);
    }
    const dup = await createWith({ title: "Dup", coreId: core }, [
      { path: "a.txt", content: "1" },
      { path: "a.txt", content: "2" },
    ]);
    expect(dup.status).toBe(400);
    expect(await taskCount()).toBe(before);
    expect(s3.objects.size).toBe(0);
  });

  it("needs a Core, and every file's path", async () => {
    const before = await taskCount();
    expect((await createWith({ title: "No core" }, [{ path: "a.txt", content: "a" }])).status).toBe(400);
    const f = form({ title: "Skewed" }, [{ path: "a.txt", content: "a" }]);
    f.set("paths", "[]");
    expect((await call("/api/tasks", { body: f })).status).toBe(400);
    expect(await taskCount()).toBe(before);
  });

  it("refuses attachments that together pass the upload limit, before reading them", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const before = await taskCount();
    const res = await createWith({ title: "Total", coreId: core }, [
      { path: "a.bin", content: "a".repeat(LIMIT - 1) },
      { path: "b.bin", content: "b".repeat(LIMIT - 1) },
    ]);
    expect(res.status).toBe(413);
    expect(await taskCount()).toBe(before);
    expect(s3.objects.size).toBe(0);
  });

  it("applies the limit stored in Storage settings, read on each request", async () => {
    const core = await attachedCore();
    const set = (uploadSizeLimitBytes: number) =>
      saveStorageConfig({ backend: "seaweedfs", endpoint: "http://seaweedfs.test:8333", bucket: BUCKET, prefix: PREFIX, oidcIssuer: "https://panel.test", keyId: "k1", uploadSizeLimitBytes }, A);
    const files = [{ path: "a.bin", content: "a".repeat(LIMIT - 1) }, { path: "b.bin", content: "b".repeat(LIMIT - 1) }];
    try {
      await set(1_000);
      expect((await createWith({ title: "Roomy", coreId: core }, files)).status).toBe(201);
      await set(10);
      const tight = await createWith({ title: "Tight", coreId: core }, [{ path: "c.bin", content: "c".repeat(11) }]);
      expect(tight.status).toBe(413);
      expect(tight.headers.get("x-upload-limit")).toBe("10");
    } finally {
      await set(LIMIT);
    }
  });

  it("without files is the JSON route as it was", async () => {
    const core = await attachedCore();
    const res = await call("/api/tasks", { json: { title: "Plain", coreId: core, agent: `agent-${core}`, startNow: true } });
    expect(res.status).toBe(201);
    expect((await res.json()).task.status).toBe("assigned");
    expect(writes()).toHaveLength(0);
  });

  it("needs the operator's session", async () => {
    const core = await attachedCore();
    const before = await taskCount();
    expect((await createWith({ title: "x", coreId: core }, [{ path: "a.txt", content: "a" }], false)).status).toBe(401);
    expect(await taskCount()).toBe(before);
  });
});

describe("two owners", () => {
  it("writes an owner's attachments under their own Core, as them", async () => {
    const { s3, sts } = rigState;
    const bobCore = await attachedCore(B);
    const task = await createTaskWithAttachments(B, { title: "Bob's", coreId: bobCore, agent: `agent-${bobCore}`, startNow: true }, [
      { path: "b.txt", size: 1, stream: () => new Blob(["b"]).stream() },
    ], "bob");
    expect(task.ownerId).toBe(B);
    expect(task.status).toBe("assigned");
    expect(s3.text(key(bobCore, task.id, "b.txt"))).toBe("b");
    expect(sts.issued.length).toBeGreaterThan(0);
  });

  it("refuses another owner's Core and Task: nothing created, no key issued, no S3 request", async () => {
    const { s3, sts } = rigState;
    const bobCore = await attachedCore(B);
    const bobTask = await tasksService.createTask(B, { title: "Bob's", coreId: bobCore });
    const before = await taskCount();
    const issued = sts.issued.length;

    const create = await createWith({ title: "Mine now", coreId: bobCore }, [{ path: "a.txt", content: "a" }]);
    expect(create.status).toBe(404);
    const comment = await call(`/api/tasks/${bobTask.id}/comments`, { body: form({ body: "hi" }, [{ path: "a.txt", content: "a" }]) });
    expect(comment.status).toBe(404);

    expect(await taskCount()).toBe(before);
    expect(sts.issued).toHaveLength(issued);
    expect(s3.requests).toHaveLength(0);
    expect(await tasksService.listTaskComments(B, bobTask.id)).toHaveLength(0);
  });
});

describe("a comment with a file", () => {
  async function finishedTask(core: string, status: "done" | "failed" = "done") {
    const t = await tasksService.createTask(A, { title: "T", coreId: core, agent: `agent-${core}`, startNow: true });
    await tasksService.claimTask(A, t.id);
    await tasksService.applyTaskResult(A, t.id, { to: status, authorName: "agent", body: "done", sourceFile: "success.md" });
    return t;
  }

  it("is written under the Task's attachments folder and named in the comment", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const t = await tasksService.createTask(A, { title: "T", coreId: core });
    const res = await call(`/api/tasks/${t.id}/comments`, { body: form({ body: "see the log" }, [{ path: "build.log", content: "log" }]) });
    expect(res.status).toBe(201);
    expect(s3.text(key(core, t.id, "build.log"))).toBe("log");
    const { comment } = await res.json();
    expect(comment.body).toContain("see the log");
    expect(comment.body).toContain("- build.log");
  });

  it("with Comment & re-assign writes the file before the Task is assigned, and not at all for a Task that is not finished", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const t = await finishedTask(core);
    const held = s3.hold((r) => r.method === "PUT");
    const pending = call(`/api/tasks/${t.id}/comments`, { body: form({ body: "again", reassign: true }, [{ path: "more.md", content: "m" }]) });
    await held.reached;
    expect(await statusOf(t.id)).toBe("done");
    held.release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).task.status).toBe("assigned");
    expect(s3.text(key(core, t.id, "more.md"))).toBe("m");

    // Now it is assigned, not finished: the same call is refused and writes nothing.
    const writesBefore = writes().length;
    const again = await call(`/api/tasks/${t.id}/comments`, { body: form({ body: "x", reassign: true }, [{ path: "late.md", content: "l" }]) });
    expect(again.status).toBe(409);
    expect(writes()).toHaveLength(writesBefore);
    expect(s3.objects.has(key(core, t.id, "late.md"))).toBe(false);
  });

  it("adds no comment and moves nothing when the write fails", async () => {
    const core = await attachedCore();
    const t = await finishedTask(core);
    const commentsBefore = (await tasksService.listTaskComments(A, t.id)).length;
    const res = await call(`/api/tasks/${t.id}/comments`, { body: form({ body: "again", reassign: true }, [{ path: "big.bin", content: "z".repeat(LIMIT + 1) }]) });
    expect(res.status).toBe(413);
    expect(await statusOf(t.id)).toBe("done");
    expect(await tasksService.listTaskComments(A, t.id)).toHaveLength(commentsBefore);
  });

  it("refuses to overwrite a file an earlier comment attached", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const t = await tasksService.createTask(A, { title: "T", coreId: core });
    expect((await call(`/api/tasks/${t.id}/comments`, { body: form({ body: "one" }, [{ path: "a.txt", content: "first" }]) })).status).toBe(201);
    const second = await call(`/api/tasks/${t.id}/comments`, { body: form({ body: "two" }, [{ path: "a.txt", content: "second" }]) });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("a.txt");
    expect(s3.text(key(core, t.id, "a.txt"))).toBe("first");
  });

  it("refuses a path that leaves the attachments folder", async () => {
    const { s3 } = rigState;
    const core = await attachedCore();
    const t = await tasksService.createTask(A, { title: "T", coreId: core });
    const res = await call(`/api/tasks/${t.id}/comments`, { body: form({ body: "x" }, [{ path: "../success.md", content: "fake" }]) });
    expect(res.status).toBe(400);
    expect(s3.objects.size).toBe(0);
    await settle(2);
  });
});
