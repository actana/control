import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHELL_QUERY_CACHE_KEYS,
  SHELL_QUERY_CACHE_VERSION,
  installShellQueryCache,
  readCachedCoreCount,
  readCachedSettings,
} from "../shell-query-cache";

function mockWindowStorage() {
  const store = new Map<string, string>();
  const previousWindow = globalThis.window;

  globalThis.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  } as unknown as Window & typeof globalThis;

  return {
    store,
    restore() {
      globalThis.window = previousWindow;
    },
  };
}

describe("shell query cache", () => {
  let storage: ReturnType<typeof mockWindowStorage>;

  beforeEach(() => {
    storage = mockWindowStorage();
  });

  afterEach(() => {
    storage.restore();
  });

  it("persists the settings query when the query cache receives fresh data", () => {
    const queryClient = new QueryClient();
    const settings: Record<string, unknown> = { terminalZoomLevel: 3 };

    installShellQueryCache(queryClient);
    queryClient.setQueryData(["settings"], settings);

    expect(readCachedSettings()).toEqual(settings);
  });

  it("ignores similarly-prefixed detail query keys", () => {
    const queryClient = new QueryClient();

    installShellQueryCache(queryClient);
    queryClient.setQueryData(["settings", "detail"], { terminalZoomLevel: 3 });

    expect(readCachedSettings()).toBeUndefined();
  });

  it("ignores cache envelopes from older versions", () => {
    storage.store.set(
      SHELL_QUERY_CACHE_KEYS.coreCount,
      JSON.stringify({ version: 0, savedAt: Date.now(), data: 3 }),
    );

    expect(readCachedCoreCount()).toBeUndefined();
  });

  it("reads back an envelope of the current version", () => {
    storage.store.set(
      SHELL_QUERY_CACHE_KEYS.coreCount,
      JSON.stringify({ version: SHELL_QUERY_CACHE_VERSION, savedAt: Date.now(), data: 3 }),
    );

    expect(readCachedCoreCount()).toBe(3);
  });
});
