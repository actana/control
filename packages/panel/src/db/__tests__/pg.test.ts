import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATABASE_URL_ENV,
  PanelDatabaseError,
  closePanelDatabase,
  connectPanelDatabase,
  createPanelPool,
  getPanelPool,
  readPanelPgConfig,
  type PanelPoolLike,
} from "../pg";

const SECRET = "s3cr3t-pa55word";
const URL_OK = `postgres://panel:${SECRET}@db.internal:5544/panel_main`;

/** A TCP port nothing listens on: bind one, read its number, close it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fakePool(query: () => Promise<unknown>): PanelPoolLike & { ended: number } {
  const pool = {
    ended: 0,
    query,
    end: async () => {
      pool.ended += 1;
    },
    on: () => pool,
  };
  return pool;
}

afterEach(async () => {
  await closePanelDatabase();
});

describe("readPanelPgConfig", () => {
  it("reads the URL and names the target without its credentials", () => {
    const config = readPanelPgConfig({ [DATABASE_URL_ENV]: URL_OK });
    expect(config.connectionString).toBe(URL_OK);
    expect(config.target).toBe("db.internal:5544/panel_main");
    expect(config.target).not.toContain(SECRET);
    expect(config.max).toBeGreaterThan(0);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("defaults the port and accepts the postgresql:// scheme", () => {
    const config = readPanelPgConfig({ [DATABASE_URL_ENV]: "postgresql://u:p@db/panel" });
    expect(config.target).toBe("db:5432/panel");
  });

  it.each([
    ["unset", {}],
    ["empty", { [DATABASE_URL_ENV]: "" }],
    ["blank", { [DATABASE_URL_ENV]: "   " }],
  ])("refuses a URL that is %s, naming the variable", (_label, env) => {
    expect(() => readPanelPgConfig(env)).toThrow(PanelDatabaseError);
    expect(() => readPanelPgConfig(env)).toThrow(/AC_PANEL_DATABASE_URL is not set/);
  });

  it("refuses a value that is not a URL, without echoing it", () => {
    const env = { [DATABASE_URL_ENV]: `not a url ${SECRET}` };
    expect(() => readPanelPgConfig(env)).toThrow(/not a valid URL/);
    expect(() => readPanelPgConfig(env)).not.toThrow(new RegExp(SECRET));
  });

  it("refuses a URL that is not a Postgres one", () => {
    const env = { [DATABASE_URL_ENV]: `mysql://u:${SECRET}@db/panel` };
    expect(() => readPanelPgConfig(env)).toThrow(/postgres:\/\/ or postgresql:\/\//);
    expect(() => readPanelPgConfig(env)).not.toThrow(new RegExp(SECRET));
  });

  it("refuses a URL with no host", () => {
    expect(() => readPanelPgConfig({ [DATABASE_URL_ENV]: "postgres:///panel" })).toThrow(
      /names no host/,
    );
  });
});

describe("connectPanelDatabase", () => {
  it("checks the pool with select 1 and keeps it", async () => {
    const query = vi.fn(async () => ({ rows: [{ "?column?": 1 }] }));
    const pool = fakePool(query);
    const opened = await connectPanelDatabase({ [DATABASE_URL_ENV]: URL_OK }, () => pool);
    expect(opened).toBe(pool);
    expect(query).toHaveBeenCalledWith("select 1");
    expect(getPanelPool()).toBe(pool);
    expect(pool.ended).toBe(0);
  });

  it("does not build a pool at all when the URL is missing", async () => {
    const createPool = vi.fn();
    await expect(connectPanelDatabase({}, createPool)).rejects.toThrow(/AC_PANEL_DATABASE_URL/);
    expect(createPool).not.toHaveBeenCalled();
  });

  it("closes the pool and names the target when the check fails", async () => {
    const pool = fakePool(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:5544");
    });
    const failure = await connectPanelDatabase({ [DATABASE_URL_ENV]: URL_OK }, () => pool).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PanelDatabaseError);
    const message = (failure as Error).message;
    expect(message).toContain("cannot reach Postgres at db.internal:5544/panel_main");
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain(SECRET);
    expect(pool.ended).toBe(1);
    expect(() => getPanelPool()).toThrow(PanelDatabaseError);
  });

  it("reports an unreachable server through the real driver", async () => {
    const port = await closedPort();
    const env = { [DATABASE_URL_ENV]: `postgres://panel:${SECRET}@127.0.0.1:${port}/panel` };
    const failure = await connectPanelDatabase(env).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PanelDatabaseError);
    expect((failure as Error).message).toContain(`cannot reach Postgres at 127.0.0.1:${port}/panel`);
    expect((failure as Error).message).not.toContain(SECRET);
  });

  it("builds a real pool lazily, without dialling anything", async () => {
    const port = await closedPort();
    const pool = createPanelPool(
      readPanelPgConfig({ [DATABASE_URL_ENV]: `postgres://u:p@127.0.0.1:${port}/d` }),
    );
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
});

describe("bin/panel.mjs", () => {
  const binPath = path.resolve(import.meta.dirname, "..", "..", "..", "bin", "panel.mjs");
  const pgModule = pathToFileURL(path.resolve(import.meta.dirname, "..", "pg.ts")).href;
  const tempDirs: string[] = [];

  /**
   * A server entry with just the exports bin/panel.mjs asks for, whose
   * database hook is the real one from pg.ts (Node strips its types) — unless
   * STUB_DB_OK is set, which swaps in one that succeeds, as the control.
   */
  function stubEntry(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-panel-pg-"));
    tempDirs.push(dir);
    const entry = path.join(dir, "server", "server.js");
    fs.mkdirSync(path.dirname(entry));
    fs.writeFileSync(
      entry,
      `import * as real from ${JSON.stringify(pgModule)};\n` +
        `export const connectPanelDatabase = process.env.STUB_DB_OK ? async () => {} : real.connectPanelDatabase;\n` +
        `export const closePanelDatabase = real.closePanelDatabase;\n` +
        `export const serveNodeRequest = async () => {};\n` +
        `export default { fetch: async () => new Response("ok") };\n`,
    );
    return entry;
  }

  async function boot(env: Record<string, string>) {
    const port = await closedPort();
    const child = spawn(process.execPath, [binPath], {
      env: {
        PATH: process.env.PATH ?? "",
        AC_PANEL_SERVER_ENTRY: stubEntry(),
        AC_PANEL_PORT: String(port),
        AC_PANEL_HOST: "127.0.0.1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const code = await new Promise<number | null>((resolve) => {
      // Booted and listening: that is the pass case, so stop it ourselves.
      const watch = setInterval(() => {
        if (stdout.includes("@@AC_CORE_LISTENING@@")) child.kill("SIGTERM");
      }, 50);
      child.on("exit", (status) => {
        clearInterval(watch);
        resolve(status);
      });
    });
    clearTimeout(timer);
    return { code, stdout, stderr };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 with a clear message on stderr when the database URL is missing", async () => {
    const { code, stdout, stderr } = await boot({});
    expect(code).toBe(1);
    expect(stderr).toContain("[panel] AC_PANEL_DATABASE_URL is not set");
    expect(stdout).not.toContain("listening");
    expect(stdout).not.toContain("@@AC_CORE_LISTENING@@");
  }, 30_000);

  it("exits 1 naming the target when Postgres is unreachable, without the password", async () => {
    const port = await closedPort();
    const { code, stdout, stderr } = await boot({
      [DATABASE_URL_ENV]: `postgres://panel:${SECRET}@127.0.0.1:${port}/panel`,
    });
    expect(code).toBe(1);
    expect(stderr).toContain(`[panel] cannot reach Postgres at 127.0.0.1:${port}/panel`);
    expect(stderr).not.toContain(SECRET);
    expect(stdout).not.toContain("@@AC_CORE_LISTENING@@");
  }, 30_000);

  it("listens once the database check passes", async () => {
    const { code, stdout } = await boot({ STUB_DB_OK: "1" });
    expect(stdout).toContain("@@AC_CORE_LISTENING@@");
    expect(code).toBe(0);
  }, 30_000);
});
