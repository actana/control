import { eq, sql } from "drizzle-orm";
import { ownedBy } from "~/db/owner";
import { panelDb } from "~/db/panel-db-handle";
import {
  appSettings,
  sessions,
  tokenUsage,
  tokenUsageRollup,
  tokenUsageSessionOffsets,
} from "~/db/pg-schema";
import { PER_SESSION_LIMIT } from "~/shared/token-usage";

export type TotalsRow = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

/**
 * Every summary read aggregates `token_usage_rollup` rather than scanning
 * `token_usage`. The rollup is kept equal to the raw table by the ingest
 * transaction and ON DELETE CASCADE. Day buckets use the process local
 * calendar day (matching SQLite's `strftime(..., 'localtime')`).
 */

/** Local calendar day `YYYY-MM-DD` for an epoch-ms timestamp. */
export function localDay(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function asTotals(row: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
} | null): TotalsRow | null {
  if (!row) return null;
  const n = (v: unknown) => Number(v) || 0;
  return {
    inputTokens: n(row.inputTokens),
    outputTokens: n(row.outputTokens),
    cacheCreationTokens: n(row.cacheCreationTokens),
    cacheReadTokens: n(row.cacheReadTokens),
  };
}

export async function selectTotals(ownerId: number): Promise<TotalsRow | null> {
  const rows = await panelDb()
    .select({
      inputTokens: sql<number>`coalesce(sum(${tokenUsageRollup.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${tokenUsageRollup.outputTokens}), 0)`,
      cacheCreationTokens: sql<number>`coalesce(sum(${tokenUsageRollup.cacheCreationTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${tokenUsageRollup.cacheReadTokens}), 0)`,
    })
    .from(tokenUsageRollup)
    .where(ownedBy(tokenUsageRollup, ownerId));
  return asTotals(rows[0] ?? null);
}

export type PerDayRow = TotalsRow & { day: string };

export async function selectTotalsPerDaySince(ownerId: number, sinceMs: number): Promise<PerDayRow[]> {
  const sinceDay = localDay(sinceMs);
  const rows = await panelDb()
    .select({
      day: tokenUsageRollup.day,
      inputTokens: sql<number>`coalesce(sum(${tokenUsageRollup.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${tokenUsageRollup.outputTokens}), 0)`,
      cacheCreationTokens: sql<number>`coalesce(sum(${tokenUsageRollup.cacheCreationTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${tokenUsageRollup.cacheReadTokens}), 0)`,
    })
    .from(tokenUsageRollup)
    .where(ownedBy(tokenUsageRollup, ownerId, sql`${tokenUsageRollup.day} >= ${sinceDay}`))
    .groupBy(tokenUsageRollup.day);
  return rows.map((r) => ({
    day: String(r.day),
    inputTokens: Number(r.inputTokens) || 0,
    outputTokens: Number(r.outputTokens) || 0,
    cacheCreationTokens: Number(r.cacheCreationTokens) || 0,
    cacheReadTokens: Number(r.cacheReadTokens) || 0,
  }));
}

export type PerSessionRow = TotalsRow & {
  sessionId: string;
  title: string;
  lastTs: number | null;
};

export async function selectTotalsPerSession(ownerId: number): Promise<PerSessionRow[]> {
  const rows = await panelDb()
    .select({
      sessionId: tokenUsageRollup.sessionId,
      title: sessions.title,
      lastTs: sql<number | null>`max(${tokenUsageRollup.lastTs})`,
      inputTokens: sql<number>`coalesce(sum(${tokenUsageRollup.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${tokenUsageRollup.outputTokens}), 0)`,
      cacheCreationTokens: sql<number>`coalesce(sum(${tokenUsageRollup.cacheCreationTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${tokenUsageRollup.cacheReadTokens}), 0)`,
    })
    .from(tokenUsageRollup)
    .innerJoin(sessions, sql`${sessions.id} = ${tokenUsageRollup.sessionId}`)
    .where(ownedBy(tokenUsageRollup, ownerId, ownedBy(sessions, ownerId)))
    .groupBy(tokenUsageRollup.sessionId, sessions.title)
    .orderBy(
      sql`(sum(${tokenUsageRollup.inputTokens}) + sum(${tokenUsageRollup.outputTokens})
        + sum(${tokenUsageRollup.cacheCreationTokens}) + sum(${tokenUsageRollup.cacheReadTokens})) desc`,
    )
    .limit(PER_SESSION_LIMIT);
  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title,
    lastTs: r.lastTs != null ? Number(r.lastTs) : null,
    inputTokens: Number(r.inputTokens) || 0,
    outputTokens: Number(r.outputTokens) || 0,
    cacheCreationTokens: Number(r.cacheCreationTokens) || 0,
    cacheReadTokens: Number(r.cacheReadTokens) || 0,
  }));
}

