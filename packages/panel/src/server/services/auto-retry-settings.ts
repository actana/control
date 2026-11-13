import {
  AUTO_RETRY_BREAKER_COUNT,
  AUTO_RETRY_BREAKER_WINDOW_MS,
  AUTO_RETRY_CEILING_KEY,
  AUTO_RETRY_CORE_RETRIES_KEY,
  AUTO_RETRY_ENABLED_KEY,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_PAUSED_CORES_KEY,
  isValidAutoRetryCeiling,
} from "~/shared/auto-retry";
import { ValidationError } from "../errors";
import { getSetting, setSetting } from "./settings";

/**
 * The instance settings of auto-retry (#958) and the per-Core circuit breaker. Instance settings, never env-only:
 * the kill switch, the attempts ceiling, the recent retries per Core and the Cores an operator has to resume.
 */

export type AutoRetrySettings = { enabled: boolean; maxAttemptsCeiling: number };

export async function getAutoRetrySettings(ownerId: number): Promise<AutoRetrySettings> {
  const enabled = await getSetting(AUTO_RETRY_ENABLED_KEY, ownerId);
  const ceiling = Number(await getSetting(AUTO_RETRY_CEILING_KEY, ownerId));
  return {
    enabled: enabled !== "false",
    maxAttemptsCeiling: isValidAutoRetryCeiling(ceiling) ? ceiling : AUTO_RETRY_MAX_ATTEMPTS,
  };
}

export async function setAutoRetrySettings(
  ownerId: number,
  patch: { enabled?: boolean; maxAttemptsCeiling?: number },
): Promise<AutoRetrySettings> {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new ValidationError("enabled must be true or false");
  }
  if (patch.maxAttemptsCeiling !== undefined && !isValidAutoRetryCeiling(patch.maxAttemptsCeiling)) {
    throw new ValidationError(`maxAttemptsCeiling must be a whole number from 1 to ${AUTO_RETRY_MAX_ATTEMPTS}`);
  }
  if (patch.enabled !== undefined) await setSetting(AUTO_RETRY_ENABLED_KEY, patch.enabled ? "true" : "false", ownerId);
  if (patch.maxAttemptsCeiling !== undefined) {
    await setSetting(AUTO_RETRY_CEILING_KEY, String(patch.maxAttemptsCeiling), ownerId);
  }
  return getAutoRetrySettings(ownerId);
}

async function readJson<T>(ownerId: number, key: string, fallback: T, valid: (v: unknown) => boolean): Promise<T> {
  const raw = await getSetting(key, ownerId);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isRetryMap = (v: unknown) =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((l) => Array.isArray(l) && l.every((n) => typeof n === "number"));

/** The Cores whose auto-retry the breaker paused (oldest first). */
export async function listPausedCores(ownerId: number): Promise<string[]> {
  return readJson<string[]>(ownerId, AUTO_RETRY_PAUSED_CORES_KEY, [], isStringArray);
}

export async function isCorePaused(ownerId: number, coreId: string): Promise<boolean> {
  return (await listPausedCores(ownerId)).includes(coreId);
}

/** An operator resumes auto-retry on a Core: it leaves the paused list and its recent retries are forgotten. */
export async function resumeAutoRetryOnCore(ownerId: number, coreId: string): Promise<void> {
  const paused = await listPausedCores(ownerId);
  if (paused.includes(coreId)) {
    await setSetting(AUTO_RETRY_PAUSED_CORES_KEY, JSON.stringify(paused.filter((c) => c !== coreId)), ownerId);
  }
  const recent = await readJson<Record<string, number[]>>(ownerId, AUTO_RETRY_CORE_RETRIES_KEY, {}, isRetryMap);
  if (coreId in recent) {
    const { [coreId]: _gone, ...rest } = recent;
    await setSetting(AUTO_RETRY_CORE_RETRIES_KEY, JSON.stringify(rest), ownerId);
  }
}

/**
 * Count an auto-retry on a Core (guard 5). The third within the last 60 minutes pauses the Core: `tripped` is true for that
 * call only. A Core that is paused already records nothing new and reports `tripped: false`.
 */
export async function recordCoreRetry(ownerId: number, coreId: string, now: number): Promise<{ tripped: boolean }> {
  const recent = await readJson<Record<string, number[]>>(ownerId, AUTO_RETRY_CORE_RETRIES_KEY, {}, isRetryMap);
  const all: Record<string, number[]> = {};
  for (const [id, times] of Object.entries(recent)) {
    const live = times.filter((t) => now - t < AUTO_RETRY_BREAKER_WINDOW_MS);
    if (live.length) all[id] = live;
  }
  const mine = [...(all[coreId] ?? []), now];
  all[coreId] = mine;
  await setSetting(AUTO_RETRY_CORE_RETRIES_KEY, JSON.stringify(all), ownerId);
  const paused = await listPausedCores(ownerId);
  if (paused.includes(coreId) || mine.length < AUTO_RETRY_BREAKER_COUNT) return { tripped: false };
  await setSetting(AUTO_RETRY_PAUSED_CORES_KEY, JSON.stringify([...paused, coreId]), ownerId);
  return { tripped: true };
}
