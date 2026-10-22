import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-terminal.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../../styles/mobile-terminal.css"), "utf8");
  it("has no rule outside a max-width media query", () => {
    const outside = css.replace(/@media[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outside.trim()).toBe("");
    expect(css).toMatch(/@media \(max-width: (1023|767)px\)/);
  });
  it("is imported by styles.css after the other mobile sheets", () => {
    const styles = readFileSync(path.resolve(__dirname, "../../../styles.css"), "utf8");
    expect(styles).toContain('@import "./styles/mobile-terminal.css";');
    expect(styles.indexOf("mobile-terminal.css")).toBeGreaterThan(styles.indexOf("mobile-sheet.css"));
  });
  it("sizes the Back button, option buttons and menu trigger for touch", () => {
    expect(css).toMatch(/\.mc-term-m-back[^}]*44px/);
    expect(css).toMatch(/\.mc-aq-sheet-option[^}]*min-height:\s*44px/);
  });
});
