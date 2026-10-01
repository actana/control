import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CoreSharedError, type CoreShared, type SharedEntry, type SharedFile } from "@actana/sdk/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { McpTestClient, dataOf, textOf } from "./_mcp-client";

/**
 * `list_shared` and `get_shared` over `/mcp` (#573): read-only, confined to the
 * Shared folder of a Core the key reaches, `..` and absolute paths refused,
 * answers capped.
 *
 * The stand-in Core below reads the disk with a plain `path.join` and checks
 * nothing, on purpose: a real Core refuses `..` itself, but the Panel must not
 * depend on that, so these tests only pass if the Panel's own path check keeps
 * the request from ever reaching the Core. `secret.txt` sits OUTSIDE the Shared
 * folder and is what a path that got through would read.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-shared-"));
process.env.AC_USER_DATA_DIR = path.join(tmpRoot, "app");
process.env.AC_PANEL_DATA_DIR = path.join(tmpRoot, "panel");

const testDb = await openPanelTestDb();
const { operatorSessionCookie, resetOperatorSessionForTests } = await import("./_operator-session");
const { createApiKey } = await import("../services/api-keys");
const { setSharedResolverForTests, MAX_FILE_BYTES, MAX_LIST_ENTRIES } = await import("../mcp-shared");

const A = 1;
const B = 2;
const sharedDirs: Record<string, string> = {
  "core-a": path.join(tmpRoot, "core-a", "shared"),
  "core-b": path.join(tmpRoot, "core-b", "shared"),
};

/** Every call that reached a Core, as `coreId op path`. */
let reached: string[] = [];
let resolved = 0;

function diskShared(coreId: string): CoreShared {
  const root = sharedDirs[coreId]!;
  const note = (op: string, p: string) => reached.push(`${coreId} ${op} ${p}`);
  const entry = (rel: string): SharedEntry => {
    const stat = fs.statSync(path.join(root, rel));
    return stat.isDirectory()
      ? { path: rel, kind: "folder" }
      : { path: rel, kind: "file", size: stat.size, modifiedAt: stat.mtime };
  };
  const refuse = () => {
    throw new Error("a read-only tool must never write");
  };
  return {
    async list(p) {
      note("list", p);
      const dir = path.join(root, p);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((name) => entry(path.posix.join(p, name)));
    },
    async get(p): Promise<SharedFile> {
      note("get", p);
      const full = path.join(root, p);
      if (!fs.existsSync(full)) throw new CoreSharedError("not-found", "no such file");
      if (fs.statSync(full).isDirectory()) throw new CoreSharedError("is-folder", "that is a folder");
      const e = entry(p);
      return { ...(e as SharedEntry), kind: "file", size: e.size ?? 0, body: new Uint8Array(fs.readFileSync(full)) };
    },
    put: refuse,
    mkdir: refuse,
    rm: refuse,
    move: refuse,
    upload: refuse,
    watch: refuse,
    signedUrl: refuse,
  };
}

async function seed() {
  await operatorSessionCookie();
  await testDb.pool.query("alter table operator drop constraint if exists operator_single_row");
  await testDb.pool.query(
    "insert into operator (id, name, password_hash, created_at, password_changed_at) values (2, 'B', 'h', 1, 1) on conflict do nothing",
  );
  for (const [id, owner] of [
    ["core-a", A],
    ["core-b", A],
    ["core-x", B],
  ] as const) {
    await testDb.pool.query(
      "insert into cores (id, owner_id, label, endpoint, created_at, updated_at) values ($1, $2, $1, $3, 1, 1)",
      [id, owner, `https://${id}`],
    );
  }
  for (const [coreId, dir] of Object.entries(sharedDirs)) {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reports", "r1.md"), `# report of ${coreId}\n`);
    fs.writeFileSync(path.join(dir, "notes.md"), `notes of ${coreId}`);
    fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(MAX_FILE_BYTES + 1));
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    fs.writeFileSync(path.join(path.dirname(dir), "secret.txt"), `SECRET of ${coreId}`);
  }
}

