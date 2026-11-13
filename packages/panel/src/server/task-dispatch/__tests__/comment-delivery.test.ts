import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";
import { collectingLog } from "./fakes";

/**
 * A comment on a running Task goes into its Session, "now" mode (#935). The real Tasks service on a real (PGlite or Postgres)
 * database; the Core's end of the link is a fake that records what is typed and can refuse like #924's blocked Session.
 */

/** The Panel's shared Core connection, as the real default typer reaches it (#935 r2): a link client whose sdk is a spy. */
const linkSdk = vi.hoisted(() => ({
  calls: [] as string[],
  deliveries: [] as string[],
  ptyId: "pty_1" as string | null,
  refuse: false,
}));
vi.mock("../../services/core-link-manager", () => ({
  coreLinkManager: () => ({
    client: () => ({
      sdk: {
        findBySession: async (id: string) => {
          linkSdk.calls.push(`findBySession:${id}`);
          return { ptyId: linkSdk.ptyId };
        },
        deliver: async (ptyId: string, data: string) => {
          linkSdk.calls.push(`deliver:${ptyId}`);
          if (linkSdk.refuse) return { ok: false, deliveryEventId: 0 };
          linkSdk.deliveries.push(data);
          return { ok: true, deliveryEventId: 1 };
        },
        ptySubscribe: async () => linkSdk.calls.push("ptySubscribe"),
        ptyUnsubscribe: async () => linkSdk.calls.push("ptyUnsubscribe"),
        replay: async () => linkSdk.calls.push("replay"),
        subscribe: async () => linkSdk.calls.push("subscribe"),
        unsubscribe: async () => linkSdk.calls.push("unsubscribe"),
      },
    }),
  }),
}));

const testDb = await openPanelTestDb();
const tasks = await import("../../services/tasks");
const { deliverCommentNow, commentTypedLine, MAX_DELIVERED_COMMENT_CHARS } = await import("../comment-delivery");
const { formatTaskDispatchComment } = await import("~/shared/tasks");

const A = 1;

