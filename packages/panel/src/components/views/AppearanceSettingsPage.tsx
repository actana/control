import { useId } from "react";

import { SettingCard, SettingsSection } from "~/components/views/SettingsParts";
import { useTheme, type Theme } from "~/lib/use-theme";

const THEME_OPTIONS: Record<Theme, { label: string; description: string }> = {
  system: { label: "System", description: "Follow the OS appearance — the default." },
  dark: { label: "Dark", description: "The Studio dark palette." },
  light: { label: "Light", description: "The Studio light palette." },
};

/** The one appearance control: system / light / dark. The look itself is the
 *  fixed Studio palette; the preference lives in localStorage (`mc:theme`)
 *  via useTheme, not server settings. */
export function AppearanceSettingsPage() {
  const { theme, set } = useTheme();
  const titleId = useId();
  const descriptionId = useId();
  const active = THEME_OPTIONS[theme];

  return (
    <SettingsSection
      title="Appearance"
      subtitle="The Panel renders the Actana Studio look. Dark / light is the one visual choice."
      headingLevel="h1"
    >
      <SettingCard
        title="Theme"
        description="System follows your OS appearance, including scheduled dark mode."
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div
              id={titleId}
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
                marginBottom: 3,
              }}
            >
              {active.label}
            </div>
            <div
              id={descriptionId}
              style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}
            >
              {active.description}
            </div>
          </div>
          <div
            role="radiogroup"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            style={{
              display: "inline-flex",
              padding: 2,
              background: "var(--surface-5)",
              border: "1px solid var(--border)",
              borderRadius: "var(--mm-radius)",
              flexShrink: 0,
            }}
          >
            {(["system", "dark", "light"] as const).map((value) => {
              const selected = theme === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className="mc-mode-option"
                  onClick={() => set(value)}
                  style={{
                    padding: "6px 14px",
                    border: "none",
                    borderRadius: "var(--mm-radius-sm)",
                    background: selected ? "var(--surface-0)" : "transparent",
                    boxShadow: selected ? "var(--shadow-subtle)" : "none",
                    color: selected ? "var(--text)" : "var(--text-dim)",
                    fontSize: 12.5,
                    fontWeight: selected ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  {THEME_OPTIONS[value].label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingCard>
    </SettingsSection>
  );
}
