import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider-usage readers open other tools' SQLite files read-only (ADR 0041
// D20: they use node:sqlite, and better-sqlite3 is not in the Panel). If the
// compiled module were still imported, this mock would make every read throw.
vi.mock("better-sqlite3", () => {
  throw new Error("better-sqlite3 must not be loaded by the Panel");
});

import { fetchProviderUsage } from "../provider-usage/all-adapters";
import { readCursorUserId } from "../provider-usage/cursor-usage";
import { openReadOnlySqlite, withoutSqliteExperimentalWarning } from "../provider-usage/sqlite-readonly";

const linuxOnly = process.platform === "linux" ? describe : describe.skip;

// A JWT whose `sub` ends in the user id "user_42"; no `exp`, so it never expires.
const TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "auth0|user_42" })).toString("base64url")}.s`;

let home: string;
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };

function makeDb(file: string, setup: (db: DatabaseSync) => void): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  setup(db);
  db.close();
  return file;
}

const cursorDbPath = () => path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
const windsurfDbPath = () => path.join(home, ".config", "Windsurf", "User", "globalStorage", "state.vscdb");
const opencodeDbPath = () => path.join(home, ".local", "share", "opencode", "opencode.db");

function itemTable(db: DatabaseSync, key: string, value: string | Uint8Array): void {
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(key, value);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sqlite-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.XDG;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("openReadOnlySqlite", () => {
  it("cannot write to the file it opened", () => {
    const file = makeDb(path.join(home, "other.db"), (db) => db.exec("CREATE TABLE t (x)"));
    const db = openReadOnlySqlite(file);
    try {
      expect(() => db.exec("INSERT INTO t VALUES (1)")).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  it("throws for a missing file instead of creating it", () => {
    const file = path.join(home, "absent.db");
    expect(() => openReadOnlySqlite(file)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});

linuxOnly("Cursor state.vscdb reader", () => {
  it("reads the access token stored as text", () => {
    makeDb(cursorDbPath(), (db) => itemTable(db, "cursorAuth/accessToken", `  ${TOKEN}\n`));
    expect(readCursorUserId()).toBe("user_42");
  });

  it("reads the access token stored as a blob", () => {
    makeDb(cursorDbPath(), (db) => itemTable(db, "cursorAuth/accessToken", new TextEncoder().encode(TOKEN)));
    expect(readCursorUserId()).toBe("user_42");
  });

  it("returns null when the key is absent", () => {
    makeDb(cursorDbPath(), (db) => itemTable(db, "other/key", TOKEN));
    expect(readCursorUserId()).toBeNull();
  });

  it("returns null when the file is missing", () => {
    expect(readCursorUserId()).toBeNull();
  });

  it("returns null when the file is not a database", () => {
    fs.mkdirSync(path.dirname(cursorDbPath()), { recursive: true });
    fs.writeFileSync(cursorDbPath(), Buffer.alloc(4096, 0x61));
    expect(readCursorUserId()).toBeNull();
  });

  it("returns null when the file is locked by a writer, and never modifies it", () => {
    makeDb(cursorDbPath(), (db) => itemTable(db, "cursorAuth/accessToken", TOKEN));
    const before = fs.readFileSync(cursorDbPath());
    const writer = new DatabaseSync(cursorDbPath());
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const started = Date.now();
      expect(readCursorUserId()).toBeNull();
      // The 250 ms busy timeout is honoured: it waits, then gives up.
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect(fs.readFileSync(cursorDbPath()).equals(before)).toBe(true);
    expect(readCursorUserId()).toBe("user_42");
  });
});

linuxOnly("Windsurf state.vscdb reader", () => {
  const info = JSON.stringify({ quotaUsage: { dailyRemainingPercent: 75, weeklyRemainingPercent: 40 } });

  it("reports the daily and weekly windows from cachedPlanInfo", async () => {
    makeDb(windsurfDbPath(), (db) => itemTable(db, "windsurf.settings.cachedPlanInfo", info));
    const snap = await fetchProviderUsage("windsurf");
    expect(snap.status).toBe("ok");
    expect(snap.windows.map((w) => [w.id, w.utilization])).toEqual([
      ["daily", 25],
      ["weekly", 60],
    ]);
  });

  it("reads cachedPlanInfo stored as a blob", async () => {
    makeDb(windsurfDbPath(), (db) =>
      itemTable(db, "windsurf.settings.cachedPlanInfo", new TextEncoder().encode(info)),
    );
    expect((await fetchProviderUsage("windsurf")).status).toBe("ok");
  });

  it("is unauthenticated when the file is missing", async () => {
    expect((await fetchProviderUsage("windsurf")).status).toBe("unauthenticated");
  });

  it("reports an error, not a throw, for a malformed file", async () => {
    fs.mkdirSync(path.dirname(windsurfDbPath()), { recursive: true });
    fs.writeFileSync(windsurfDbPath(), Buffer.alloc(4096, 0x61));
    const snap = await fetchProviderUsage("windsurf");
    expect(snap.status).toBe("error");
    expect(snap.error).toMatch(/state\.vscdb read failed/);
  });

  it("reports an error for a locked file", async () => {
    makeDb(windsurfDbPath(), (db) => itemTable(db, "windsurf.settings.cachedPlanInfo", info));
    const writer = new DatabaseSync(windsurfDbPath());
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const snap = await fetchProviderUsage("windsurf");
      expect(snap.status).toBe("error");
      expect(snap.error).toMatch(/state\.vscdb read failed/);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

linuxOnly("OpenCode Go opencode.db reader", () => {
  const seed = (db: DatabaseSync) => {
    db.exec("CREATE TABLE message (id TEXT, data TEXT)");
    const add = db.prepare("INSERT INTO message (id, data) VALUES (?, ?)");
    const mk = (ageMs: number, cost: number, provider = "opencode-go", role = "assistant") =>
      JSON.stringify({ providerID: provider, role, cost, time: { created: Date.now() - ageMs } });
    add.run("a", mk(60_000, 3)); // inside the 5 h, 7 d and 30 d windows
    add.run("b", mk(2 * 86400_000, 6)); // inside 7 d and 30 d only
    add.run("c", mk(20 * 86400_000, 12)); // inside 30 d only
    add.run("d", mk(60_000, 99, "other")); // other provider: ignored
    add.run("e", mk(60_000, 99, "opencode-go", "user")); // not an assistant message: ignored
  };

  it("sums assistant costs per window", async () => {
    makeDb(opencodeDbPath(), seed);
    const snap = await fetchProviderUsage("opencodego");
    expect(snap.status).toBe("ok");
    expect(snap.windows.map((w) => [w.id, w.utilization])).toEqual([
      ["session", 25], // 3 of 12
      ["weekly", 30], // 9 of 30
      ["monthly", 35], // 21 of 60
    ]);
  });

  it("is unauthenticated when the file is missing", async () => {
    expect((await fetchProviderUsage("opencodego")).status).toBe("unauthenticated");
  });

  it("reports an error for a malformed file", async () => {
    fs.mkdirSync(path.dirname(opencodeDbPath()), { recursive: true });
    fs.writeFileSync(opencodeDbPath(), Buffer.alloc(4096, 0x61));
    const snap = await fetchProviderUsage("opencodego");
    expect(snap.status).toBe("error");
    expect(snap.error).toMatch(/opencode\.db read failed/);
  });

  it("reports an error for a locked file", async () => {
    makeDb(opencodeDbPath(), seed);
    const writer = new DatabaseSync(opencodeDbPath());
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const snap = await fetchProviderUsage("opencodego");
      expect(snap.status).toBe("error");
      expect(snap.error).toMatch(/opencode\.db read failed/);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

describe("node:sqlite experimental warning", () => {
  async function warningsDuring(emit: () => void): Promise<string[]> {
    const seen: string[] = [];
    const onWarning = (w: Error) => seen.push(`${w.name}: ${w.message}`);
    process.on("warning", onWarning);
    try {
      emit();
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off("warning", onWarning);
    }
    return seen;
  }

  it("drops only the SQLite experimental warning", async () => {
    const seen = await warningsDuring(() =>
      withoutSqliteExperimentalWarning(() => {
        process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
        process.emitWarning("something else is deprecated", "DeprecationWarning");
      }),
    );
    expect(seen).toEqual(["DeprecationWarning: something else is deprecated"]);
  });

  it("restores process.emitWarning afterwards, even when the load throws", async () => {
    const original = process.emitWarning;
    expect(() =>
      withoutSqliteExperimentalWarning(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.emitWarning).toBe(original);
    const seen = await warningsDuring(() => process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning"));
    expect(seen).toEqual(["ExperimentalWarning: SQLite is an experimental feature"]);
  });
});

describe("the Panel has no better-sqlite3", () => {
  const panelRoot = path.resolve(__dirname, "../../../..");

  it("lists it in no dependency block of the Panel manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(panelRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const text = JSON.stringify(manifest);
    expect(text).not.toContain("better-sqlite3");
  });

  it("imports it from no Panel source file", () => {
    const hits = execFileSync("grep", ["-rlE", "better-sqlite3", path.join(panelRoot, "src"), path.join(panelRoot, "bin"), path.join(panelRoot, "vite.config.ts")], {
      encoding: "utf8",
    }).split("\n").filter((f) => f && !f.endsWith("provider-usage-sqlite.test.ts"));
    expect(hits).toEqual([]);
  });
});