beforeAll(async () => {
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1) on conflict do nothing",
    [A, `owner-${A}`],
  );
  await testDb.pool.query("insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core_1', $1, 'c', 'https://c', 1, 1) on conflict do nothing", [A]);
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent_1',$1,'core_1','Agent','claude-code','{}',false,1,1) on conflict do nothing",
    [A],
  );
});
beforeEach(async () => {
  await testDb.pool.query("truncate tasks cascade");
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

/** A Task that is running with a Session recorded, the way dispatch leaves it. */
async function runningTask() {
  const task = await tasks.createTask(A, { title: "t", coreId: "core_1", agent: "agent_1", startNow: true });
  await tasks.claimTask(A, task.id);
  await tasks.addTaskComment(A, task.id, {
    authorKind: "system",
    authorName: "Panel",
    body: formatTaskDispatchComment({ attempt: 1, coreId: "core_1", sessionId: "ses_1", agentName: "Agent", harness: "claude-code" }),
  });
  return task;
}

function fakeCore(opts: { blocked?: boolean; attachFails?: string } = {}) {
  const typed: string[] = [];
  const attached: string[] = [];
  let disposed = 0;
  return {
    typed,
    attached,
    get disposed() {
      return disposed;
    },
    attach: async (coreId: string, sessionId: string) => {
      if (opts.attachFails) throw new Error(opts.attachFails);
      attached.push(`${coreId}/${sessionId}`);
      return {
        // The Core refuses a stamped write into a needs-input Session (#924): ok false, nothing typed.
        deliver: async (text: string) => {
          if (opts.blocked) return { ok: false };
          typed.push(text);
          return { ok: true };
        },
        dispose: () => {
          disposed += 1;
        },
      };
    },
  };
}

async function note(taskId: string, body: string) {
  return tasks.addTaskComment(A, taskId, { authorKind: "user", authorName: "Mehdi", body });
}

describe("deliverCommentNow", () => {
  it("types the comment, then the return, into the running Task's Session", async () => {
    const task = await runningTask();
    const core = fakeCore();
    const comment = await note(task.id, "please also cover the empty case");
    const out = await deliverCommentNow(A, task.id, comment, { attach: core.attach, log: collectingLog() });
    expect(out).toEqual({ mode: "now", delivered: true });
    expect(core.attached).toEqual(["core_1/ses_1"]);
    expect(core.typed).toEqual([commentTypedLine(task.id, comment), "\r"]);
    expect(core.typed[0]).toContain("New comment on your Task");
    expect(core.disposed).toBe(1);
    // Delivered: no refusal note is added.
    expect((await tasks.listTaskComments(A, task.id)).filter((c) => c.authorKind === "system" && c.body.startsWith("Not typed"))).toHaveLength(0);
  });

  it("types nothing into a Session that needs input, and keeps the comment as a note with the reason", async () => {
    const task = await runningTask();
    await tasks.setTaskSessionState(A, task.id, "needs-input");
    const core = fakeCore();
    const comment = await note(task.id, "go ahead");
    const out = await deliverCommentNow(A, task.id, comment, { attach: core.attach, log: collectingLog() });
    expect(out).toMatchObject({ mode: "now", delivered: false });
    expect(out.reason).toMatch(/waiting for input/);
    expect(core.attached).toEqual([]);
    expect(core.typed).toEqual([]);
    const thread = await tasks.listTaskComments(A, task.id);
    expect(thread.map((c) => c.body)).toContain("go ahead");
    expect(thread.at(-1)).toMatchObject({ authorKind: "system", authorName: "Panel" });
    expect(thread.at(-1)!.body).toMatch(/^Not typed into the Session: the Session is waiting for input/);
  });

  it("when the Core refuses the write as blocked (the Panel had not heard yet), nothing is typed and the reason is kept", async () => {
    const task = await runningTask();
    const core = fakeCore({ blocked: true });
    const out = await deliverCommentNow(A, task.id, await note(task.id, "x"), { attach: core.attach, log: collectingLog() });
    expect(out).toMatchObject({ delivered: false });
    expect(core.typed).toEqual([]);
    expect(core.disposed).toBe(1);
    expect((await tasks.listTaskComments(A, task.id)).at(-1)!.body).toMatch(/^Not typed into the Session: the Core did not take it/);
  });

  it("keeps the comment as a note when the Task is not running", async () => {
    const task = await tasks.createTask(A, { title: "t", coreId: "core_1", agent: "agent_1" });
    const core = fakeCore();
    const out = await deliverCommentNow(A, task.id, await note(task.id, "x"), { attach: core.attach, log: collectingLog() });
    expect(out).toEqual({ mode: "now", delivered: false, reason: "the Task is draft, not running" });
    expect(core.attached).toEqual([]);
  });

  it("keeps the comment as a note when the Task has no Session recorded or the link is gone", async () => {
    const bare = await tasks.createTask(A, { title: "t", coreId: "core_1", agent: "agent_1", startNow: true });
    await tasks.claimTask(A, bare.id);
    const core = fakeCore();
    expect(await deliverCommentNow(A, bare.id, await note(bare.id, "x"), { attach: core.attach, log: collectingLog() })).toMatchObject({ delivered: false, reason: "the Task has no Session recorded" });
    const task = await runningTask();
    const down = fakeCore({ attachFails: "there is no live link to this Core" });
    expect(await deliverCommentNow(A, task.id, await note(task.id, "y"), { attach: down.attach, log: collectingLog() })).toMatchObject({ delivered: false, reason: "there is no live link to this Core" });
  });
});

describe("the default typer (the Panel's shared Core connection)", () => {
  beforeEach(() => {
    linkSdk.calls.length = 0;
    linkSdk.deliveries.length = 0;
    linkSdk.ptyId = "pty_1";
    linkSdk.refuse = false;
  });

  it("types through the link client and never subscribes, unsubscribes or replays the PTY", async () => {
    const task = await runningTask();
    const comment = await note(task.id, "please also cover the empty case");
    const out = await deliverCommentNow(A, task.id, comment, { log: collectingLog() });
    expect(out).toEqual({ mode: "now", delivered: true });
    expect(linkSdk.deliveries).toEqual([commentTypedLine(task.id, comment), "\r"]);
    expect(linkSdk.calls).toEqual(["findBySession:ses_1", "deliver:pty_1", "deliver:pty_1"]);
    for (const forbidden of ["ptySubscribe", "ptyUnsubscribe", "replay", "subscribe", "unsubscribe"]) expect(linkSdk.calls).not.toContain(forbidden);
  });

  it("refuses when the Session has no harness running, and types nothing", async () => {
    const task = await runningTask();
    linkSdk.ptyId = null;
    const out = await deliverCommentNow(A, task.id, await note(task.id, "x"), { log: collectingLog() });
    expect(out).toEqual({ mode: "now", delivered: false, reason: "the Session has no harness running" });
    expect(linkSdk.deliveries).toEqual([]);
    expect(linkSdk.calls).toEqual(["findBySession:ses_1"]);
  });

  it("keeps #924's refusal: a write the Core does not take is a kept note", async () => {
    const task = await runningTask();
    linkSdk.refuse = true;
    const out = await deliverCommentNow(A, task.id, await note(task.id, "x"), { log: collectingLog() });
    expect(out).toMatchObject({ delivered: false });
    expect(out.reason).toMatch(/the Core did not take it/);
    expect(linkSdk.calls).not.toContain("ptyUnsubscribe");
  });
});

describe("commentTypedLine", () => {
  it("ends with where the reply goes: the attempt's report", () => {
    const line = commentTypedLine("t1", { authorName: "o", body: "what is the status?" });
    expect(line).toContain("(answer in your report: ~/shared/tasks/t1/");
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const long = commentTypedLine("t1", { authorName: "o", body: "x".repeat(MAX_DELIVERED_COMMENT_CHARS + 50) });
    expect(long).toMatch(/\(answer in your report: ~\/shared\/tasks\/t1\/[^)]*\)$/);
  });

  it("carries no control character: nothing in a comment or a key name can steer the terminal", async () => {
    const line = commentTypedLine("t", { authorName: "k\x1b[201~ (API key)", body: "a\x03b\x1b[31m\x7fc\u0085d" });
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(line).toContain("a b [31m c d");
    const task = await runningTask();
    const core = fakeCore();
    await deliverCommentNow(A, task.id, await note(task.id, "x\x03y"), { attach: core.attach, log: collectingLog() });
    expect(core.typed[0]).not.toMatch(/\x03/);
  });

  it("is one line and cut when long", () => {
    expect(commentTypedLine("t1", { authorName: "k (API key)", body: "a\n\nb\tc" })).toMatch(/^New comment on your Task t1 from k \(API key\): a b c \(answer in your report: /);
    const long = commentTypedLine("t1", { authorName: "o", body: "x".repeat(MAX_DELIVERED_COMMENT_CHARS + 50) });
    expect(long).toContain("x".repeat(MAX_DELIVERED_COMMENT_CHARS));
    expect(long).not.toContain("x".repeat(MAX_DELIVERED_COMMENT_CHARS + 1));
    expect(long).toMatch(/\(cut: read the whole comment on the Task\) \(answer in your report: /);
  });
});
