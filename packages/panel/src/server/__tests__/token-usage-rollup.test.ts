import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePanelTestDb, openPanelTestDb, resetPanelState } from "./_panel-test-db";
import { localDay } from "../repositories/token-usage.repo";

/**
 * Correctness bar for the token-usage rollup: every summary read (which sums
 * token_usage_rollup) must equal the same aggregate computed straight from the
 * raw token_usage table, across ingest, dedupe, and ON DELETE CASCADE.
 */

const testDb = await openPanelTestDb();
const { createOperator, OPERATOR_ID } = await import("../services/operator");
const { createSession, deleteSession } = await import("../services/sessions");
const repo = await import("../repositories/token-usage.repo");

const MS_PER_DAY = 86_400_000;
const DAY0 = Date.parse("2026-05-10T12:00:00.000Z");

type Totals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

async function rawTotals(): Promise<Totals> {
  const { rows } = await testDb.pool.query(
    `select
       coalesce(sum(input_tokens),0)::text as inputtokens,
       coalesce(sum(output_tokens),0)::text as outputtokens,
       coalesce(sum(cache_creation_tokens),0)::text as cachecreationtokens,
       coalesce(sum(cache_read_tokens),0)::text as cachereadtokens
     from token_usage`,
  );
  const r = rows[0]!;
  return {
    inputTokens: Number(r.inputtokens),
    outputTokens: Number(r.outputtokens),
    cacheCreationTokens: Number(r.cachecreationtokens),
    cacheReadTokens: Number(r.cachereadtokens),
  };
}

async function rawPerSession() {
  const { rows } = await testDb.pool.query(
    `select session_id as sessionid, max(ts)::text as lastts,
       sum(input_tokens)::text as inputtokens, sum(output_tokens)::text as outputtokens,
       sum(cache_creation_tokens)::text as cachecreationtokens, sum(cache_read_tokens)::text as cachereadtokens
     from token_usage group by session_id order by session_id`,
  );
  return rows.map((r) => ({
    sessionId: String(r.sessionid),
    lastTs: Number(r.lastts),
    inputTokens: Number(r.inputtokens),
    outputTokens: Number(r.outputtokens),
    cacheCreationTokens: Number(r.cachecreationtokens),
    cacheReadTokens: Number(r.cachereadtokens),
  }));
}

async function rawPerDaySince(sinceMs: number) {
  const { rows } = await testDb.pool.query(
    `select ts::text as ts, input_tokens::text as inputtokens, output_tokens::text as outputtokens,
       cache_creation_tokens::text as cachecreationtokens, cache_read_tokens::text as cachereadtokens
     from token_usage where ts >= $1`,
    [sinceMs],
  );
  const byDay = new Map<string, Totals>();
  for (const r of rows) {
    const day = localDay(Number(r.ts));
    const cur = byDay.get(day) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    cur.inputTokens += Number(r.inputtokens);
    cur.outputTokens += Number(r.outputtokens);
    cur.cacheCreationTokens += Number(r.cachecreationtokens);
    cur.cacheReadTokens += Number(r.cachereadtokens);
    byDay.set(day, cur);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, t]) => ({ day, ...t }));
}

async function assertRollupMatchesRaw() {
  expect(await repo.selectTotals(OPERATOR_ID)).toEqual(await rawTotals());

  const gotSess = new Map(
    (await repo.selectTotalsPerSession(OPERATOR_ID)).map((s) => [s.sessionId, s]),
  );
  const rawSess = await rawPerSession();
  expect(gotSess.size).toBe(rawSess.length);
  for (const raw of rawSess) {
    const got = gotSess.get(raw.sessionId)!;
    expect(got.inputTokens).toBe(raw.inputTokens);
    expect(got.outputTokens).toBe(raw.outputTokens);
    expect(got.cacheCreationTokens).toBe(raw.cacheCreationTokens);
    expect(got.cacheReadTokens).toBe(raw.cacheReadTokens);
    expect(got.lastTs).toBe(raw.lastTs);
  }

  const since = DAY0 - MS_PER_DAY;
  const gotDay = new Map(
    (await repo.selectTotalsPerDaySince(OPERATOR_ID, since)).map((d) => [d.day, d]),
  );
  const rawDay = await rawPerDaySince(since);
  expect(gotDay.size).toBe(rawDay.length);
  for (const raw of rawDay) {
    const got = gotDay.get(raw.day)!;
    expect(got.inputTokens).toBe(raw.inputTokens);
    expect(got.outputTokens).toBe(raw.outputTokens);
    expect(got.cacheCreationTokens).toBe(raw.cacheCreationTokens);
    expect(got.cacheReadTokens).toBe(raw.cacheReadTokens);
  }
}

beforeEach(async () => {
  await resetPanelState(testDb);
  await createOperator({ name: "Test Operator", password: "test-password" });
  for (const tid of ["t1", "t2", "t3"] as const) {
    // Use auto ids; stash mapping via claudeSessionId for ingest.
    await createSession({
      title: `Session ${tid}`,
      agent: "claude-code",
      claudeSessionId: `sess-${tid}`,
    });
  }
});

afterAll(async () => {
  await closePanelTestDb(testDb);
});

async function sessionIdForClaude(claudeSessionId: string): Promise<string> {
  const { rows } = await testDb.pool.query(
    "select id from sessions where claude_session_id = $1",
    [claudeSessionId],
  );
  return String(rows[0]!.id);
}