export type SessionOffsetRow = {
  claudeSessionId: string;
  byteOffset: number;
};

export async function findAllSessionOffsets(ownerId: number): Promise<SessionOffsetRow[]> {
  return panelDb()
    .select({
      claudeSessionId: tokenUsageSessionOffsets.claudeSessionId,
      byteOffset: tokenUsageSessionOffsets.byteOffset,
    })
    .from(tokenUsageSessionOffsets)
    .where(ownedBy(tokenUsageSessionOffsets, ownerId));
}

export type TokenUsageIngestRow = {
  id: string;
  sessionId: string;
  claudeSessionId: string;
  messageUuid: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  ts: number;
};

/**
 * Ingest parsed JSONL chunks atomically. Returns the count of newly-inserted
 * rows. The walker is called inside the transaction with a `commitChunk` it
 * uses to drain parsed rows + the advanced byte offset for each session.
 */
export async function ingestTokenUsageTx(
  ownerId: number,
  walker: (commit: (params: {
    rows: TokenUsageIngestRow[];
    sessionOffset: {
      claudeSessionId: string;
      sessionId: string;
      byteOffset: number;
    };
  }) => Promise<void>) => Promise<void> | void,
  now: number,
): Promise<number> {
  return panelDb().transaction(async (tx) => {
    let inserted = 0;
    await walker(async ({ rows, sessionOffset }) => {
      for (const r of rows) {
        const written = await tx
          .insert(tokenUsage)
          .values({
            id: r.id,
            ownerId,
            sessionId: r.sessionId,
            claudeSessionId: r.claudeSessionId,
            messageUuid: r.messageUuid,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheCreationTokens: r.cacheCreationTokens,
            cacheReadTokens: r.cacheReadTokens,
            ts: r.ts,
          })
          .onConflictDoNothing({ target: tokenUsage.messageUuid })
          .returning({ id: tokenUsage.id });
        if (written.length > 0) {
          inserted += 1;
          await tx
            .insert(tokenUsageRollup)
            .values({
              ownerId,
              sessionId: r.sessionId,
              day: localDay(r.ts),
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cacheCreationTokens: r.cacheCreationTokens,
              cacheReadTokens: r.cacheReadTokens,
              lastTs: r.ts,
            })
            .onConflictDoUpdate({
              target: [tokenUsageRollup.sessionId, tokenUsageRollup.day],
              set: {
                inputTokens: sql`${tokenUsageRollup.inputTokens} + ${r.inputTokens}`,
                outputTokens: sql`${tokenUsageRollup.outputTokens} + ${r.outputTokens}`,
                cacheCreationTokens: sql`${tokenUsageRollup.cacheCreationTokens} + ${r.cacheCreationTokens}`,
                cacheReadTokens: sql`${tokenUsageRollup.cacheReadTokens} + ${r.cacheReadTokens}`,
                lastTs: sql`greatest(${tokenUsageRollup.lastTs}, ${r.ts})`,
              },
            });
        }
      }
      await tx
        .insert(tokenUsageSessionOffsets)
        .values({
          ownerId,
          claudeSessionId: sessionOffset.claudeSessionId,
          sessionId: sessionOffset.sessionId,
          byteOffset: sessionOffset.byteOffset,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [tokenUsageSessionOffsets.ownerId, tokenUsageSessionOffsets.claudeSessionId],
          set: {
            sessionId: sessionOffset.sessionId,
            byteOffset: sessionOffset.byteOffset,
            updatedAt: now,
          },
        });
    });

    if (inserted > 0) {
      await tx
        .insert(appSettings)
        .values({ ownerId, key: "token_usage_last_sync_at", value: String(now) })
        .onConflictDoUpdate({
          target: [appSettings.ownerId, appSettings.key],
          set: { value: String(now) },
        });
    }
    return inserted;
  });
}

export async function getTokenUsageLastSyncedAt(ownerId: number): Promise<number | null> {
  const rows = await panelDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(ownedBy(appSettings, ownerId, eq(appSettings.key, "token_usage_last_sync_at")))
    .limit(1);
  const value = rows[0]?.value;
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
