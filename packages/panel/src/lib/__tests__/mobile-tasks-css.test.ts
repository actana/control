import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-tasks.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../styles/mobile-tasks.css"), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  it("has no rule outside a max-width media query", () => {
    const outside = css.replace(/@media[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outside.trim()).toBe("");
    expect(css).toMatch(/@media \(max-width: 1023px\)/);
  });
  it("pins the drop bar under the top bar, below it in z-order", () => {
    const bar = block(".mc-tasks-dropbar");
    expect(bar).toMatch(/position:\s*fixed/);
    const top = bar.match(/top:\s*([^;]+);/)?.[1] ?? "";
    expect(top).toContain("56px");
    expect(top).toContain("env(safe-area-inset-top)");
    expect(Number(bar.match(/z-index:\s*(\d+)/)?.[1])).toBeLessThan(20);
  });
  it("hides the segmented control in place while a card is carried", () => {
    expect(block('.mc-tasks-segments[data-carrying="true"]')).toMatch(/visibility:\s*hidden/);
  });
  it("is imported by styles.css", () => {
    const main = readFileSync(path.resolve(__dirname, "../../styles.css"), "utf8");
    expect(main).toContain('@import "./styles/mobile-tasks.css";');
  });
});
