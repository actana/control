import { DEFAULT_AGENT_LAUNCHER_CONFIG } from "~/shared/agent-launcher-config";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Btn } from "~/components/ui/Btn";
import { Field, SettingsSection, ToggleRow } from "~/components/views/SettingsParts";
import { api, type AppSettings } from "~/lib/api";
import { queryKeys, useSettings } from "~/queries";
import { CURRENT_MC_VERSION } from "~/queries/mission-control-version";
import { DEFAULT_TERMINAL_ZOOM_LEVEL } from "~/shared/terminal-zoom";
import {
  readOsNotificationPermission,
  requestOsNotificationPermission,
  type OsNotificationPermission,
} from "~/lib/os-notifications";
import { DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY } from "~/shared/session-header-buttons";
import { DEFAULT_HEADER_BUTTON_VISIBILITY } from "~/shared/header-buttons";
import { DEFAULT_SHIP_PROMPT } from "~/shared/ship-defaults";

export function GeneralSettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const mouseGradientEnabled = !(settings?.mouseGradientDisabled ?? false);
  const toastEnabled = settings?.sessionFinishToastEnabled ?? true;
  const osNotificationEnabled =
    settings?.sessionFinishOsNotificationEnabled ?? false;
  const notificationSoundEnabled = settings?.notificationSoundEnabled ?? true;
  const [permission, setPermission] = useState<OsNotificationPermission>("default");
  const [permissionHint, setPermissionHint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      setPermission("unsupported");
      return;
    }
    const refreshPermission = () => {
      void readOsNotificationPermission().then(setPermission);
    };
    refreshPermission();
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, []);

  const optimisticSettings = (
    patch: Partial<
      Pick<
        AppSettings,
        | "agentSystemBannerDisabled"
        | "mouseGradientDisabled"
        | "sessionFinishToastEnabled"
        | "sessionFinishOsNotificationEnabled"
        | "notificationSoundEnabled"
      >
    >,
  ): AppSettings => ({
    agentSystemBannerDisabled: settings?.agentSystemBannerDisabled ?? false,
    mouseGradientDisabled: settings?.mouseGradientDisabled ?? false,
    sessionFinishToastEnabled: toastEnabled,
    sessionFinishOsNotificationEnabled: osNotificationEnabled,
    notificationSoundEnabled,
    projectsDashboardView: settings?.projectsDashboardView ?? null,
    activeProjectGroup: settings?.activeProjectGroup ?? null,
    collapsedProjectGroups: settings?.collapsedProjectGroups ?? null,
    terminalZoomLevel: settings?.terminalZoomLevel ?? DEFAULT_TERMINAL_ZOOM_LEVEL,
    sessionHeaderButtons:
      settings?.sessionHeaderButtons ?? DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY,
    headerButtons: settings?.headerButtons ?? DEFAULT_HEADER_BUTTON_VISIBILITY,
    defaultAgent: settings?.defaultAgent ?? "claude-code",
    defaultModel: settings?.defaultModel ?? null,
    shipAgent: settings?.shipAgent ?? "claude-code",
    shipModel: settings?.shipModel ?? null,
    shipPrompt: settings?.shipPrompt ?? DEFAULT_SHIP_PROMPT,
    questionOverlayEnabled: settings?.questionOverlayEnabled ?? true,
    claudeUsageLimitsEnabled: settings?.claudeUsageLimitsEnabled ?? false,
    claudeUsageLimitsShowSession: settings?.claudeUsageLimitsShowSession ?? true,
    claudeUsageLimitsShowWeekly: settings?.claudeUsageLimitsShowWeekly ?? true,
    providerUsageEnabled: settings?.providerUsageEnabled ?? false,
    providerUsageIds: settings?.providerUsageIds ?? ["claude", "codex", "cursor"],
    agentLauncherConfig: settings?.agentLauncherConfig ?? DEFAULT_AGENT_LAUNCHER_CONFIG,
    showGroupSwitcher: settings?.showGroupSwitcher ?? true,
    showProjectHeaderGroup: settings?.showProjectHeaderGroup ?? true,
    ...queryClient.getQueryData<AppSettings>(queryKeys.settings),
    ...patch,
  });

  const updateSettings = async (
    patch: Partial<
      Pick<
        AppSettings,
        | "agentSystemBannerDisabled"
        | "mouseGradientDisabled"
        | "sessionFinishToastEnabled"
        | "sessionFinishOsNotificationEnabled"
        | "notificationSoundEnabled"
      >
    >,
  ) => {
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    const optimistic = optimisticSettings(patch);
    queryClient.setQueryData(queryKeys.settings, optimistic);
    try {
      const next = await api.updateSettings(patch);
      queryClient.setQueryData(queryKeys.settings, { ...optimistic, ...next });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKeys.settings, previous);
      throw error;
    }
  };

  const setMouseGradientEnabled = async (enabled: boolean) => {
    await updateSettings({ mouseGradientDisabled: !enabled });
  };

  const setToastEnabled = async (sessionFinishToastEnabled: boolean) => {
    await updateSettings({ sessionFinishToastEnabled });
  };

  const setNotificationSoundEnabled = async (enabled: boolean) => {
    await updateSettings({ notificationSoundEnabled: enabled });
  };

  const setOsNotificationEnabled = async (enabled: boolean) => {
    setPermissionHint(null);
    if (enabled) {
      const current = await readOsNotificationPermission();
      setPermission(current);
      if (current === "unsupported") {
        setPermissionHint("OS notifications are not supported in this environment.");
        return;
      }
      // This toggle is the only place the Panel asks. A browser gives a page
      // one good prompt, and one spent on page load is spent on an operator who
      // never asked for notifications.
      if (current === "denied") {
        setPermissionHint(
          "Notification permission is blocked. Enable it in your browser settings for this site, then try again.",
        );
        return;
      }
      if (current === "default") {
        const result = await requestOsNotificationPermission();
        setPermission(result);
        if (result !== "granted") {
          setPermissionHint(
            "Notification permission was not granted. Enable it in your browser settings for this site, then try again.",
          );
          return;
        }
      }
    }
    await updateSettings({
      sessionFinishOsNotificationEnabled: enabled,
    });
  };

  const osNotificationBlocked =
    osNotificationEnabled &&
    permission !== "unsupported" &&
    permission !== "granted";
  const osNotificationStatusMessage =
    permissionHint ??
    (osNotificationBlocked && permission === "denied"
      ? "Notification permission is blocked for this site. Allow notifications for it in your browser settings, then reload the Panel."
      : osNotificationBlocked && permission === "default"
        ? "Notification permission is not granted yet. Turn this toggle off and on again to approve the prompt."
        : null);

  return (
    <>
      <SettingsSection
        title="General"
        subtitle="Control app-wide interface preferences."
        headingLevel="h1"
      >
        {/* AgentSystem.dev banner toggle hidden for now — the banner itself
            is also gated off in __root.tsx. */}
        <Field label="Mouse gradient">
          <ToggleRow
            title="Show mouse gradient"
            description="Cursor and card gradients follow the pointer across the workspace."
            checked={mouseGradientEnabled}
            onChange={setMouseGradientEnabled}
            label="Enable"
          />
        </Field>
      </SettingsSection>
      <SettingsSection
        title="Session finish notifications"
        subtitle="Get notified when a Claude session finishes in any project."
      >
        <Field label="Sound">
          <ToggleRow
            title="Notification sound"
            description="Play a short ding when a session finishes."
            checked={notificationSoundEnabled}
            onChange={setNotificationSoundEnabled}
            label="Play sound"
          />
        </Field>
        <Field label="Toast">
          <ToggleRow
            title="Show toast"
            description="A toast appears in the bottom-right when a session finishes."
            checked={toastEnabled}
            onChange={setToastEnabled}
            label="Show toast"
          />
        </Field>
        <Field label="OS notification">
          <ToggleRow
            title="OS notification"
            description={
              permission === "unsupported"
                ? "Not supported in this environment."
                : "Your browser raises a notification when a session finishes — including while this tab is in the background. Clicking it brings you back to that session."
            }
            checked={osNotificationEnabled}
            onChange={setOsNotificationEnabled}
            disabled={permission === "unsupported"}
            label="Enable"
          />
          {osNotificationStatusMessage && (
            <div
              role="status"
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "var(--text-dim)",
                lineHeight: 1.45,
              }}
            >
              {osNotificationStatusMessage}
            </div>
          )}
        </Field>
      </SettingsSection>
      <AboutSection />
      <ReloadSection />
    </>
  );
}

function AboutSection() {
  return (
    <SettingsSection title="About" subtitle="Version information for Actana Control.">
      <Field label="Version">
        <div
          style={{
            padding: "12px 14px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
            Installed: v{CURRENT_MC_VERSION}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
            The Panel updates with its image — pull a newer one and restart the service.
          </div>
        </div>
      </Field>
    </SettingsSection>
  );
}

function ReloadSection() {
  const reload = () => {
    if (typeof window === "undefined") return;
    window.location.reload();
  };

  return (
    <SettingsSection title="Reload" subtitle="Reload the Panel in this tab.">
      <Field label="Page">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "12px 14px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
              Reload Panel
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
              Applies fresh frontend code and reopens the panel link.
            </div>
          </div>
          <Btn type="button" variant="solid" size="sm" icon="refresh" onClick={reload}>
            Reload
          </Btn>
        </div>
      </Field>
    </SettingsSection>
  );
}
