import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { closePanelTestDb, openPanelTestDb } from "../../__tests__/_panel-test-db";

const testDb = await openPanelTestDb();
const agentsService = await import("../agents");
const { ConflictError, NotFoundError, ValidationError } = await import("../../errors");
const {
  CoreHarnessesUnavailableError,
  HarnessMissingOnCoreError,
  createAgent,
  deleteAgent,
  ensureDefaultAgents,
  getAgent,
  listAgents,
  listAgentsForCore,
  resolveAgent,
} = agentsService;

const A = 1;
const B = 2;

const available = (...ids: string[]): CoreLinkHarnessAvailabilityMap =>
  Object.fromEntries(ids.map((id) => [id, { status: "available" as const }]));

/** What the Core reports, per Core id. A Core not in the table is one the link has no client for. */
let reported: Record<string, CoreLinkHarnessAvailabilityMap> = {};
const deps = {
  harnesses: async (coreId: string) => {
    const map = reported[coreId];
    if (!map) throw new Error("no link");
    return map;
  },
};

beforeAll(async () => {
  await testDb.pool.query("alter table operator drop constraint operator_single_row");
  for (const id of [A, B]) {
    await testDb.pool.query(
      "insert into operator (id, name, password_hash, created_at, password_changed_at) values ($1, $2, 'h', 1, 1)",
      [id, `owner-${id}`],
    );
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, 'c', $3, 1, 1), ($4, $2, 'c', $5, 1, 1)",
      [`core-${id}`, id, `https://core-${id}`, `core-${id}b`, `https://core-${id}b`],
    );
  }
});
beforeEach(async () => {
  await testDb.pool.query("truncate agents");
  reported = {
    "core-1": available("claude-code", "codex"),
    "core-1b": available("pi"),
    "core-2": available("claude-code"),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closePanelTestDb(testDb);
});

describe("create, list and delete", () => {
  it("creates an Agent on a Core, lists it, reads it and deletes it", async () => {
    const made = await createAgent(A, { coreId: "core-1", name: "Reviewer", harness: "claude-code", model: "claude-opus-4-1", flags: ["skip-permissions"] }, deps);
    expect(made).toMatchObject({ ownerId: A, coreId: "core-1", name: "Reviewer", harness: "claude-code", model: "claude-opus-4-1", flags: ["skip-permissions"], isDefault: false });
    expect((await listAgents(A)).map((a) => a.id)).toEqual([made.id]);
    expect((await listAgents(A, "core-1b")).map((a) => a.id)).toEqual([]);
    expect((await getAgent(A, made.id)).name).toBe("Reviewer");
    await deleteAgent(A, made.id);
    expect(await listAgents(A)).toEqual([]);
    await expect(getAgent(A, made.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteAgent(A, made.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("trims the name, drops a blank model, and sorts and dedupes the flags", async () => {
    const made = await createAgent(A, { coreId: "core-1", name: "  Spaced  ", harness: "codex", model: "  ", flags: ["skip-permissions", "skip-permissions"] }, deps);
    expect(made).toMatchObject({ name: "Spaced", model: null, flags: ["skip-permissions"] });
  });

  it("refuses a blank name, a long name, and a taken name on the same Core", async () => {
    const input = { coreId: "core-1", harness: "codex" } as const;
    await expect(createAgent(A, { ...input, name: "   " }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(createAgent(A, { ...input, name: "x".repeat(61) }, deps)).rejects.toBeInstanceOf(ValidationError);
    await createAgent(A, { ...input, name: "one" }, deps);
    await expect(createAgent(A, { ...input, name: "one" }, deps)).rejects.toBeInstanceOf(ConflictError);
    expect(await listAgents(A)).toHaveLength(1);
  });

  it("refuses an unknown Core", async () => {
    await expect(createAgent(A, { coreId: "nope", name: "n", harness: "codex" }, deps)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("two owners", () => {
  it("shows owner B nothing of owner A's Agents, and refuses B's read and delete as not found", async () => {
    const mine = await createAgent(A, { coreId: "core-1", name: "mine", harness: "codex" }, deps);
    expect(await listAgents(B)).toEqual([]);
    await expect(getAgent(B, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteAgent(B, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveAgent(B, mine.id, deps)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getAgent(A, mine.id)).id).toBe(mine.id);
  });

  it("refuses owner B an Agent on owner A's Core, writing nothing", async () => {
    await expect(createAgent(B, { coreId: "core-1", name: "evil", harness: "codex" }, deps)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listAgents(A)).toEqual([]);
    expect(await listAgents(B)).toEqual([]);
  });
});

describe("a harness the Core has", () => {
  it("refuses an Agent that names a harness the Core does not report, writing nothing", async () => {
    await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "opencode" }, deps)).rejects.toBeInstanceOf(HarnessMissingOnCoreError);
    expect(await listAgents(A)).toEqual([]);
  });

  it("refuses a harness the Core reports as missing, outdated or still checking", async () => {
    for (const status of ["missing", "outdated", "checking"] as const) {
      reported["core-1"] = { codex: { status } };
      await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "codex" }, deps)).rejects.toBeInstanceOf(HarnessMissingOnCoreError);
    }
    expect(await listAgents(A)).toEqual([]);
  });

  it("refuses a harness the Core reports as needing setup, so no Task is dispatched into it (#685)", async () => {
    reported["core-1"] = { "claude-code": { status: "missing", reason: "needs-setup: folder-trust", path: "/bin/claude" } };
    await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "claude-code" }, deps)).rejects.toBeInstanceOf(HarnessMissingOnCoreError);
    expect(await listAgents(A)).toEqual([]);
  });

  it("refuses with its own error when the Core cannot be asked", async () => {
    delete reported["core-1"];
    await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "codex" }, deps)).rejects.toBeInstanceOf(CoreHarnessesUnavailableError);
    expect(await listAgents(A)).toEqual([]);
  });

  it("resolves an Agent to the harness the Core reports, and to nothing once the Core loses it", async () => {
    const made = await createAgent(A, { coreId: "core-1", name: "n", harness: "codex", model: "gpt-5" }, deps);
    expect(await resolveAgent(A, made.id, deps)).toEqual({ agentId: made.id, coreId: "core-1", harness: "codex", model: "gpt-5", flags: [] });
    reported["core-1"] = available("claude-code");
    await expect(resolveAgent(A, made.id, deps)).rejects.toBeInstanceOf(HarnessMissingOnCoreError);
    delete reported["core-1"];
    await expect(resolveAgent(A, made.id, deps)).rejects.toBeInstanceOf(CoreHarnessesUnavailableError);
  });
});

describe("no raw shell command", () => {
  const base = { coreId: "core-1", name: "n", harness: "claude-code" } as const;

  it.each(["command", "cmd", "args", "script", "shell", "env", "cwd", "apiKey"])("refuses a %s field and writes nothing", async (field) => {
    await expect(createAgent(A, { ...base, [field]: "rm -rf /" } as never, deps)).rejects.toThrow(/unknown field/);
    expect(await listAgents(A)).toEqual([]);
  });

  it.each(["x; rm -rf /", "$(id)", "a b", "`id`", "a\nb", "m'odel", "--dangerously-skip-permissions", "-p", "a|b", "a&b", "a>b"])(
    "refuses the model %j",
    async (model) => {
      await expect(createAgent(A, { ...base, model }, deps)).rejects.toBeInstanceOf(ValidationError);
      expect(await listAgents(A)).toEqual([]);
    },
  );

  it("accepts the model ids the harnesses really use", async () => {
    for (const [i, model] of ["claude-opus-4-1", "gpt-5.1-codex", "anthropic/claude-sonnet-4", "openai:gpt-5", "sonnet[1m]".replace(/[[\]]/g, "")].entries()) {
      await createAgent(A, { ...base, name: `m${i}`, model }, deps);
    }
    expect(await listAgents(A)).toHaveLength(5);
  });

  it("accepts only the closed flag set, and only where the harness has the flag", async () => {
    for (const flags of [["--yolo"], ["--dangerously-skip-permissions"], ["skip-permissions; id"], ["bogus"], [""]]) {
      await expect(createAgent(A, { ...base, flags }, deps)).rejects.toBeInstanceOf(ValidationError);
    }
    reported["core-1"] = available("claude-code", "opencode", "pi");
    await expect(createAgent(A, { ...base, harness: "opencode", flags: ["skip-permissions"] }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(createAgent(A, { ...base, harness: "pi", flags: ["skip-permissions"] }, deps)).rejects.toBeInstanceOf(ValidationError);
    expect(await listAgents(A)).toEqual([]);
  });

  it("refuses a harness id that is not a known harness, even one the Core reports", async () => {
    reported["core-1"] = { bash: { status: "available" } };
    await expect(createAgent(A, { ...base, harness: "bash" as never }, deps)).rejects.toBeInstanceOf(ValidationError);
  });

  it("has no way to spawn a process in the agent files", () => {
    const root = path.resolve(import.meta.dirname, "..", "..", "..");
    const files = ["server/services/agents.ts", "server/repositories/agents.repo.ts", "shared/agents.ts"];
    for (const f of files) {
      expect(readFileSync(path.join(root, f), "utf8"), f).not.toMatch(
        /child_process|node:child_process|\bspawn\b|\bexecFile?\b|\beval\(|new Function|node-pty/,
      );
    }
  });
});

describe("platform model keys", () => {
  // Built at run time: a literal key-shaped string in the source would trip `scripts/scan-secrets.mjs`.
  const fake = (prefix: string, length: number) => prefix + "x1Y2".repeat(length).slice(0, length);
  const KEY = fake("sk-", 40);

  it("never reach an Agent: not in a row, a listing, a resolution or a refusal, with a key in the Panel's environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("OPENAI_API_KEY", `${KEY}-openai`);
    const made = await createAgent(A, { coreId: "core-1", name: "n", harness: "claude-code", model: "claude-opus-4-1", flags: ["skip-permissions"] }, deps);
    const seen = [
      made,
      await listAgents(A),
      await getAgent(A, made.id),
      await resolveAgent(A, made.id, deps),
      await listAgentsForCore(A, "core-1", deps),
      (await testDb.pool.query("select * from agents")).rows,
    ];
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(Object.keys(await resolveAgent(A, made.id, deps)).sort()).toEqual(["agentId", "coreId", "flags", "harness", "model"]);
  });

  it("is refused as a model or a name, when it is the value of a key the Panel holds", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("OPENROUTER_API_KEY", "or-key-value-12345");
    await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "claude-code", model: KEY }, deps)).rejects.toThrow(/platform key/);
    await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "claude-code", model: "or-key-value-12345" }, deps)).rejects.toThrow(/platform key/);
    await expect(createAgent(A, { coreId: "core-1", name: `label ${KEY}`, harness: "claude-code" }, deps)).rejects.toThrow(/platform key/);
    expect(await listAgents(A)).toEqual([]);
  });

  it("is refused as a model when it merely looks like a provider key", async () => {
    const models = [fake("sk-ant-api03-", 20), fake("sk-proj-", 24), fake("AIza", 35), fake("ghp_", 36), fake("hf_", 26)];
    for (const model of models) {
      await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "claude-code", model }, deps)).rejects.toThrow(/platform key/);
    }
  });

  it("is not a field an Agent accepts, whatever it is called", async () => {
    for (const field of ["apiKey", "api_key", "key", "token", "env", "environment", "secrets", "ANTHROPIC_API_KEY"]) {
      await expect(createAgent(A, { coreId: "core-1", name: "n", harness: "claude-code", [field]: KEY } as never, deps)).rejects.toThrow(/unknown field/);
    }
  });
});

