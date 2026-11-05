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
  // #897: a swipe on the terminal must not scroll or rubber-band the page.
  it("stops the page scrolling under the Session and user terminal screens", () => {
    const rule = /\.mc-terminal-screen\s*\{([^}]*)\}/g;
    const body = [...css.matchAll(rule)].map((m) => m[1]).join("\n");
    expect(body).toMatch(/touch-action:\s*none/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    // inside the max-width media query, so desktop is untouched
    const media = css.slice(css.indexOf("@media"));
    expect(media).toContain(".mc-terminal-screen {");
  });
});
