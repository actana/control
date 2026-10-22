import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-sessions.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../styles/mobile-sessions.css"), "utf8");
  it("has no rule outside a max-width media query", () => {
    const outside = css.replace(/@media[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outside.trim()).toBe("");
    expect(css).toMatch(/@media \(max-width: (1023|767)px\)/);
  });
  it("sizes cards and toggle for touch", () => {
    expect(css).toMatch(/min-height:\s*44px/);
  });
});
