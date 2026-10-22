import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-settings-pages.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../../styles/mobile-settings-pages.css"), "utf8");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("has no rule outside a max-width media query", () => {
    const outside = code.replace(/@media[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, "");
    expect(outside.trim()).toBe("");
    expect(code).toMatch(/@media \(max-width: 767px\)/);
  });
  it("floors 10–12.5px inline font sizes to 13px under .mc-settings-page", () => {
    for (const size of ["10px", "10.5px", "11px", "11.5px", "12px", "12.5px"]) {
      expect(code).toContain(`.mc-settings-page [style*="font-size: ${size}"]`);
    }
    expect(code).toMatch(/font-size:\s*13px\s*!important/);
  });
  it("stacks .mc-defaults-grid to one column", () => {
    expect(code).toMatch(/\.mc-settings-page \.mc-defaults-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important/);
  });
  it("lets .mc-keybinding-desc span the row", () => {
    expect(code).toMatch(/\.mc-keybinding-desc\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(code).toMatch(/\.mc-keybinding-main\s*\{[^}]*display:\s*contents/);
    expect(code).toMatch(/\.mc-keybinding-capture\s*\{[^}]*min-width:\s*0\s*!important/);
  });
  it("scrolls .mc-storage-tabs sideways", () => {
    expect(code).toMatch(/\.mc-storage-tabs\s*\{[^}]*overflow-x:\s*auto/);
    expect(code).toMatch(/\.mc-storage-tabs\s*\{[^}]*flex-wrap:\s*nowrap/);
  });
  it("stacks .mc-storage-core-row into one left-aligned column", () => {
    expect(code).toMatch(
      /\.mc-settings-page \.mc-storage-core-row\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start\s*!important;[^}]*gap:\s*2px\s*!important/,
    );
    expect(code).toMatch(/\.mc-settings-page \.mc-storage-core-row > div:last-child\s*\{[^}]*text-align:\s*left\s*!important/);
  });
  it("gives toggles, tabs and choice rows a 44px hit area", () => {
    expect(code).toMatch(/\.settings-toggle-switch::after\s*\{[^}]*inset:\s*-10px 0/);
    expect(code).toMatch(/\[role="tab"\][\s\S]*?min-height:\s*44px/);
    expect(code).toMatch(/input\[type="checkbox"\]\)[\s\S]*?min-height:\s*44px/);
  });
  it("scopes every selector under .mc-settings-page", () => {
    const selectors = [...code.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@media"));
    for (const group of selectors) {
      for (const sel of group.split(",")) expect(sel.trim()).toMatch(/^\.mc-settings-page\b/);
    }
  });
  it("no hex colours", () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});
