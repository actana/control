// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRE_HYDRATION_THEME_SCRIPT } from "~/lib/pre-hydration-theme-script";

// The ADR 0015 DOM-level look assertion: the multi-theme system is gone AND the
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

// ADR 0015 is the record of this look. These pin the anchor that leads an
// editor from the token block to the ADR, and the clauses the ADR must keep.
describe("studio look — ADR 0015 record", () => {
  const REPO_ROOT = path.resolve(__dirname, "../../../../..");
  const ADR_PATH = "docs/adr/0015-one-fixed-look-from-actana-studio.md";
  const ADR = readFileSync(path.join(REPO_ROOT, ADR_PATH), "utf8");

  // The comment directly above `@theme {`. The capture may not cross another
  // comment opener, so an earlier comment cannot be mistaken for the anchor.
  const THEME_ANCHOR = /\/\*((?:(?!\/\*)[\s\S])*?)\*\/\s*@theme\s*\{/g;
  const anchorsOf = (css: string) =>
    [...css.matchAll(THEME_ANCHOR)].map((m) => m[1]!.replace(/\s+/g, " "));

  it("anchors the @theme token block to the ADR file", () => {
    const anchors = anchorsOf(STYLES);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain(ADR_PATH);
    expect(existsSync(path.join(REPO_ROOT, ADR_PATH))).toBe(true);
  });

  it("reads only the comment directly above @theme as the anchor", () => {
    // The ADR path sits in an earlier comment; an unrelated one leads @theme.
    const stray = `/* see ${ADR_PATH} */\n@import "x";\n/* unrelated */\n@theme {}`;
    const strayAnchors = anchorsOf(stray);
    expect(strayAnchors).toHaveLength(1);
    expect(strayAnchors[0]).not.toContain(ADR_PATH);

    const direct = `/* earlier */\n@import "x";\n/* see ${ADR_PATH} */\n@theme {}`;
    expect(anchorsOf(direct)[0]).toContain(ADR_PATH);
  });

  it("records one look whose only operator axis is dark / light, system-following", () => {
    expect(ADR).toMatch(/\*\*Status: ACCEPTED\.\*\*/);
    expect(ADR).toMatch(/one canonical look/i);
    expect(ADR).toMatch(/only operator axis is dark \/ light, following the system/);
    for (const control of [
      "no accent picker",
      "no tint slider",
      "no background image",
      "no font override",
      "no zoom stepper",
    ]) {
      expect(ADR).toContain(control);
    }
  });

  it("records that the tokens are copied from Actana Studio, so a colour is a sync question", () => {
    expect(ADR).toMatch(/copied from Actana Studio, not invented/);
    expect(ADR).toMatch(/A new colour is therefore a sync question, not a taste question/);
  });

  it("records per-project / per-Core overrides and white-label brand hooks as not planned", () => {
    const notPlanned = ADR.split("## Not planned")[1]!.split("\n## ")[0]!;
    expect(notPlanned).toMatch(/Per-project or per-Core theme override/);
    expect(notPlanned).toMatch(/NEXT_PUBLIC_BRAND_\*/);
    expect(notPlanned).toMatch(/deliberately \*\*not\*\* ported/);
  });

  it("is listed in the docs ADR index", () => {
    const index = readFileSync(path.join(REPO_ROOT, "docs/README.md"), "utf8");
    expect(index).toContain(`(adr/0015-one-fixed-look-from-actana-studio.md)`);
  });

  it("keeps Studio's white-label brand surface out of the Panel source", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
          if (readFileSync(full, "utf8").includes("NEXT_PUBLIC_BRAND")) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(path.resolve(__dirname, "../.."));
    expect(offenders).toEqual([]);
  });
});
