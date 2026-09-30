import { describe, expect, it } from "vitest";
import {
  CORE_HOOK_DROP_DIR,
  CORE_HOOK_MISS_LOG,
  CORE_STATE_DATA_DIR,
  CORE_STATE_DIR,
  CORE_STATE_MATERIAL_FILE,
  CORE_STATE_SHARED_DIR,
  coreStatePath,
} from "../actana-container-contract";
import { updateCheckCachePath, updateNoticeStatePath } from "../actana-state-paths";

// #559 — where a containerised Core keeps what only the daemon may hold.

describe("the Core state directory", () => {
  it("is /var/lib/actana, and every state path is built from it", () => {
    expect(CORE_STATE_DIR).toBe("/var/lib/actana");
    expect(coreStatePath()).toBe("/var/lib/actana");
    expect(coreStatePath("data")).toBe("/var/lib/actana/data");
    expect(CORE_STATE_DATA_DIR).toBe("/var/lib/actana/data");
    expect(CORE_STATE_MATERIAL_FILE).toBe("/var/lib/actana/config/material.json");
  });

  it("reserves the Shared-folder key's place inside it", () => {
    expect(CORE_STATE_SHARED_DIR).toBe("/var/lib/actana/shared");
  });

  it("keeps the update caches under the data directory, so they move with it", () => {
    expect(updateCheckCachePath(CORE_STATE_DATA_DIR)).toBe("/var/lib/actana/data/update-check.json");
    expect(updateNoticeStatePath(CORE_STATE_DATA_DIR)).toBe(
      "/var/lib/actana/data/update-notice.json",
    );
  });

  it("puts the hook drop box outside it, where a Session can write", () => {
    expect(CORE_HOOK_DROP_DIR).toBe("/run/actana");
    expect(CORE_HOOK_MISS_LOG).toBe("/run/actana/hook-misses.log");
    expect(CORE_HOOK_MISS_LOG.startsWith(`${CORE_STATE_DIR}/`)).toBe(false);
  });

  it("puts none of it under a home directory", () => {
    for (const p of [CORE_STATE_DIR, CORE_STATE_DATA_DIR, CORE_STATE_MATERIAL_FILE]) {
      expect(p.startsWith("/home/")).toBe(false);
    }
  });
});
