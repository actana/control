import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/**
 * answer_task and the `prompt` of get_task (#959), over REST and MCP, against the Panel's database and a fake Core link
 * that serves a committed PTY fixture of #963 and records every byte written to it.
 */

process.env.AC_SECRETS_KEY = "55".repeat(32);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-task-answer-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const { handleApiRequest } = await import("../api-router");
const testDb = await openPanelTestDb();
const { operatorSessionCookie } = await import("./_operator-session");
const { createApiKey } = await import("../services/api-keys");
const { MCP_TOOLS } = await import("../mcp-tools");
const { setTaskInputDepsForTests, sessionPromptFeed } = await import("../task-dispatch/task-answer");

const ORIGIN = "http://panel.example.test";
const NOW = Date.now();
const AT = NOW - 60_000;
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "../../../../core/src/__tests__/fixtures", `${name}.txt`), "utf8");

let screen = "";
let writes: string[] = [];
let writeOk = true;

async function seed(id: string, sessionState: string | null, coreId = "core-a", agent = "agent-a") {
  await testDb.pool.query(
    `insert into tasks (id, owner_id, title, description, status, core_id, agent, attempt_count, dispatched_at, timeout_minutes,
       session_state, session_state_at, created_at, updated_at)
     values ($1, 1, $2, 'brief', 'in_progress', $3, $4, 1, $5, 60, $6, $7, 1, 1)`,
    [id, `t ${id}`, coreId, agent, NOW - 1000, sessionState, sessionState === null ? null : AT],
  );
}

