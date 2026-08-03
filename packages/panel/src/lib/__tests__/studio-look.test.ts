// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRE_HYDRATION_THEME_SCRIPT } from "~/lib/pre-hydration-theme-script";

// The spec-12 DOM-level look assertion: the multi-theme system is gone AND the
// Studio look is what replaced it. Boot behavior is exercised by running the
// real pre-hydration script against jsdom; the palette/font assertions read
// styles.css directly because jsdom does not cascade stylesheet custom
// properties into getComputedStyle.

const STYLES = readFileSync(
  path.resolve(__dirname, "../../styles.css"),
  "utf8",
);

function runBootScript() {
  // The script is an IIFE string — execute it exactly as the <head> would.
  new Function(PRE_HYDRATION_THEME_SCRIPT)();
}

describe("studio look — boot DOM", () => {
  let getItemSpy: ReturnType<typeof vi.spyOn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    // jsdom has no matchMedia; default the OS to light.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false }),
    );
    getItemSpy = vi.spyOn(Storage.prototype, "getItem");
    setItemSpy = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("boot reads only mc:theme and writes nothing", () => {
    runBootScript();
    const readKeys = getItemSpy.mock.calls.map((call: unknown[]) => call[0]);
    expect(readKeys).toEqual(["mc:theme"]);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("boot leaves no legacy theme attribute or inline accent vars on <html>", () => {
    runBootScript();
    const html = document.documentElement;
    for (const attr of [
      "data-minimal",
      "data-theme",
      "data-tint",
      "data-bg-image",
      "data-bg-grid",
      "data-launch-intro",
    ]) {
      expect(html.hasAttribute(attr)).toBe(false);
    }
    expect(html.getAttribute("style") ?? "").not.toMatch(/--accent/);
    // `.dark` is the sole surviving axis — absent here because the mocked OS
    // prefers light and no override is stored.
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("boot resolves the axis: stored override wins, system follows the OS", () => {
    window.localStorage.setItem("mc:theme", "dark");
    getItemSpy.mockClear();
    runBootScript();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    document.documentElement.className = "";
    window.localStorage.setItem("mc:theme", "light");
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    runBootScript();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    document.documentElement.className = "";
    window.localStorage.removeItem("mc:theme");
    runBootScript();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("studio look — fixed terminal palettes", () => {
  it("derives the two xterm palettes from the Studio tokens", async () => {
    const { createTerminalTheme } = await import("~/lib/terminal-options");
    expect(createTerminalTheme({ colorScheme: "dark" })).toMatchObject({
      background: "#0e1722",
      foreground: "#f9fafb",
      cursor: "#29a9e0",
    });
    expect(createTerminalTheme({ colorScheme: "light" })).toMatchObject({
      background: "#ffffff",
      foreground: "#111827",
      cursor: "#29a9e0",
    });
  });

  it("keeps an agent-specific cursor color across schemes", async () => {
    const { createTerminalTheme } = await import("~/lib/terminal-options");
    expect(
      createTerminalTheme({ colorScheme: "light", cursorColor: "#2e90fa" }).cursor,
    ).toBe("#2e90fa");
  });
});

describe("studio look — styles.css", () => {
  it("carries no legacy theme attribute selectors", () => {
    expect(STYLES).not.toMatch(
      /\[data-(minimal|theme|tint|bg-image|bg-grid|launch-intro)/,
    );
  });

  it("uses the Studio palette verbatim (light + dark)", () => {
    // Canonical Studio values — brand accent, both grounds, both card tones.
    expect(STYLES).toContain("--brand-accent: #29a9e0");
    expect(STYLES).toContain("--bg: #f3f4f6");
    expect(STYLES).toContain("--bg: #0e1722");
    expect(STYLES).toContain("--surface-card: #ffffff");
    expect(STYLES).toContain("--surface-card: #122231");
    // `.dark` is a class block, not an attribute selector.
    expect(STYLES).toMatch(/\.dark\s*\{/);
  });

  it("bundles JetBrains Mono as the only font source, bound to the UI stack", () => {
    const fontSources = new Set(
      [...STYLES.matchAll(/@fontsource\/([a-z0-9-]+)\//g)].map((m) => m[1]),
    );
    expect([...fontSources]).toEqual(["jetbrains-mono"]);
    expect(STYLES).toMatch(/--font-sans:\s*"JetBrains Mono"/);
    expect(STYLES).toMatch(/--font-mono:\s*"JetBrains Mono"/);
    // <body> renders the sans stack — JetBrains Mono leads it.
    expect(STYLES).toMatch(/body\s*\{[^}]*font-family:\s*var\(--sans\)/);
  });
});
