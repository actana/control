import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL_ENV, createTestDb, type TestDb } from "../test-db";

const open: TestDb[] = [];
async function make(options?: Parameters<typeof createTestDb>[0]) {
  const db = await createTestDb(options);
  open.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("createTestDb on PGlite", { timeout: 30_000 }, () => {
  it("has the baseline migration applied", async () => {
    const db = await make({ env: {} });
    expect(db.kind).toBe("pglite");
    const { rows } = await db.pool.query(
      'select count(*)::int as n from "drizzle"."__drizzle_migrations"',
    );
    expect(rows[0].n).toBe(1);
  });

  it("gives each test a database of its own", async () => {
    const a = await make({ env: {} });
    const b = await make({ env: {} });
    await a.pool.query("create table only_in_a (id int)");
    const inA = await a.pool.query("select to_regclass('only_in_a') as t");
    const inB = await b.pool.query("select to_regclass('only_in_a') as t");
    expect(inA.rows[0].t).toBe("only_in_a");
    expect(inB.rows[0].t).toBeNull();
  });

  it("starts quickly enough to run per test", async () => {
    const started = performance.now();
    await make({ env: {} });
    const ms = performance.now() - started;
    console.log(`createTestDb (PGlite, baseline applied) took ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10_000);
  });

  it("closes twice without error", async () => {
    const db = await make({ env: {} });
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });
});

describe("createTestDb with AC_TEST_DATABASE_URL", () => {
  it("goes to the named server instead of PGlite, and says so when it cannot", async () => {
    const port = await closedPort();
    const secret = "s3cr3t-pa55word";
    const attempt = createTestDb({
      env: { [TEST_DATABASE_URL_ENV]: `postgres://u:${secret}@127.0.0.1:${port}/postgres` },
    });
    await expect(attempt).rejects.toThrow(
      new RegExp(`${TEST_DATABASE_URL_ENV} is set but the server at 127\\.0\\.0\\.1:${port}`),
    );
    await attempt.catch((err: Error) => expect(err.message).not.toContain(secret));
  });

  // Runs only where a real server is given (the real-Postgres CI job, and any
  // developer with one): the same guarantees as the PGlite tests above.
  it.skipIf(!process.env[TEST_DATABASE_URL_ENV])(
    "creates a migrated database of its own on the real server and drops it on close",
    async () => {
      const a = await make();
      const b = await make();
      expect(a.kind).toBe("postgres");
      await a.pool.query("create table only_in_a (id int)");
      const inB = await b.pool.query("select to_regclass('only_in_a') as t");
      expect(inB.rows[0].t).toBeNull();
      const { rows } = await a.pool.query(
        'select count(*)::int as n from "drizzle"."__drizzle_migrations"',
      );
      expect(rows[0].n).toBe(1);
    },
  );
});