describe("a default Agent for each harness a Core has", () => {
  it("creates one default per harness the Core reports available, and none for the others", async () => {
    reported["core-1"] = { "claude-code": { status: "available" }, codex: { status: "available" }, opencode: { status: "missing" }, pi: { status: "checking" } };
    const made = await ensureDefaultAgents(A, "core-1", deps);
    expect(made.map((a) => [a.harness, a.isDefault, a.name, a.model, a.flags]).sort()).toEqual([
      ["claude-code", true, "Claude Code", null, []],
      ["codex", true, "Codex", null, []],
    ]);
    expect((await listAgents(A, "core-1")).map((a) => a.harness).sort()).toEqual(["claude-code", "codex"]);
    expect(await listAgents(A, "core-1b")).toEqual([]);
  });

  it("is idempotent, and safe when two calls race", async () => {
    await ensureDefaultAgents(A, "core-1", deps);
    await Promise.all([ensureDefaultAgents(A, "core-1", deps), ensureDefaultAgents(A, "core-1", deps)]);
    expect(await listAgents(A, "core-1")).toHaveLength(2);
  });

  it("gives a harness that arrives later its default, and keeps the earlier ones", async () => {
    await ensureDefaultAgents(A, "core-1", deps);
    reported["core-1"] = available("claude-code", "codex", "pi");
    const all = await ensureDefaultAgents(A, "core-1", deps);
    expect(all.map((a) => a.harness).sort()).toEqual(["claude-code", "codex", "pi"]);
    expect(await listAgents(A, "core-1")).toHaveLength(3);
  });

  it("keeps a default Agent when the harness goes missing, and still resolves it to nothing", async () => {
    const [first] = await ensureDefaultAgents(A, "core-1b", deps);
    reported["core-1b"] = { pi: { status: "missing" } };
    expect(await listAgents(A, "core-1b")).toHaveLength(1);
    await expect(resolveAgent(A, first!.id, deps)).rejects.toBeInstanceOf(HarnessMissingOnCoreError);
  });

  it("finds a name an operator already took, and uses another for the default", async () => {
    await createAgent(A, { coreId: "core-1", name: "Claude Code", harness: "codex" }, deps);
    const made = await ensureDefaultAgents(A, "core-1", deps);
    expect(made.find((a) => a.harness === "claude-code")).toMatchObject({ isDefault: true, name: "Claude Code (default)" });
  });

  it("keeps each Core's defaults apart, and each owner's", async () => {
    await ensureDefaultAgents(A, "core-1", deps);
    await ensureDefaultAgents(A, "core-1b", deps);
    await ensureDefaultAgents(B, "core-2", deps);
    expect((await listAgents(A, "core-1b")).map((a) => a.harness)).toEqual(["pi"]);
    expect((await listAgents(B)).map((a) => a.coreId)).toEqual(["core-2"]);
    await expect(ensureDefaultAgents(B, "core-1", deps)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let a default Agent be deleted, but lets any other", async () => {
    const [def] = await ensureDefaultAgents(A, "core-1b", deps);
    await expect(deleteAgent(A, def!.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await getAgent(A, def!.id)).toBeTruthy();
    const mine = await createAgent(A, { coreId: "core-1b", name: "mine", harness: "pi" }, deps);
    await deleteAgent(A, mine.id);
  });

  it("makes the default Agent's listing the one place that ensures them, and lists without them when the Core cannot be asked", async () => {
    const listed = await listAgentsForCore(A, "core-1", deps);
    expect(listed.map((a) => a.harness).sort()).toEqual(["claude-code", "codex"]);
    delete reported["core-1b"];
    await expect(listAgentsForCore(A, "core-1b", deps)).resolves.toEqual([]);
  });
});
