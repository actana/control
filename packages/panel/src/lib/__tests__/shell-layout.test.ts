import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellLayout, workspaceInsets } from "~/lib/shell-layout";

const flags = { workspaceRoute: false, sessionExpanded: false, gridActive: false };

describe("shellLayout", () => {
  it("desktop layout equals today's styles exactly", () => {
    expect(shellLayout("desktop", flags)).toEqual({
      workspace: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 },
      row: { flex: 1, display: "flex", overflow: "hidden", minHeight: 0 },
      outlet: {
        position: "relative",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
      },
    });
    expect(shellLayout("desktop", { ...flags, workspaceRoute: true }).outlet.minWidth).toBe(640);
    expect(
      shellLayout("desktop", { workspaceRoute: true, sessionExpanded: false, gridActive: true }).outlet.minWidth,
    ).toBe(0);
    expect(shellLayout("desktop", { ...flags, workspaceRoute: true, sessionExpanded: true }).outlet.display).toBe("none");
    expect(
      shellLayout("desktop", { workspaceRoute: true, sessionExpanded: true, gridActive: true }).outlet.display,
    ).toBe("flex");
  });

  it("compact layout has no overflow hidden, no fixed height and no 640px min width", () => {
    const layout = shellLayout("compact", { workspaceRoute: true, sessionExpanded: false, gridActive: false });
    for (const style of Object.values(layout)) {
      expect(style.overflow).not.toBe("hidden");
      expect(style.height).toBeUndefined();
      expect(style.minWidth).not.toBe(640);
    }
    expect(layout.outlet.minHeight).not.toBe(0);
  });
});

