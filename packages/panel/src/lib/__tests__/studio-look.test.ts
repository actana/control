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

describe("studio look — ADR 0015 is the record, and styles.css points at it", () => {
  // #54: the theming decision used to live only in a deleted spec. The ADR is
  // now the sole record, and the file someone edits to add a colour must send
  // them there first.
  const ADR_PATH = "docs/adr/0015-one-fixed-look-from-actana-studio.md";
  const REPO_ROOT = path.resolve(__dirname, "../../../../..");
  const ADR = readFileSync(path.join(REPO_ROOT, ADR_PATH), "utf8");

  it("exists under the number ADR 0016 D44 settled", () => {
    expect(ADR.startsWith("# One fixed look, copied from Actana Studio")).toBe(true);
  });

  it("records one canonical look and dark / light as the only, system-following axis", () => {
    expect(ADR).toMatch(/one canonical look/i);
    expect(ADR).toMatch(/only operator axis is dark \/ light/i);
    expect(ADR).toMatch(/follows the system by default/i);
    expect(ADR).toMatch(/`mc:theme`.*`system` \/ `light` \/ `dark`/);
    // Each deleted knob is named as absent, so a reader cannot miss one.
    for (const knob of [
      /no\*\* accent picker/,
      /no\*\* tint slider/,
      /no\*\* background image/,
      /no\*\* font override/,
      /no\*\* zoom or font-size stepper/,
    ]) {
      expect(ADR).toMatch(knob);
    }
  });

  it("records that the tokens are copied from Actana Studio, not invented", () => {
    expect(ADR).toMatch(/copied from Actana Studio, not invented/);
    expect(ADR).toContain("apps/actana/app/_styles/globals.css");
    expect(ADR).toMatch(/a new colour is therefore a sync question, not a taste question/i);
  });

  it("records what is explicitly not planned", () => {
    expect(ADR).toMatch(/per-project or per-Core theme override/i);
    expect(ADR).toContain("`NEXT_PUBLIC_BRAND_*`");
    expect(ADR).toMatch(/white-\s*label/i);
    expect(ADR).toMatch(/deliberately not ported/);
  });

  it("is anchored by a comment immediately before the @theme token block in styles.css", () => {
    // The comment must be the thing directly above `@theme {` — not somewhere
    // in the file — so it is read by whoever opens the block to add a token.
    const anchor = STYLES.match(/\/\*([^*]|\*(?!\/))*\*\/\s*\n@theme \{/);
    expect(anchor, "a block comment must directly precede `@theme {`").not.toBeNull();
    expect(anchor![0]).toContain("ADR 0015");
    expect(anchor![0]).toContain(ADR_PATH);
    expect(STYLES.match(/@theme \{/g)).toHaveLength(1);
  });

  it("is listed in the docs index", () => {
    const index = readFileSync(path.join(REPO_ROOT, "docs/README.md"), "utf8");
    expect(index).toContain(`[0015](adr/0015-one-fixed-look-from-actana-studio.md)`);
  });
});
