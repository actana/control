import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the system/light/dark preference logic without rendering the
// React hook (the test env is node, no DOM renderer): readCachedTheme(),
// resolveTheme() and the way applyTheme reconciles the `.dark` class on
// <html> — the single surviving theme axis.

function mockDom({ prefersDark = false } = {}) {
  const store = new Map<string, string>();
  const classes = new Set<string>();
  const previousWindow = globalThis.window;
  const listeners = new Set<() => void>();
  let dark = prefersDark;

  globalThis.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    matchMedia: (query: string) => ({
      get matches() {
        return query.includes("dark") ? dark : false;
      },
      addEventListener: (_: string, cb: () => void) => void listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) =>
        void listeners.delete(cb),
    }),
  } as unknown as Window & typeof globalThis;

  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      },
    },
  });

  return {
    store,
    classes,
    setSystemDark(value: boolean) {
      dark = value;
      for (const listener of listeners) listener();
    },
    restore() {
      globalThis.window = previousWindow;
      vi.unstubAllGlobals();
    },
  };
}

describe("use-theme (.dark class reconciliation)", () => {
  let dom: ReturnType<typeof mockDom>;

  beforeEach(() => {
    vi.resetModules();
    dom = mockDom();
  });

  afterEach(() => {
    dom.restore();
  });

  it("defaults the cached preference to system and reads stored overrides", async () => {
    const { readCachedTheme } = await import("../use-theme");
    expect(readCachedTheme()).toBe("system");
    dom.store.set("mc:theme", "light");
    expect(readCachedTheme()).toBe("light");
    dom.store.set("mc:theme", "dark");
    expect(readCachedTheme()).toBe("dark");
    dom.store.set("mc:theme", "painted");
    expect(readCachedTheme()).toBe("system");
  });

  it("migrates a pinned pre-spec-12 mc.theme choice to mc:theme once", async () => {
    const { readCachedTheme } = await import("../use-theme");
    dom.store.set("mc.theme", "light");
    expect(readCachedTheme()).toBe("light");
    expect(dom.store.get("mc:theme")).toBe("light");
    expect(dom.store.has("mc.theme")).toBe(false);
    // The legacy default ("dark" was implicit, not stored) stays system.
    dom.store.clear();
    expect(readCachedTheme()).toBe("system");
  });

  it("resolves the system preference via prefers-color-scheme", async () => {
    const { resolveTheme } = await import("../use-theme");
    expect(resolveTheme("system")).toBe("light");
    dom.setSystemDark(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("applies a pinned dark preference as the .dark class", async () => {
    const { applyTheme } = await import("../use-theme");
    applyTheme("dark");
    expect(dom.classes.has("dark")).toBe(true);
    applyTheme("light");
    expect(dom.classes.has("dark")).toBe(false);
  });

  it("applies the system preference from the OS setting", async () => {
    const { applyTheme } = await import("../use-theme");
    applyTheme("system");
    expect(dom.classes.has("dark")).toBe(false);
    dom.setSystemDark(true);
    applyTheme("system");
    expect(dom.classes.has("dark")).toBe(true);
  });
});
