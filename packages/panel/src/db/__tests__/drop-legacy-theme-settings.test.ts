import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { dropLegacyThemeSettings, ensureSchema } from "@actana/shared/schema-bootstrap";

const LEGACY_THEME_KEYS = [
  "accent_color",
  "theme_style",
  "minimal_theme",
  "surface_tint",
  "background_image",
  "show_background_grid",
  "interface_font_family",
  "interface_font_scale",
  "terminal_font_family",
  "terminal_font_weight",
  "terminal_font_weight_bold",
  "terminal_line_height",
  "terminal_letter_spacing",
  "launch_overlay_enabled",
] as const;

function themeRowCount(db: Database.Database): number {
  const placeholders = LEGACY_THEME_KEYS.map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM app_settings WHERE key IN (${placeholders})`)
    .get(...LEGACY_THEME_KEYS) as { c: number };
  return row.c;
}

describe("dropLegacyThemeSettings", () => {
  it("boots a pre-cutover DB (all fourteen theming rows) down to zero of them", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    for (const key of LEGACY_THEME_KEYS) {
      db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(key, "x");
    }
    // A non-theming row must survive the sweep.
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(
      "default_agent",
      "claude-code",
    );
    expect(themeRowCount(db)).toBe(LEGACY_THEME_KEYS.length);

    ensureSchema(db);

    expect(themeRowCount(db)).toBe(0);
    expect(
      db.prepare("SELECT value FROM app_settings WHERE key = 'default_agent'").get(),
    ).toMatchObject({ value: "claude-code" });
  });

  it("runs the guarded DELETE without error on a fresh DB and seeds none of the keys", () => {
    const fresh = new Database(":memory:");
    expect(() => ensureSchema(fresh)).not.toThrow();
    expect(themeRowCount(fresh)).toBe(0);
    expect(() => dropLegacyThemeSettings(fresh)).not.toThrow();
  });
});
