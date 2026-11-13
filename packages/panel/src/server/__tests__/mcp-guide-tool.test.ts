import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TASK_SESSION_STATES } from "~/shared/tasks";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, textOf } from "./_mcp-client";

/**
 * The `get_guide` tool (#952): the Task hand-off and wait recipe, served by the Panel itself, so any MCP caller can
 * learn it and changing it is a Panel change only. The guides are Markdown files in `server/guides/`.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-guide-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { createApiKey } = await import("../services/api-keys");
const { MCP_TOOLS } = await import("../mcp-tools");
const { GUIDE_TOPICS, guideMarkdown } = await import("../mcp-guides");

const GUIDES_DIR = path.resolve(__dirname, "../guides");

async function client(permissions: ("read" | "tasks:write" | "agents:write")[] = ["read"]): Promise<McpTestClient> {
  const { key } = await createApiKey(1, { name: "k", permissions });
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

/**
 * What a guide says that must exist: every word that looks like a tool name (a verb, an underscore, a noun) is a tool
 * in `MCP_TOOLS`; every `tool({ field: … })` example uses fields of that tool's input; every `watch.<x>` is a field of
 * the watch object. Returns the problems, empty when the guide is sound.
 */
function unknownReferences(markdown: string): string[] {
  const problems: string[] = [];
  const toolNames = new Set(MCP_TOOLS.map((t) => t.name));
  const verbs = /^(get|list|create|update|delete|assign|comment|stop|close|answer|fetch|send|read|set|add|run|start|cancel|wait)_[a-z_]+$/;
  for (const word of markdown.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
    if (verbs.test(word) && !toolNames.has(word)) problems.push(`unknown tool ${word}`);
  }
  for (const call of markdown.matchAll(/\b([a-z]+(?:_[a-z]+)+)\(\{([^}]*)\}\)/g)) {
    const tool = MCP_TOOLS.find((t) => t.name === call[1]);
    if (!tool) continue; // already reported above
    const fields = new Set(Object.keys(tool.input.shape));
    const body = call[2]!.replace(/"[^"]*"/g, '""');
    for (const key of body.matchAll(/([A-Za-z]+)\s*:/g)) {
      if (!fields.has(key[1]!)) problems.push(`${tool.name} has no field ${key[1]}`);
    }
  }
  for (const watch of markdown.matchAll(/\bwatch\.([A-Za-z]+)/g)) {
    if (!["url", "expiresAt", "pollAfterSeconds"].includes(watch[1]!)) problems.push(`watch has no field ${watch[1]}`);
  }
  return problems;
}