async function client(owner: number, coreIds?: string[]): Promise<McpTestClient> {
  const { key } = await createApiKey(owner, { name: "k", ...(coreIds ? { coreIds } : {}) });
  const c = new McpTestClient(key);
  await c.connect();
  return c;
}

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});
beforeEach(async () => {
  await resetPanelState(testDb);
  resetOperatorSessionForTests();
  await seed();
  reached = [];
  resolved = 0;
  setSharedResolverForTests(async (ownerId, coreId) => {
    resolved += 1;
    expect(ownerId).toBe(A);
    return diskShared(coreId);
  });
});
afterAll(async () => {
  setSharedResolverForTests(null);
  await closePanelTestDb(testDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("tools/list", () => {
  it("describes both as read-only, and offers no write tool for the Shared folder", async () => {
    const tools = await (await client(A)).listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["list_shared", "get_shared"]) {
      expect(tools.find((t) => t.name === name)!.annotations.readOnlyHint).toBe(true);
    }
    expect(names.filter((n) => /shared/.test(n)).sort()).toEqual(["get_shared", "list_shared"]);
  });
});

describe("list_shared and get_shared on a Core the key reaches", () => {
  it("lists the top, a folder (with or without a trailing slash) and reads a file", async () => {
    const c = await client(A);
    const top = dataOf(await c.call("list_shared", { coreId: "core-a" }));
    expect(top.entries.map((e: { path: string }) => e.path).sort()).toEqual(["big.md", "blob.bin", "notes.md", "reports"]);
    expect(top.entries.find((e: { path: string }) => e.path === "reports").kind).toBe("folder");
    for (const p of ["reports", "reports/"]) {
      expect(dataOf(await c.call("list_shared", { coreId: "core-a", path: p })).entries.map((e: { path: string }) => e.path)).toEqual([
        "reports/r1.md",
      ]);
    }
    const file = dataOf(await c.call("get_shared", { coreId: "core-a", path: "reports/r1.md" }));
    expect(file).toMatchObject({ path: "reports/r1.md", content: "# report of core-a\n" });
  });

  it("reads Core B's folder for an unrestricted key, and each Core's own files", async () => {
    const c = await client(A);
    expect(dataOf(await c.call("get_shared", { coreId: "core-b", path: "notes.md" })).content).toBe("notes of core-b");
  });

  it("says not-found for a missing file and refuses a folder as a file", async () => {
    const c = await client(A);
    expect(textOf(await c.call("get_shared", { coreId: "core-a", path: "nope.md" }))).toMatch(/^404/);
    expect(textOf(await c.call("get_shared", { coreId: "core-a", path: "reports/" }))).toMatch(/^400/);
    expect(textOf(await c.call("get_shared", { coreId: "core-a", path: "" }))).toMatch(/^400/);
  });
});

describe("the key's scope and owner", () => {
  it("refuses a Core outside the key with 403 and never reaches that Core", async () => {
    const c = await client(A, ["core-a"]);
    for (const [tool, args] of [
      ["list_shared", { coreId: "core-b" }],
      ["get_shared", { coreId: "core-b", path: "notes.md" }],
    ] as const) {
      const res = await c.call(tool, args);
      expect(res.isError, tool).toBe(true);
      expect(textOf(res), tool).toMatch(/^403/);
      expect(textOf(res), tool).not.toContain("core-b");
    }
    expect(resolved).toBe(0);
    expect(reached).toEqual([]);
    // …and the same key still reads Core A.
    expect(dataOf(await c.call("get_shared", { coreId: "core-a", path: "notes.md" })).content).toBe("notes of core-a");
  });

  it("does not open another owner's Core to an unrestricted key", async () => {
    const c = await client(A);
    for (const [tool, args] of [
      ["list_shared", { coreId: "core-x" }],
      ["get_shared", { coreId: "core-x", path: "notes.md" }],
    ] as const) {
      expect(textOf(await c.call(tool, args)), tool).toMatch(/^404/);
    }
    expect(resolved).toBe(0);
  });
});

describe("path refusal", () => {
  const bad = [
    "../secret.txt",
    "reports/../../secret.txt",
    "/etc/passwd",
    "/secret.txt",
    "reports/./r1.md",
    "reports//r1.md",
    "..\\secret.txt",
    "reports\\r1.md",
    "a\u0000b",
    "..",
  ];

  it("refuses dot-dot, absolute, dot, empty-segment, backslash and control paths for get_shared before any Core is reached", async () => {
    const c = await client(A);
    for (const p of bad) {
      const res = await c.call("get_shared", { coreId: "core-a", path: p });
      expect(res.isError, p).toBe(true);
      expect(textOf(res), p).toMatch(/^400/);
      expect(textOf(res), p).not.toContain("SECRET");
    }
    expect(resolved).toBe(0);
    expect(reached).toEqual([]);
  });

  it("refuses the same for list_shared", async () => {
    const c = await client(A);
    for (const p of bad.filter((x) => x !== "")) {
      const res = await c.call("list_shared", { coreId: "core-a", path: p });
      expect(res.isError, p).toBe(true);
      expect(textOf(res), p).toMatch(/^400/);
    }
    expect(resolved).toBe(0);
    expect(reached).toEqual([]);
  });

  it("does not decode percent-escapes into a traversal: %2e%2e is a name, not a parent", async () => {
    const res = await (await client(A)).call("get_shared", { coreId: "core-a", path: "%2e%2e/secret.txt" });
    expect(textOf(res)).not.toContain("SECRET");
  });
});

describe("the size cap", () => {
  it("refuses a file over the cap without reading it, with its size", async () => {
    const res = await (await client(A)).call("get_shared", { coreId: "core-a", path: "big.md" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(new RegExp(`^413 .*${MAX_FILE_BYTES + 1} bytes`));
    expect(reached.filter((r) => r.includes(" get "))).toEqual([]);
  });

  it("reads a file exactly at the cap", async () => {
    fs.writeFileSync(path.join(sharedDirs["core-a"]!, "edge.md"), "y".repeat(MAX_FILE_BYTES));
    const got = dataOf(await (await client(A)).call("get_shared", { coreId: "core-a", path: "edge.md" }));
    expect(got.content).toHaveLength(MAX_FILE_BYTES);
  });

  it("refuses a file that grew past the cap between the listing and the read", async () => {
    setSharedResolverForTests(async (_o, coreId) => {
      const real = diskShared(coreId);
      return { ...real, list: async () => [{ path: "notes.md", kind: "file", size: 5 }] } as CoreShared;
    });
    fs.writeFileSync(path.join(sharedDirs["core-a"]!, "notes.md"), "z".repeat(MAX_FILE_BYTES + 10));
    const res = await (await client(A)).call("get_shared", { coreId: "core-a", path: "notes.md" });
    expect(textOf(res)).toMatch(/^413/);
  });

  it("refuses a binary file as not text", async () => {
    expect(textOf(await (await client(A)).call("get_shared", { coreId: "core-a", path: "blob.bin" }))).toMatch(/^400 .*UTF-8/);
  });

  it("cuts a long listing and says so", async () => {
    const dir = path.join(sharedDirs["core-a"]!, "many");
    fs.mkdirSync(dir);
    for (let i = 0; i < MAX_LIST_ENTRIES + 5; i += 1) fs.writeFileSync(path.join(dir, `f${i}.md`), "");
    const listed = dataOf(await (await client(A)).call("list_shared", { coreId: "core-a", path: "many" }));
    expect(listed.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(listed.truncated).toBe(true);
  });
});

describe("a Core that cannot be reached", () => {
  it("is a 502 tool error that carries nothing from the failure, and the server log names only the error class", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    setSharedResolverForTests(async () => {
      throw new Error("connect ECONNREFUSED https://user:hunter2@core.internal/v1/projects/x/files");
    });
    const res = await (await client(A)).call("list_shared", { coreId: "core-a" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^502/);
    expect(textOf(res)).not.toContain("hunter2");
    expect(logged.mock.calls.map((c) => c.join(" "))).toEqual(["[mcp] shared read failed: Error"]);
    logged.mockRestore();
  });
});