describe("mobile-shell.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../styles/mobile-shell.css"), "utf8");
  const compactBlock = /@media \(max-width: 1023px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  it("mobile-shell.css unlocks document scroll under 1023px and pads for the tab bar and safe areas", () => {
    expect(compactBlock).toMatch(/:root,\s*:root body\s*\{[^}]*overflow:\s*visible/);
    expect(compactBlock).toMatch(/html #root\s*\{[^}]*min-height:\s*100dvh/);
    expect(compactBlock).toContain(".mc-core-header-tabs");
    expect(compactBlock).toMatch(/\.mc-shell-main[^{]*\{[^}]*padding-bottom:\s*calc\(64px \+ env\(safe-area-inset-bottom\)\)/);
    expect(compactBlock).toContain("env(safe-area-inset-top)");
    // pages size their own scroll boxes with flex:1 + overflow:auto; those must grow, not clip
    expect(compactBlock).toMatch(/\.mc-shell-outlet\s*>\s*\*\s*>\s*\[style\*="overflow: auto"\][^{]*\{[^}]*overflow:\s*visible\s*!important/);
    expect(css).toMatch(/\.mc-core-tabbar[^{]*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/min-height:\s*44px/);
  });

  it("mobile-shell.css has no rule outside a max-width media query that changes desktop", () => {
    const outside = css.replace(/@media[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outside.trim()).toBe("");
  });
});

type CssRule = { selector: string; body: string; pos: number; media: string | null };

function parseRules(text: string): CssRule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const rules: CssRule[] = [];
  const walk = (start: number, end: number, media: string | null): void => {
    let i = start;
    while (i < end) {
      const open = src.indexOf("{", i);
      const semi = src.indexOf(";", i);
      if (open === -1 || open >= end) return;
      if (semi !== -1 && semi < open && src.slice(i, semi).trim().startsWith("@")) {
        i = semi + 1;
        continue;
      }
      let depth = 1;
      let j = open + 1;
      while (j < end && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const prelude = src.slice(i, open).trim();
      const inner = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(open + 1, j - 1, prelude);
      else if (!prelude.startsWith("@")) {
        for (const sel of prelude.split(",")) {
          rules.push({ selector: sel.trim().replace(/\s+/g, " "), body: inner, pos: i, media });
        }
      }
      i = j;
    }
  };
  walk(0, src.length, null);
  return rules;
}

function specificity(selector: string): [number, number, number] {
  const s = selector.replace(/"[^"]*"/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (s.replace(/[#.:][\w-]+|\[[^\]]*\]/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, elements];
}

function beats(a: [number, number, number], b: [number, number, number]): number {
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] - b[k];
  return 0;
}

describe("compact and phone overrides beat the base rules in the combined stylesheet", () => {
  const styles = path.resolve(__dirname, "../../styles.css");
  const read = (file: string) => readFileSync(path.resolve(path.dirname(styles), file), "utf8");
  const combined = readFileSync(styles, "utf8").replace(
    /@import\s+"\.\/(styles\/mobile-[\w-]+\.css)";/g,
    (_m, file: string) => read(file),
  );
  const rules = parseRules(combined);
  const declares = (rule: CssRule, prop: string, value?: string) => {
    const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule.body);
    return m !== null && (value === undefined || m[1].trim() === value);
  };

  const cases: { base: string; prop: string; value: string; media: string }[] = [
    { base: "html", prop: "height", value: "auto", media: "1023px" },
    { base: "body", prop: "height", value: "auto", media: "1023px" },
    { base: "html", prop: "overflow", value: "visible", media: "1023px" },
    { base: "body", prop: "overflow", value: "visible", media: "1023px" },
    { base: "body", prop: "overflow-x", value: "hidden", media: "1023px" },
    { base: "#root", prop: "height", value: "auto", media: "1023px" },
    { base: ".mc-btn", prop: "--mc-btn-height", value: "44px", media: "767px" },
    { base: ".mc-btn-sm", prop: "--mc-btn-height", value: "44px", media: "767px" },
    { base: ".mc-btn-md", prop: "--mc-btn-height", value: "44px", media: "767px" },
    { base: ".mc-btn-lg", prop: "--mc-btn-height", value: "44px", media: "767px" },
  ];

  it.each(cases)("$base $prop: $value ($media) beats the unconditional base rule", ({ base, prop, value, media }) => {
    // The override targets the same element as `base`: its last compound selector, minus
    // ancestors and :root, is `base` (html/body/#root) -- html matches via :root too.
    const subject = (sel: string) => sel.split(" ").pop() ?? "";
    const overrides = rules.filter(
      (r) =>
        r.media?.includes(media) &&
        declares(r, prop, value) &&
        (subject(r.selector) === base || (base === "html" && r.selector.startsWith(":root") && r.selector.split(" ").length === 1)),
    );
    const bases = rules.filter((r) => r.media === null && r.selector === base && (prop === "overflow-x" ? ["overflow-x", "overflow"] : [prop]).some((p) => declares(r, p)));
    expect(overrides.length, `no ${media} override for ${base} ${prop}`).toBeGreaterThan(0);
    // overrides must win over every base rule, regardless of source order
    const losing = overrides.filter((o) => bases.some((b) => beats(specificity(o.selector), specificity(b.selector)) < 0 || (beats(specificity(o.selector), specificity(b.selector)) === 0 && o.pos < b.pos)));
    expect(losing.map((r) => r.selector)).toEqual([]);
  });

  it("the compact top bar is sticky and beats the #root > * position rule", () => {
    const lastCompound = (sel: string) => sel.split(/[\s>+~]+/).pop() ?? "";
    const sticky = rules.filter(
      (r) => r.media?.includes("1023px") && lastCompound(r.selector) === ".mc-mobile-topbar" && declares(r, "position", "sticky"),
    );
    const bases = rules.filter((r) => r.media === null && r.selector === "#root > *" && declares(r, "position"));
    expect(sticky.length, "no 1023px sticky rule for .mc-mobile-topbar").toBeGreaterThan(0);
    expect(bases.length).toBeGreaterThan(0);
    const losing = sticky.filter((o) => bases.some((b) => beats(specificity(o.selector), specificity(b.selector)) <= 0));
    expect(losing.map((r) => r.selector)).toEqual([]);
  });

  it("the compact workspace does not form a stacking context above the top bar", () => {
    const main = rules.filter((r) => r.media?.includes("1023px") && r.selector.endsWith(".mc-shell-main") && declares(r, "z-index", "auto"));
    expect(main.length, "no 1023px .mc-shell-main z-index: auto rule").toBeGreaterThan(0);
    const bases = rules.filter((r) => r.media === null && r.selector === "#root > *" && declares(r, "z-index"));
    expect(main.some((o) => bases.every((b) => beats(specificity(o.selector), specificity(b.selector)) > 0))).toBe(true);
  });
});

describe("workspaceInsets", () => {
  it("desktop insets equal the workspace rect insets", () => {
    const rect = { top: 48, left: 64, right: 1440, bottom: 900 };
    expect(workspaceInsets("desktop", rect, { width: 1440, height: 900 })).toEqual({
      top: 48,
      left: 64,
      right: 0,
      bottom: 0,
    });
  });

  it("compact has no workspace insets (overlays go full screen)", () => {
    const rect = { top: 56, left: 0, right: 390, bottom: 3000 };
    expect(workspaceInsets("compact", rect, { width: 390, height: 844 })).toBeNull();
  });
});
