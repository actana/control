import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(path.resolve(__dirname, "../../styles", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first `@media (max-width: 767px)` block (balanced braces). */
const phoneBlock = (css: string) => {
  const open = css.indexOf("{", css.indexOf("@media (max-width: 767px)"));
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced @media block");
};

/** All `selector { body }` rules in a flat CSS chunk. */
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

describe("Task detail page on phone (#877)", () => {
  it("keeps the phone drawer rule off the Task detail page", () => {
    const drawerRules = rules(phoneBlock(read("mobile-sheet.css"))).filter(
      (r) => r.selector.includes("[data-mc-drawer]") && /top:\s*0\s*!important/.test(r.body),
    );
    expect(drawerRules.length).toBeGreaterThan(0);
    for (const r of drawerRules) {
      expect(r.selector).toContain(":not(.mc-td-page)");
      expect(r.selector).not.toBe("[data-mc-drawer]");
    }
  });
  it("pads the page for the top safe area itself", () => {
    const page = rules(read("mobile-task-detail.css")).find((r) => r.selector === ".mc-td-page");
    expect(page?.body).toMatch(/padding-top:\s*env\(safe-area-inset-top\)/);
  });
});
