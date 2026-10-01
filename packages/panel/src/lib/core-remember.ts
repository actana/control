import type { Harness } from "@actana/shared/domain";
import { HARNESSES } from "@actana/shared/domain";

/**
 * Remembered New Session settings for one Core (issue 560).
 *
 * ADR 0041 leaves where these live open now that the Project row is gone. The
 * Panel UI stores them in localStorage keyed by Core id until a later ticket
 * picks a durable home. Nothing here writes the Panel database.
 */

export type CoreRememberSettings = {
  rememberHarnessSettings: boolean;
  savedHarness: Harness | null;
};

const STORAGE_PREFIX = "mc:core-remember:";

function storageKey(coreId: string): string {
  return `${STORAGE_PREFIX}${coreId}`;
}

function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** Read the Remembered harness for a Core, or a cleared default. */
export function readCoreRemember(coreId: string): CoreRememberSettings {
  if (typeof localStorage === "undefined" || !coreId) {
    return { rememberHarnessSettings: false, savedHarness: null };
  }
  try {
    const raw = localStorage.getItem(storageKey(coreId));
    if (!raw) return { rememberHarnessSettings: false, savedHarness: null };
    const parsed = JSON.parse(raw) as { rememberHarnessSettings?: unknown; savedHarness?: unknown };
    const savedHarness = isHarness(parsed.savedHarness) ? parsed.savedHarness : null;
    const rememberHarnessSettings = !!parsed.rememberHarnessSettings && !!savedHarness;
    return { rememberHarnessSettings, savedHarness: rememberHarnessSettings ? savedHarness : null };
  } catch {
    return { rememberHarnessSettings: false, savedHarness: null };
  }
}

/** Persist Remembered settings for a Core. Clearing remember drops the harness. */
export function writeCoreRemember(coreId: string, next: CoreRememberSettings): void {
  if (typeof localStorage === "undefined" || !coreId) return;
  const savedHarness = next.rememberHarnessSettings ? next.savedHarness : null;
  const rememberHarnessSettings = !!next.rememberHarnessSettings && !!savedHarness;
  localStorage.setItem(
    storageKey(coreId),
    JSON.stringify({ rememberHarnessSettings, savedHarness }),
  );
}

/** Test helper: drop every Core Remember key. */
export function __resetCoreRememberForTests(): void {
  if (typeof localStorage === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}
