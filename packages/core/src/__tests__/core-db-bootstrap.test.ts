import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapCoreDb } from "../core-db-bootstrap";

// Issue 02 — on a core-only VM (ADR 0003 install, AC_CORE_REMOTE=1), the
// Core process itself owns bringing up `missioncontrol.db` before the
// core-link server starts accepting frames. These tests pin the invariants the
// remote-Core boot path relies on: the schema comes up healthy from every
// starting state (missing file, missing dir, empty file, already-migrated
// file), a real `sessions` query works after bootstrap, and startup fails
// loudly rather than silently degrading when the DB can't be opened.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-core-db-boot-"));
}

describe("bootstrapCoreDb", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = tmpDir();
  });

  afterEach(() => {
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("creates missioncontrol.db and the sessions schema on a fresh VM", () => {
    const dbPath = path.join(userDataDir, "missioncontrol.db");
    expect(fs.existsSync(dbPath)).toBe(false);

    const result = bootstrapCoreDb(userDataDir);

    expect(result.dbPath).toBe(dbPath);
    expect(result.createdFile).toBe(true);
    expect(result.freshSchema).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    // The core acceptance criterion — the read frames the Panel calls must
    // land against a real table rather than degrade to `[]` on `db-missing`.
    const db = new Database(dbPath, { readonly: true });
    try {
      const sessions = db.prepare("SELECT * FROM sessions").all();
      expect(sessions).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("creates the parent directory when it doesn't exist yet", () => {
    // Simulate `core install` pointing at a config path that lives under a
    // not-yet-created dir tree (e.g. a fresh `~/.mission-control/data`).
    const nested = path.join(userDataDir, "nested", "child", "data");
    expect(fs.existsSync(nested)).toBe(false);

    const result = bootstrapCoreDb(nested);

    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(result.dbPath)).toBe(true);
  });

  it("brings up the schema against an existing empty file (manual `touch`)", () => {
    // Case documented in the field report: the reporter's shell experiments
    // left an empty `missioncontrol.db` on disk. The store's `db-missing`
    // throttle then never kicks in, and every 500 ms poll spams `open-failed`
    // because the tables don't exist. Bootstrap must treat this the same as a
    // fresh-VM boot.
    const dbPath = path.join(userDataDir, "missioncontrol.db");
    fs.writeFileSync(dbPath, "");

    const result = bootstrapCoreDb(userDataDir);

    expect(result.createdFile).toBe(false);
    expect(result.freshSchema).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT * FROM sessions").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("is idempotent — a second call against an already-migrated DB is a no-op", () => {
    const first = bootstrapCoreDb(userDataDir);
    expect(first.freshSchema).toBe(true);

    // Seed a row so we can prove the second bootstrap didn't drop the table.
    const seed = new Database(first.dbPath);
    try {
      seed.exec(`
        INSERT INTO sessions (id, title, agent, created_at, updated_at)
        VALUES ('s1', 'a session', 'codex', 0, 0);
      `);
    } finally {
      seed.close();
    }

    const second = bootstrapCoreDb(userDataDir);
    expect(second.createdFile).toBe(false);
    expect(second.freshSchema).toBe(false);

    const db = new Database(first.dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual(["s1"]);
    } finally {
      db.close();
    }
  });

  it("enables WAL so the two-writer event-log pattern stays valid", () => {
    // event-log-store.ts's header comment relies on WAL + busy_timeout: the
    // Core and the (loopback) stateful server both write to the same
    // append-only `event_log` table. Regressing off WAL would put the
    // reconnect replay tail at risk under concurrent load.
    const result = bootstrapCoreDb(userDataDir);
    const db = new Database(result.dbPath, { readonly: true });
    try {
      const mode = db.pragma("journal_mode", { simple: true });
      expect(mode).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("creates the shared event_log table so the Core can append PTY events", () => {
    // The Core's PTY spawn/exit events replay through this table; issue 07's
    // per-Core Fleet view depends on the schema being present at boot.
    const result = bootstrapCoreDb(userDataDir);
    const db = new Database(result.dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'")
        .get();
      expect(row).toBeTruthy();
    } finally {
      db.close();
    }
  });

  // 0.5.0 Cores are installed fresh and nothing migrates (#555, ADR 0041). A
  // database an earlier Core left behind is refused at boot, naming itself, and
  // is left exactly as it was found — not adopted, not "repaired".
  describe("a database from before 0.5.0", () => {
    function seedOldDatabase(): string {
      const dbPath = path.join(userDataDir, "missioncontrol.db");
      const old = new Database(dbPath);
      try {
        old.exec(`
          CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL);
          INSERT INTO projects (id, name, path) VALUES ('p1', 'old', '/srv/old');
          INSERT INTO sessions (id, project_id, title) VALUES ('s1', 'p1', 'old session');
        `);
      } finally {
        old.close();
      }
      return dbPath;
    }

    it("refuses to boot, and says to install fresh", () => {
      seedOldDatabase();
      expect(() => bootstrapCoreDb(userDataDir)).toThrow(/before Core 0\.5\.0.*install a 0\.5\.0 Core fresh/);
    });

    it("leaves the old database exactly as it found it: no table added, no row touched", () => {
      const dbPath = seedOldDatabase();
      expect(() => bootstrapCoreDb(userDataDir)).toThrow();
      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[];
        expect(tables.map((t) => t.name)).toEqual(["projects", "sessions"]);
        expect(db.prepare("SELECT title FROM sessions").all()).toEqual([{ title: "old session" }]);
      } finally {
        db.close();
      }
    });
  });

  it("throws when userDataDir is empty (no silent degradation)", () => {
    // A misconfigured install with an empty AC_USER_DATA_DIR should exit
    // non-zero at boot rather than continue into a store that logs
    // `event-log.unconfigured` on every tick.
    expect(() => bootstrapCoreDb("")).toThrow();
  });

  it("throws when the DB can't be opened (parent path is a file)", () => {
    // A packaging bug that pointed userDataDir at a plain file should surface
    // as a boot failure, not a broken-but-listening Core.
    const filePath = path.join(userDataDir, "not-a-dir");
    fs.writeFileSync(filePath, "");
    expect(() => bootstrapCoreDb(filePath)).toThrow();
  });
});