beforeAll(() => fs.mkdirSync(tmpRoot, { recursive: true }));
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await operatorSessionCookie();
});
afterAll(async () => {
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("get_guide over /mcp", () => {
  it("is listed for a key with read, as a read-only tool", async () => {
    const tools = await (await client(["read"])).listTools();
    const guide = tools.find((t) => t.name === "get_guide");
    expect(guide).toBeDefined();
    expect(guide!.annotations.readOnlyHint).toBe(true);
    expect(guide!.inputSchema.properties.topic.enum).toEqual([...GUIDE_TOPICS]);
    expect(guide!.inputSchema.required ?? []).not.toContain("topic");
  });

  it("is a read tool: permission read, readOnly", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_guide")!;
    expect(tool.permission).toBe("read");
    expect(tool.readOnly).toBe(true);
  });

  it("names the six topics", () => {
    expect([...GUIDE_TOPICS]).toEqual(["overview", "hand-off", "waiting", "states", "blocked", "comments"]);
  });

  it.each([...["overview", "hand-off", "waiting", "states", "blocked", "comments"]])("topic %s returns non-empty Markdown", async (topic) => {
    const result = await (await client()).call("get_guide", { topic });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(200);
    expect(text).toMatch(/^# /);
    expect(() => JSON.parse(text)).toThrow(); // Markdown text, not a JSON document
  });

  it("with no topic returns the overview and the topic list", async () => {
    const c = await client();
    const none = textOf(await c.call("get_guide"));
    const overview = textOf(await c.call("get_guide", { topic: "overview" }));
    expect(none).toContain(overview.trimEnd());
    for (const topic of GUIDE_TOPICS) expect(none, topic).toContain(`\`${topic}\``);
    expect(none).toContain("get_guide");
  });

  it("answers an unknown topic with a tool error that names the valid ones", async () => {
    const result = await (await client()).call("get_guide", { topic: "cooking" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("topic");
    for (const topic of GUIDE_TOPICS) expect(text, topic).toContain(topic);
  });

  it("guideMarkdown refuses an unknown topic itself", () => {
    expect(() => guideMarkdown("cooking" as never)).toThrow(/overview/);
  });

  it("the instructions tell the caller to call get_guide first", async () => {
    const c = await client();
    const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.instructions as string).toMatch(/call get_guide first/i);
  });
});

describe("the guide files", () => {
  const files = fs.readdirSync(GUIDES_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));

  it("every topic in the tool's schema has a file, and every file is a topic", () => {
    const schema = MCP_TOOLS.find((t) => t.name === "get_guide")!.input.shape.topic as unknown as { unwrap(): { options: string[] } };
    expect([...schema.unwrap().options].sort()).toEqual([...files].sort());
  });

  it("every file is served by guideMarkdown, byte for byte", () => {
    for (const topic of GUIDE_TOPICS) {
      if (topic === "overview") continue; // the overview is served with the topic list after it
      expect(guideMarkdown(topic).trimEnd(), topic).toBe(fs.readFileSync(path.join(GUIDES_DIR, `${topic}.md`), "utf8").trimEnd());
    }
  });

  it("every tool, field and watch field a guide names exists (the name check)", () => {
    for (const topic of GUIDE_TOPICS) {
      expect(unknownReferences(fs.readFileSync(path.join(GUIDES_DIR, `${topic}.md`), "utf8")), topic).toEqual([]);
    }
  });

  it("the name check fails when a guide mentions a tool, a field or a watch field that does not exist", () => {
    expect(unknownReferences("Call `get_everything` first.")).toEqual(["unknown tool get_everything"]);
    expect(unknownReferences('`create_task({ title: "x", colour: "red" })`')).toEqual(["create_task has no field colour"]);
    expect(unknownReferences("Read `watch.href`.")).toEqual(["watch has no field href"]);
    expect(unknownReferences('`create_task({ title: "a: b", startNow: true })` then `watch.url`.')).toEqual([]);
  });

  it("every tool in MCP_TOOLS a guide recipe relies on is named by at least one guide", () => {
    const all = GUIDE_TOPICS.map((t) => fs.readFileSync(path.join(GUIDES_DIR, `${t}.md`), "utf8")).join("\n");
    for (const name of ["list_agents", "create_task", "assign_task", "get_task", "comment_task", "stop_task", "close_session", "list_cores"]) {
      expect(all, name).toContain(name);
    }
  });
});

describe("what the guide teaches", () => {
  const read = (topic: string) => fs.readFileSync(path.join(GUIDES_DIR, `${topic}.md`), "utf8");

  it("hand-off: create or assign a Task with a named Agent, and a timeout does not prove non-delivery", () => {
    const text = read("hand-off");
    expect(text).toContain("list_agents");
    expect(text).toMatch(/create_task\(\{[^}]*startNow: true/);
    expect(text).toContain("assign_task");
    expect(text).toMatch(/a timeout does not prove non-delivery/i);
    expect(text).toContain("read the Task before you resend");
  });

  it("hand-off: list with get_tasks (lean rows, no brief), read one brief with get_task (#957)", () => {
    const text = read("hand-off");
    expect(text).toMatch(/list with `get_tasks`.*read one Task's brief with `get_task`/i);
    expect(text).toContain("no description");
  });

  it("waiting: watch.url with actana task wait, or a curl loop that honours pollAfterSeconds and Retry-After", () => {
    const text = read("waiting");
    expect(text).toContain("watch.url");
    expect(text).toContain("actana task wait");
    expect(text).toContain("curl");
    expect(text).toContain("pollAfterSeconds");
    expect(text).toContain("Retry-After");
    expect(text).toMatch(/not.*(loop|poll).*get_task|never.*get_task/i);
    const block = /```bash\n([\s\S]*?)```/.exec(text)![1]!;
    expect(block).not.toMatch(/sleep 5\b/);
    expect(block).toContain("pollAfterSeconds");
    expect(block).toMatch(/429\)/);
    expect(block).toMatch(/retry-after/i);
  });

  it("states: every sessionState and what to do, and the result file is the only success signal", () => {
    const text = read("states");
    for (const state of TASK_SESSION_STATES) expect(text, state).toContain(`\`${state}\``);
    expect(text).toMatch(/result file/i);
    expect(text).toMatch(/only/i);
  });

  it("states: a recipe that re-assigns also stops the Task first (a Session state never moves the status)", () => {
    const rows = read("states")
      .split("\n")
      .filter((l) => l.startsWith("|") && /reassign/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain("stop_task");
  });

  it("blocked: do not stop a Task you did not create", () => {
    const text = read("blocked");
    expect(text).toMatch(/do not stop a Task you did not create/i);
    expect(text).toContain("stop_task");
  });

  it("comments: comment and re-assign", () => {
    const text = read("comments");
    expect(text).toContain("comment_task");
    expect(text).toContain("reassign: true");
    expect(text).toMatch(/time limit.*any status/);
  });
});