async function rest(key: string, pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const res = await handleApiRequest(
    new Request(`${ORIGIN}${pathAndQuery}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } }),
  );
  if (!res) throw new Error("no api response");
  return res;
}
const answer = (key: string, id: string, body: unknown) => rest(key, `/api/v1/tasks/${id}/answer`, { method: "POST", body: JSON.stringify(body) });
const getTask = async (key: string, id: string) => ((await (await rest(key, `/api/v1/tasks/${id}`)).json()) as { task: Record<string, any>; comments: { authorName: string; body: string }[] });

let key: string;

/** The fake Core link: serves `screen`, records what is written. `link` is replaceable per test. */
function installFakeCore(link?: () => null): void {
  setTaskInputDepsForTests({
    link:
      link ??
      (() => ({
        sdk: {
          findBySession: async () => ({ ptyId: "pty-1" }),
          replay: async () => ({ data: screen, nextSeq: 1 }),
          write: async (_pty: string, data: string) => {
            if (writeOk) writes.push(data);
            return writeOk;
          },
        },
      })),
    session: async (_owner, taskId) => ({ coreId: "core-a", sessionId: `s-${taskId}` }),
  });
}

beforeAll(async () => {
  await operatorSessionCookie();
  await testDb.pool.query("insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ('core-a', 1, 'a', 'https://a', 1, 1), ('core-b', 1, 'b', 'https://b', 1, 1)");
  await testDb.pool.query(
    "insert into agents (id, owner_id, core_id, name, harness, flags, is_default, created_at, updated_at) values ('agent-a', 1, 'core-a', 'Agent A', 'codex', '{}', false, 1, 1), ('agent-c', 1, 'core-a', 'Agent C', 'claude-code', '{}', false, 1, 1)",
  );
  key = (await createApiKey(1, { name: "orchestrator", permissions: ["read", "tasks:write"] })).key;
  installFakeCore();
});

beforeEach(async () => {
  await testDb.pool.query("delete from task_comments");
  await testDb.pool.query("delete from tasks");
  screen = fixture("codex-synthetic-allow-command");
  writes = [];
  writeOk = true;
  installFakeCore(); // also forgets which prompts were answered
});

afterAll(async () => {
  setTaskInputDepsForTests(null);
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("get_task: what a waiting Task asks", () => {
  it("source 2, a dialog no hook announced: kind choice with the options, from classifyDialog", async () => {
    await seed("t1", "needs-input");
    const { task } = await getTask(key, "t1");
    expect(task.prompt).toMatchObject({ kind: "choice", at: AT, source: "screen" });
    expect(task.prompt.text).toContain("Would you like to run the following command?");
    expect(task.prompt.options.map((o: { key: string }) => o.key)).toEqual(["1", "2", "3"]);
  });

  it("source 1, the hook that set needs-input: its kind and its parsed options win", async () => {
    await seed("t1", "needs-input", "core-a", "agent-c");
    screen = "Which database?\n";
    sessionPromptFeed().push("core-a", "session:prompt", JSON.stringify({ sessionId: "s-t1", kind: "choice", text: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }));
    const { task } = await getTask(key, "t1");
    expect(task.prompt).toMatchObject({ kind: "choice", source: "hook", options: [{ label: "Postgres", key: "1" }, { label: "SQLite", key: "2" }] });
    // The hint ends with the dialog: a status that leaves needs-input drops it.
    sessionPromptFeed().push("core-a", "session:updated", JSON.stringify({ sessionId: "s-t1", status: "running" }));
    expect((await getTask(key, "t1")).task.prompt).toMatchObject({ kind: "unknown", source: "screen" });
  });

  it("source 3, neither: unknown, the text only, no options", async () => {
    await seed("t1", "needs-input");
    screen = "something odd is on screen\n";
    const { task } = await getTask(key, "t1");
    expect(task.prompt.kind).toBe("unknown");
    expect(task.prompt.options).toBeUndefined();
    expect(task.prompt.text).toContain("something odd");
  });

  it("a Task whose Session is not waiting has no prompt; one whose Core cannot be read has prompt null", async () => {
    await seed("t-work", "working");
    expect("prompt" in (await getTask(key, "t-work")).task).toBe(false);
    await seed("t-ask", "needs-input");
    installFakeCore(() => null);
    try {
      expect((await getTask(key, "t-ask")).task.prompt).toBeNull();
    } finally {
      installFakeCore();
    }
  });
});

describe("answer_task over REST", () => {
  it("a choice dialog: { option: 2 } types the option and adds one comment", async () => {
    await seed("t1", "needs-input");
    screen = fixture("generic-synthetic-numbered-choice");
    const res = await answer(key, "t1", { answer: { option: 2 }, expect: AT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answered: { kind: "choice", at: AT, answer: 'option 2 "production"' } });
    expect(writes).toEqual(["2"]);
    const { comments } = await getTask(key, "t1");
    const recorded = comments.filter((c) => c.body.startsWith("Answered by"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.authorName).toBe("orchestrator (API key)");
    expect(recorded[0]!.body).toBe('Answered by orchestrator (API key): choice "Choose a deployment target" → option 2 "production"');
  });

  it("an expect older than the current prompt is stale_prompt and nothing is typed", async () => {
    await seed("t1", "needs-input");
    const res = await answer(key, "t1", { answer: { option: 1 }, expect: AT - 5000 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "stale_prompt" });
    expect(writes).toEqual([]);
  });

  it("answering the same prompt twice: the second is stale_prompt", async () => {
    await seed("t1", "needs-input");
    screen = fixture("generic-synthetic-numbered-choice");
    expect((await answer(key, "t1", { answer: { keys: ["Enter"] } })).status).toBe(200);
    const again = await answer(key, "t1", { answer: { keys: ["Enter"] } });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "stale_prompt" });
    expect(writes).toEqual(["\r"]);
  });

  it("a Task not in needs-input is refused and nothing is typed", async () => {
    await seed("t1", "working");
    await seed("t2", null);
    for (const id of ["t1", "t2"]) {
      const res = await answer(key, id, { answer: { keys: ["Enter"] } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "not_waiting" });
    }
    expect(writes).toEqual([]);
  });

  it("trust, a password prompt and a permission that widens access are needs_human, nothing typed", async () => {
    await seed("t-trust", "needs-input", "core-a", "agent-c");
    screen = fixture("claude-code-2.1.228-folder-trust");
    let res = await answer(key, "t-trust", { answer: { keys: ["Enter"] } });
    expect([res.status, (await res.json()).code]).toEqual([409, "needs_human"]);

    await seed("t-pass", "needs-input");
    screen = "Enter your password:\n";
    res = await answer(key, "t-pass", { answer: { keys: ["Enter"] } });
    expect([res.status, (await res.json()).code]).toEqual([409, "needs_human"]);

    await seed("t-perm", "needs-input", "core-a", "agent-c");
    screen = fixture("claude-code-synthetic-bash-permission");
    res = await answer(key, "t-perm", { answer: { option: 1 } });
    expect([res.status, (await res.json()).code]).toEqual([409, "needs_human"]);
    expect(writes).toEqual([]);
    // The decline is answered.
    res = await answer(key, "t-perm", { answer: { option: 3 } });
    expect(res.status).toBe(200);
    expect(writes).toEqual(["3"]);
  });

  it("keys outside the allowlist are refused (400) and nothing is typed", async () => {
    await seed("t1", "needs-input");
    for (const answerBody of [{ keys: ["Ctrl-C"] }, { keys: ["Enter", "Delete"] }, { keys: [] }]) {
      const res = await answer(key, "t1", { answer: answerBody });
      expect(res.status, JSON.stringify(answerBody)).toBe(400);
    }
    expect(writes).toEqual([]);
  });

  it("an unknown prompt takes { keys } only: { text } and { option } are refused and nothing is typed", async () => {
    await seed("t1", "needs-input");
    screen = "something odd is on screen\n";
    for (const answerBody of [{ text: "yes" }, { option: 1 }]) {
      const res = await answer(key, "t1", { answer: answerBody });
      expect([res.status, (await res.json()).code]).toEqual([400, "invalid_answer"]);
    }
    expect(writes).toEqual([]);
    expect((await answer(key, "t1", { answer: { keys: ["Enter"] } })).status).toBe(200);
    expect(writes).toEqual(["\r"]);
  });

  it("a Core that does not take the write: 502 write_failed, no comment", async () => {
    await seed("t1", "needs-input");
    screen = fixture("generic-synthetic-numbered-choice");
    writeOk = false;
    const res = await answer(key, "t1", { answer: { keys: ["Enter"] } });
    expect([res.status, (await res.json()).code]).toEqual([502, "write_failed"]);
    expect((await getTask(key, "t1")).comments.filter((c) => c.body.startsWith("Answered by"))).toEqual([]);
  });

  it("needs tasks:write, and a key outside the Task's Core gets 403", async () => {
    await seed("t1", "needs-input");
    const readOnly = (await createApiKey(1, { name: "ro", permissions: ["read"] })).key;
    expect((await answer(readOnly, "t1", { answer: { keys: ["Enter"] } })).status).toBe(403);
    const other = (await createApiKey(1, { name: "other", permissions: ["read", "tasks:write"], coreIds: ["core-b"] })).key;
    expect((await answer(other, "t1", { answer: { keys: ["Enter"] } })).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("a body that is not an answer is a 400", async () => {
    await seed("t1", "needs-input");
    for (const body of [{}, { answer: {} }, { answer: { text: "a", keys: ["y"] } }, { answer: { text: "" } }]) {
      expect((await answer(key, "t1", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(writes).toEqual([]);
  });
});

describe("approvals are not answered, whatever kind the rules give them", () => {
  it("Codex's allow-command dialog is a choice: approving it (also for good) is needs_human, the No is answered", async () => {
    await seed("t1", "needs-input");
    for (const answerBody of [{ option: 1 }, { option: 2 }, { keys: ["Enter"] }, { keys: ["y"] }, { text: "y" }, { text: "1" }, { text: "yes" }]) {
      const res = await answer(key, "t1", { answer: answerBody });
      expect([res.status, (await res.json()).code], JSON.stringify(answerBody)).toEqual([409, "needs_human"]);
    }
    expect(writes).toEqual([]);
    expect((await answer(key, "t1", { answer: { option: 3 } })).status).toBe(200);
    expect(writes).toEqual(["3"]);
    // The record names the prompt (the dialog's question), not whatever sits above the dialog on the screen.
    const recorded = (await getTask(key, "t1")).comments.filter((c) => c.body.startsWith("Answered by"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.body).toContain("Would you like to run the following command?");
    expect(recorded[0]!.body).not.toContain("Running tests");
  });

  it("a prompt that moves while the screen is read is stale_prompt, nothing typed", async () => {
    await seed("t1", "needs-input");
    setTaskInputDepsForTests({
      link: () => ({
        sdk: {
          findBySession: async () => ({ ptyId: "pty-1" }),
          replay: async () => {
            await testDb.pool.query("update tasks set session_state_at = $1 where id = 't1'", [AT + 1000]);
            return { data: screen, nextSeq: 1 };
          },
          write: async (_p: string, d: string) => (writes.push(d), true),
        },
      }),
      session: async (_o, taskId) => ({ coreId: "core-a", sessionId: `s-${taskId}` }),
    });
    const res = await answer(key, "t1", { answer: { option: 3 }, expect: AT });
    expect([res.status, (await res.json()).code]).toEqual([409, "stale_prompt"]);
    expect(writes).toEqual([]);
  });
});

describe("answer_task over MCP", () => {
  async function mcp(permissions: ("read" | "tasks:write")[] = ["read", "tasks:write"]): Promise<McpTestClient> {
    const c = new McpTestClient((await createApiKey(1, { name: "mcp key", permissions })).key);
    await c.connect();
    return c;
  }

  it("is a tasks:write tool that is not read-only, named in MCP_TOOLS, and hidden from a read-only key", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "answer_task")!;
    expect([tool.permission, tool.readOnly]).toEqual(["tasks:write", false]);
    expect((await (await mcp(["read"])).listTools()).map((t) => t.name)).not.toContain("answer_task");
    expect((await (await mcp()).listTools()).map((t) => t.name)).toContain("answer_task");
  });

  it("get_task shows the prompt, answer_task { option: 2 } continues the Session and one comment records it", async () => {
    await seed("t1", "needs-input");
    screen = fixture("generic-synthetic-numbered-choice");
    const c = await mcp();
    const read = dataOf(await c.call("get_task", { taskId: "t1" }));
    expect(read.task.prompt).toMatchObject({ kind: "choice", at: AT });
    const result = await c.call("answer_task", { taskId: "t1", answer: { option: 2 }, expect: read.task.prompt.at });
    expect(result.isError).toBeUndefined();
    expect(dataOf(result).answered).toMatchObject({ kind: "choice", at: AT });
    expect(writes).toEqual(["2"]);
    const comments = dataOf(await c.call("get_task", { taskId: "t1" })).comments as { body: string; authorName: string }[];
    expect(comments.filter((x) => x.body.startsWith("Answered by mcp key (API key): choice"))).toHaveLength(1);
  });

  it("a refusal is a tool error that leads with the status and the code", async () => {
    await seed("t1", "needs-input");
    const result = await (await mcp()).call("answer_task", { taskId: "t1", answer: { keys: ["Enter"] }, expect: AT - 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^409 .*stale_prompt|409 stale_prompt|409/);
    expect(writes).toEqual([]);
  });
});
