import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_PANEL_IDS, normalizeSettingsPanelId } from "../settings-panel-ids";

const here = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(here, "..");
const srcDir = join(here, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("settings panel ids (Terms of Service removal, #26)", () => {
  it("no longer lists a terms panel", () => {
    expect(SETTINGS_PANEL_IDS as readonly string[]).not.toContain("terms");
  });

  it("maps the legacy terms id to the general panel", () => {
    expect(normalizeSettingsPanelId("terms")).toBe("general");
  });

  it("still resolves current ids and rejects unknown ones", () => {
    expect(normalizeSettingsPanelId("operator")).toBe("operator");
    expect(normalizeSettingsPanelId("nope")).toBeNull();
  });

  it("deletes TermsSettingsPage.tsx", () => {
    expect(existsSync(join(viewsDir, "TermsSettingsPage.tsx"))).toBe(false);
  });

  it("leaves no source reference to TermsSettingsPage", () => {
    const self = fileURLToPath(import.meta.url);
    const offenders = sourceFiles(srcDir)
      .filter((f) => f !== self)
      .filter((f) => readFileSync(f, "utf8").includes("TermsSettingsPage"));
    expect(offenders).toEqual([]);
  });
});
