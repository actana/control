import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-settings.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../../styles/mobile-settings.css"), "utf8");
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("has no rule outside a max-width media query", () => {
    const outside = stripped.replace(/@media[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, "");
    expect(outside.trim()).toBe("");
    expect(css).toMatch(/@media \(max-width: 767px\)/);
  });

  it("is imported by styles.css after mobile-sheet.css (both new files)", () => {
    const styles = readFileSync(path.resolve(__dirname, "../../../styles.css"), "utf8");
    for (const file of ["mobile-settings.css", "mobile-settings-pages.css"]) {
      expect(styles).toContain(`@import "./styles/${file}";`);
      expect(styles.indexOf(file)).toBeGreaterThan(styles.indexOf("mobile-sheet.css"));
    }
    expect(styles.indexOf("mobile-settings.css")).toBeGreaterThan(styles.indexOf("mobile-terminal.css"));
  });

  it("has a (min-width: 600px) and (max-width: 767px) block with a two-column grid and the back button hidden", () => {
    const block = /@media \(min-width: 600px\) and \(max-width: 767px\) \{([\s\S]*)$/.exec(stripped)?.[1] ?? "";
    expect(block).toMatch(/grid-template-columns:\s*264px minmax\(0, 1fr\)/);
    // Back and the page title are hidden by the base phone rule and only the
    // sub-600 block turns them on.
    expect(stripped).toMatch(/\.mc-settings-back,\s*\.mc-settings-phone \.mc-settings-title-page\s*\{\s*display:\s*none/);
    const narrow = /@media \(max-width: 599px\) \{([\s\S]*?)\n\}/.exec(stripped)?.[1] ?? "";
    expect(narrow).toMatch(/\[data-view="page"\] \.mc-settings-back/);
  });

  it("the phone Settings body and page contain overscroll", () => {
    expect(stripped).toMatch(/\.mc-settings-phone-body[^{}]*\{[^}]*overscroll-behavior:\s*contain/);
    expect(stripped).toMatch(/\.mc-settings-page[^{}]*\{[^}]*overscroll-behavior:\s*contain/);
  });

  it("list rows and top-bar buttons are min-height ≥44px", () => {
    const row = /\.mc-settings-row\s*\{[^}]*min-height:\s*(\d+)px/.exec(stripped);
    expect(Number(row?.[1])).toBeGreaterThanOrEqual(44);
    const btn = /\.mc-settings-menu,\s*\.mc-settings-phone \.mc-settings-back\s*\{[^}]*min-height:\s*(\d+)px/.exec(stripped);
    expect(Number(btn?.[1])).toBeGreaterThanOrEqual(44);
  });

  it("hides the page h1 below 600px except on [data-settings-page=api]", () => {
    const narrow = /@media \(max-width: 599px\) \{([\s\S]*?)\n\}/.exec(stripped)?.[1] ?? "";
    expect(narrow).toMatch(/\.mc-settings-page:not\(\[data-settings-page="api"\]\) h1\s*\{\s*display:\s*none/);
  });

  it("uses no hex or rgb colours", () => {
    expect(stripped).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});
