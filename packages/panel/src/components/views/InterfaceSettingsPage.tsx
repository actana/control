import { Field, SettingsSection, ToggleRow } from "~/components/views/SettingsParts";
import { useUpdateUiVisibility } from "~/lib/hideable-elements";
import { useSettings } from "~/queries";
import {
  DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY,
  SESSION_HEADER_BUTTON_KEYS,
  type SessionHeaderButtonKey,
} from "~/shared/session-header-buttons";
import {
  DEFAULT_HEADER_BUTTON_VISIBILITY,
  type HeaderButtonKey,
} from "~/shared/header-buttons";

const BUTTON_META: Record<
  SessionHeaderButtonKey,
  { title: string; description: string; label: string }
> = {
  rename: {
    title: "Rename session",
    description: "The pencil button that opens the rename dialog for a session pane.",
    label: "Show rename button",
  },
  zoom: {
    title: "Zoom in / out",
    description:
      "The terminal text zoom buttons. Hidden by default — zoom with Cmd/Ctrl and + / − / 0 instead.",
    label: "Show zoom buttons",
  },
  clone: {
    title: "Clone session",
    description: "The copy button that duplicates a session into a new pane.",
    label: "Show clone button",
  },
};

const HEADER_BUTTON_META: Record<
  HeaderButtonKey,
  { title: string; description: string; label: string }
> = {
  notifications: {
    title: "Notifications bell",
    description:
      "The bell in the top bar listing finished sessions. It has no hotkey — while hidden, finish toasts and OS notifications are the only alert.",
    label: "Show notifications bell",
  },
  gridView: {
    title: "Grid view",
    description:
      "The button in an open project's header that shows every session at once. Grid view keeps its hotkey.",
    label: "Show grid view button",
  },
};

/**
 * The single home for every show/hide toggle in the UI. Each element listed
 * here is also hideable in place: right-click it in the app and choose Hide
 * (see `useHideableMenu` in ~/lib/hideable-elements).
 */
export function InterfaceSettingsPage() {
  const { data: settings } = useSettings();
  const update = useUpdateUiVisibility();
  const visibility = settings?.sessionHeaderButtons ?? DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY;
  const headerButtons = settings?.headerButtons ?? DEFAULT_HEADER_BUTTON_VISIBILITY;

  const headerButtonRow = (key: HeaderButtonKey) => {
    const meta = HEADER_BUTTON_META[key];
    return (
      <ToggleRow
        key={key}
        title={meta.title}
        description={meta.description}
        checked={headerButtons[key]}
        onChange={(next) => update({ headerButtons: { ...headerButtons, [key]: next } })}
        label={meta.label}
      />
    );
  };

  return (
    <SettingsSection
      title="Interface"
      subtitle="Choose which UI elements are shown. You can also right-click any of these elements in the app and pick Hide. Hidden actions stay available through keyboard shortcuts."
      headingLevel="h1"
    >
      <Field label="Top bar">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ToggleRow
            title="Group switcher pill"
            description="The active-group pill (colored dot + group name) leading the top bar breadcrumb. While hidden, switch groups with the dashboard chips or the group-cycle hotkey."
            checked={settings?.showGroupSwitcher ?? true}
            onChange={(next) => update({ showGroupSwitcher: next })}
            label="Show group switcher pill"
          />
          <ToggleRow
            title="AI usage indicator"
            description="The provider-usage chip (ring or status dots) in the top bar. Hiding it also stops the usage polling — the same switch as Settings → Usage, where you pick which providers it covers."
            checked={settings?.providerUsageEnabled ?? false}
            onChange={(next) => update({ providerUsageEnabled: next })}
            label="Show AI usage indicator"
          />
          {headerButtonRow("notifications")}
        </div>
      </Field>
      <Field label="Project header">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ToggleRow
            title="Group tag"
            description="The group tag (colored dot + group name) in an open project's header, showing which group it belongs to. Click it to scope the dashboard to that group."
            checked={settings?.showProjectHeaderGroup ?? true}
            onChange={(next) => update({ showProjectHeaderGroup: next })}
            label="Show project group tag"
          />
          {headerButtonRow("gridView")}
        </div>
      </Field>
      <Field label="Session header buttons">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {SESSION_HEADER_BUTTON_KEYS.map((key) => {
            const meta = BUTTON_META[key];
            return (
              <ToggleRow
                key={key}
                title={meta.title}
                description={meta.description}
                checked={visibility[key]}
                onChange={(next) => update({ sessionHeaderButtons: { ...visibility, [key]: next } })}
                label={meta.label}
              />
            );
          })}
        </div>
      </Field>
    </SettingsSection>
  );
}