describe("token usage rollup", () => {
  it("ingest reproduces the raw aggregate across days and sessions", async () => {
    const t1 = await sessionIdForClaude("sess-t1");
    const t2 = await sessionIdForClaude("sess-t2");
    const t3 = await sessionIdForClaude("sess-t3");

    const inserted = await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-a1", sessionId: t1, claudeSessionId: "sess-t1", messageUuid: "a1", model: "m", inputTokens: 100, outputTokens: 200, cacheCreationTokens: 10, cacheReadTokens: 20, ts: DAY0 },
            { id: "tu-a2", sessionId: t1, claudeSessionId: "sess-t1", messageUuid: "a2", model: "m", inputTokens: 5, outputTokens: 6, cacheCreationTokens: 7, cacheReadTokens: 8, ts: DAY0 + MS_PER_DAY },
            { id: "tu-a3", sessionId: t2, claudeSessionId: "sess-t2", messageUuid: "a3", model: "m", inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, ts: DAY0 },
            { id: "tu-a4", sessionId: t3, claudeSessionId: "sess-t3", messageUuid: "a4", model: "m", inputTokens: 9, outputTokens: 8, cacheCreationTokens: 7, cacheReadTokens: 6, ts: DAY0 + 2 * MS_PER_DAY },
          ],
          sessionOffset: { claudeSessionId: "sess-t1", sessionId: t1, byteOffset: 1 },
        });
      },
      Date.now(),
    );
    expect(inserted).toBe(4);
    await assertRollupMatchesRaw();
  });

  it("incremental ingest keeps the rollup equal to raw, and dedupes", async () => {
    const t1 = await sessionIdForClaude("sess-t1");
    const t3 = await sessionIdForClaude("sess-t3");

    // Seed a baseline row so the second test is not empty.
    await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-seed", sessionId: t1, claudeSessionId: "sess-t1", messageUuid: "seed", model: "m", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, ts: DAY0 },
          ],
          sessionOffset: { claudeSessionId: "sess-t1", sessionId: t1, byteOffset: 1 },
        });
      },
      Date.now(),
    );

    const inserted = await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-b1", sessionId: t1, claudeSessionId: "sess-t1", messageUuid: "b1", model: "m", inputTokens: 50, outputTokens: 60, cacheCreationTokens: 70, cacheReadTokens: 80, ts: DAY0 },
            { id: "tu-b2", sessionId: t3, claudeSessionId: "sess-t3", messageUuid: "b2", model: "m", inputTokens: 11, outputTokens: 12, cacheCreationTokens: 13, cacheReadTokens: 14, ts: DAY0 + 5 * MS_PER_DAY },
          ],
          sessionOffset: { claudeSessionId: "sess-t1", sessionId: t1, byteOffset: 10 },
        });
      },
      Date.now(),
    );
    expect(inserted).toBe(2);
    await assertRollupMatchesRaw();

    const insertedAgain = await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-b1", sessionId: t1, claudeSessionId: "sess-t1", messageUuid: "b1", model: "m", inputTokens: 50, outputTokens: 60, cacheCreationTokens: 70, cacheReadTokens: 80, ts: DAY0 },
          ],
          sessionOffset: { claudeSessionId: "sess-t1", sessionId: t1, byteOffset: 20 },
        });
      },
      Date.now(),
    );
    expect(insertedAgain).toBe(0);
    await assertRollupMatchesRaw();
  });

  it("keeps the rollup equal to raw after a cascade delete", async () => {
    const t1 = await sessionIdForClaude("sess-t1");
    const t2 = await sessionIdForClaude("sess-t2");
    await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-c1", sessionId: t1, claudeSessionId: "sess-t1", messageUuid: "c1", model: "m", inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, ts: DAY0 },
            { id: "tu-c2", sessionId: t2, claudeSessionId: "sess-t2", messageUuid: "c2", model: "m", inputTokens: 3, outputTokens: 4, cacheCreationTokens: 0, cacheReadTokens: 0, ts: DAY0 },
          ],
          sessionOffset: { claudeSessionId: "sess-t1", sessionId: t1, byteOffset: 1 },
        });
      },
      Date.now(),
    );

    await deleteSession(t1);
    const rollupForT1 = await testDb.pool.query(
      "select count(*)::int as n from token_usage_rollup where session_id = $1",
      [t1],
    );
    expect(rollupForT1.rows[0]!.n).toBe(0);
    await assertRollupMatchesRaw();
  });

  it("folds out-of-order ingests into the same day bucket with last_ts = max(ts)", async () => {
    const t2 = await sessionIdForClaude("sess-t2");
    const day = DAY0 + 10 * MS_PER_DAY;
    const laterTs = day + 5 * 3_600_000;
    const earlierTs = day + 1 * 3_600_000;

    await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-o1", sessionId: t2, claudeSessionId: "sess-t2", messageUuid: "o1", model: "m", inputTokens: 3, outputTokens: 4, cacheCreationTokens: 5, cacheReadTokens: 6, ts: laterTs },
          ],
          sessionOffset: { claudeSessionId: "sess-t2", sessionId: t2, byteOffset: 30 },
        });
      },
      Date.now(),
    );
    await repo.ingestTokenUsageTx(
      OPERATOR_ID,
      async (commit) => {
        await commit({
          rows: [
            { id: "tu-o2", sessionId: t2, claudeSessionId: "sess-t2", messageUuid: "o2", model: "m", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: 1, ts: earlierTs },
          ],
          sessionOffset: { claudeSessionId: "sess-t2", sessionId: t2, byteOffset: 40 },
        });
      },
      Date.now(),
    );

    const dayKey = localDay(laterTs);
    const bucket = await testDb.pool.query(
      "select input_tokens as i, last_ts::text as lastts from token_usage_rollup where session_id = $1 and day = $2",
      [t2, dayKey],
    );
    expect(bucket.rows[0]!.i).toBe(4);
    expect(Number(bucket.rows[0]!.lastts)).toBe(laterTs);
    await assertRollupMatchesRaw();
  });
});
