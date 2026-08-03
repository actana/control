import { useQueryClient } from "@tanstack/react-query";
import { SettingCard, SettingsSection } from "~/components/views/SettingsParts";
import { api, type AppSettings } from "~/lib/api";
import { queryKeys, useSettings } from "~/queries";
import { TERMINAL_FONT_FAMILY } from "~/lib/terminal-options";
import {
  DEFAULT_TERMINAL_ZOOM_LEVEL,
  TERMINAL_ZOOM_LABELS,
  TERMINAL_ZOOM_LEVELS,
  TERMINAL_ZOOM_MAX,
  TERMINAL_ZOOM_MIN,
  terminalFontSizeForLevel,
  type TerminalZoomLevel,
} from "~/shared/terminal-zoom";

function TerminalPreview({ fontSize }: { fontSize: number }) {
  const bold = { fontWeight: 700 };
  const dim = { color: "var(--text-dim)" };
  const prompt = <span style={{ color: "var(--accent)" }}>$</span>;
  return (
    <div
      aria-hidden
      style={{
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--border)",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          color: "var(--text-dim)",
          textAlign: "center",
        }}
      >
        Live preview
      </div>
      <pre
        style={{
          margin: 0,
          padding: "12px 14px",
          background: "var(--terminal-bg)",
          color: "var(--text)",
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize,
          fontWeight: 400,
          lineHeight: 1.0,
          letterSpacing: 0,
          overflowX: "auto",
        }}
      >
        {prompt} <span style={bold}>font-check</span> --sample{"\n"}
        AaBbCc 1234567890 il1I O0 [] {"{}"} () {"<>"} !@#$%^&*{"\n"}
        {"\n"}
        {prompt} <span style={bold}>cargo test</span>
        {"\n"}
        test result: <span style={{ color: "var(--ok, #099250)", ...bold }}>ok</span>. 847
        passed; 0 failed; finished in 0.8s{"\n"}
        <span style={dim}>12:34:56</span>{" "}
        <span style={{ color: "#2e90fa", ...bold }}>INFO</span>{" "}
        <span style={dim}>worker</span> build complete{"\n"}
        {prompt}{" "}
        <span
          style={{
            display: "inline-block",
            width: "0.6em",
            height: "1em",
            verticalAlign: "text-bottom",
            background: "var(--accent)",
          }}
        />
      </pre>
    </div>
  );
}

export function TerminalSettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const level = settings?.terminalZoomLevel ?? DEFAULT_TERMINAL_ZOOM_LEVEL;
  const fontSize = terminalFontSizeForLevel(level);

  const save = async (patch: Partial<Pick<AppSettings, "terminalZoomLevel">>) => {
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    if (previous) {
      queryClient.setQueryData(queryKeys.settings, { ...previous, ...patch });
    }
    try {
      const updated = await api.updateSettings(patch);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => ({
        ...(current ?? updated),
        ...updated,
      }));
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKeys.settings, previous);
      throw error;
    }
  };

  return (
    <SettingsSection
      title="Terminal"
      subtitle="Every terminal pane renders JetBrains Mono at the Studio defaults. Zoom applies live to open sessions."
      headingLevel="h1"
    >
      <div className="term-settings-shell">
        <div className="term-settings">
          <div className="term-settings__controls">
            <SettingCard
              title="Default zoom"
              description="Starting size for every terminal, until you zoom a pane from its header. Per-pane zoom is remembered separately."
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    fontFamily: "var(--mono)",
                    fontSize: 11.5,
                    color: "var(--text)",
                  }}
                >
                  <span>{TERMINAL_ZOOM_LABELS[level]}</span>
                  <span style={{ color: "var(--text-dim)" }}>{fontSize}px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={TERMINAL_ZOOM_LEVELS.length - 1}
                  step={1}
                  value={TERMINAL_ZOOM_LEVELS.indexOf(level)}
                  onChange={(event) => {
                    const index = Number(event.currentTarget.value);
                    const next = TERMINAL_ZOOM_LEVELS[index];
                    if (next !== undefined)
                      void save({ terminalZoomLevel: next as TerminalZoomLevel });
                  }}
                  aria-label="Default terminal zoom level"
                  aria-valuemin={TERMINAL_ZOOM_MIN}
                  aria-valuemax={TERMINAL_ZOOM_MAX}
                  aria-valuenow={level}
                  aria-valuetext={TERMINAL_ZOOM_LABELS[level]}
                  style={{ width: "100%" }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--text-faint)",
                  }}
                >
                  {TERMINAL_ZOOM_LEVELS.map((step) => (
                    <span key={step}>{step > 0 ? `+${step}` : step}</span>
                  ))}
                </div>
              </div>
            </SettingCard>
          </div>

          <aside className="term-settings__preview">
            <TerminalPreview fontSize={fontSize} />
          </aside>
        </div>
      </div>
    </SettingsSection>
  );
}
