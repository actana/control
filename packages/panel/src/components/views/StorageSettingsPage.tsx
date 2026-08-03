import { SettingsSection } from "~/components/views/SettingsParts";

/**
 * Where state lives, now that the Panel is a service (ADR 0010).
 *
 * There is no path to print: the browser has no filesystem, the Panel's own
 * data directory belongs to whoever runs the container, and everything about a
 * project — its files, its sessions, its database — lives on the Core.
 */
export function StorageSettingsPage() {
  return (
    <SettingsSection
      title="Storage"
      subtitle="Where Actana Control keeps its data."
      headingLevel="h1"
    >
      <div style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
        <p style={{ marginTop: 0 }}>
          Each Core keeps its own projects, sessions, and scrollback on its own machine. Run{" "}
          <code style={{ fontFamily: "var(--mono)" }}>actana status</code> there to see where.
        </p>
        <p style={{ marginBottom: 0 }}>
          The Panel service stores only your operator login, this Core registry, and your
          interface preferences — in the data directory its host was configured with.
        </p>
      </div>
    </SettingsSection>
  );
}
