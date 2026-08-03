import { z } from "zod";
import {
  deleteSetting,
  getBooleanSetting,
  getSetting,
  setBooleanSetting,
  setSetting,
} from "../services/settings";
import {
  AI_MODEL_ID_HELP,
  AI_RUNTIME_HARNESS_VALUES,
  isAiRuntimeHarness,
  normalizeAiModelId,
  type AiModelId,
  type AiRuntimeHarness,
} from "@actana/shared/ai-runtime-defaults";
import {
  ACTIVE_PROJECT_GROUP_MAX_LENGTH,
  PROJECTS_DASHBOARD_VIEWS,
  normalizeActiveProjectGroup,
  normalizeCollapsedProjectGroups,
  normalizeProjectsDashboardView,
} from "~/shared/ui-preferences";
import { safeJsonParse } from "@actana/shared/safe-json";
import {
  DEFAULT_PROVIDER_USAGE_IDS,
  normalizeProviderUsageIds,
  type ProviderUsageId,
} from "~/shared/provider-usage";
import {
  normalizeAgentLauncherConfig,
  type AgentLauncherConfig,
} from "~/shared/agent-launcher-config";
import {
  DEFAULT_TERMINAL_ZOOM_LEVEL,
  TERMINAL_ZOOM_MAX,
  TERMINAL_ZOOM_MIN,
  normalizeTerminalZoomLevel,
} from "~/shared/terminal-zoom";
import {
  normalizeSessionHeaderButtonVisibility,
  type SessionHeaderButtonVisibility,
} from "~/shared/session-header-buttons";
import {
  normalizeHeaderButtonVisibility,
  type HeaderButtonVisibility,
} from "~/shared/header-buttons";
import { DEFAULT_SHIP_PROMPT, normalizeShipPrompt } from "~/shared/ship-defaults";
import { HTTP_BAD_REQUEST } from "~/shared/http-status";
import { json, jsonError, parseJsonBody } from "./_helpers";

const DEFAULT_AGENT_SETTING_KEY = "default_agent";
const DEFAULT_MODEL_SETTING_KEY = "default_model";
const SHIP_AGENT_SETTING_KEY = "ship_agent";
const SHIP_MODEL_SETTING_KEY = "ship_model";
const SHIP_PROMPT_SETTING_KEY = "ship_prompt";
const PROJECTS_DASHBOARD_VIEW_KEY = "projects_dashboard_view";
const ACTIVE_PROJECT_GROUP_KEY = "active_project_group";
const COLLAPSED_PROJECT_GROUPS_KEY = "collapsed_project_groups";
const TERMINAL_ZOOM_LEVEL_KEY = "terminal_zoom_level";
const SESSION_HEADER_BUTTONS_KEY = "session_header_buttons";
const HEADER_BUTTONS_KEY = "header_buttons";
const CLAUDE_USAGE_LIMITS_ENABLED_KEY = "claude_usage_limits_enabled";
const CLAUDE_USAGE_LIMITS_SHOW_SESSION_KEY = "claude_usage_limits_show_session";
const CLAUDE_USAGE_LIMITS_SHOW_WEEKLY_KEY = "claude_usage_limits_show_weekly";
const PROVIDER_USAGE_ENABLED_KEY = "provider_usage_enabled";
const PROVIDER_USAGE_IDS_KEY = "provider_usage_ids";
const AGENT_LAUNCHER_CONFIG_KEY = "agent_launcher_config";
const SHOW_GROUP_SWITCHER_KEY = "show_group_switcher";
const SHOW_PROJECT_HEADER_GROUP_KEY = "show_project_header_group";

const aiModelBody = z.union([z.string(), z.null()]).transform((value, ctx): AiModelId | null => {
  const normalized = normalizeAiModelId(value);
  if (normalized || value === null || (typeof value === "string" && value.trim() === "")) {
    return normalized;
  }
  ctx.addIssue({
    code: "custom",
    message: AI_MODEL_ID_HELP,
  });
  return z.NEVER;
});

// The api bearer token is intentionally NOT delivered over HTTP: it belongs to
// each Core's Harness, not the Panel, so no page can exfiltrate it via fetch
// even from the same origin. See
// todos/bugs/done/02-api-settings-leaks-bearer-token.md for the original leak.
// .strict() so a stale client that still sends the removed `regenerate: true`
// field (or any other unknown key) gets a 400 instead of a silent no-op.
const updateSettingsBody = z
  .strictObject({
    agentSystemBannerDisabled: z.boolean(),
    mouseGradientDisabled: z.boolean(),
    sessionFinishToastEnabled: z.boolean(),
    sessionFinishOsNotificationEnabled: z.boolean(),
    notificationSoundEnabled: z.boolean(),
    questionOverlayEnabled: z.boolean(),
    projectsDashboardView: z.enum(PROJECTS_DASHBOARD_VIEWS).nullable(),
    // "ungrouped" or a group id; null clears back to "all projects". A stale
    // id (deleted group) is tolerated here — the client validates against the
    // live group list and falls back to "all".
    activeProjectGroup: z.string().trim().min(1).max(ACTIVE_PROJECT_GROUP_MAX_LENGTH).nullable(),
    collapsedProjectGroups: z.array(z.string().trim().min(1).max(ACTIVE_PROJECT_GROUP_MAX_LENGTH)).max(500).nullable(),
    terminalZoomLevel: z.number().int().min(TERMINAL_ZOOM_MIN).max(TERMINAL_ZOOM_MAX),
    sessionHeaderButtons: z
      .record(z.string(), z.boolean())
      .transform(
        (value): SessionHeaderButtonVisibility =>
          normalizeSessionHeaderButtonVisibility(value),
      ),
    headerButtons: z
      .record(z.string(), z.boolean())
      .transform((value): HeaderButtonVisibility => normalizeHeaderButtonVisibility(value)),
    defaultAgent: z.enum(AI_RUNTIME_HARNESS_VALUES),
    defaultModel: aiModelBody,
    shipAgent: z.enum(AI_RUNTIME_HARNESS_VALUES),
    shipModel: aiModelBody,
    shipPrompt: z.string().transform((value) => normalizeShipPrompt(value)),
    claudeUsageLimitsEnabled: z.boolean(),
    claudeUsageLimitsShowSession: z.boolean(),
    claudeUsageLimitsShowWeekly: z.boolean(),
    providerUsageEnabled: z.boolean(),
    providerUsageIds: z.array(z.string()).transform((value) => normalizeProviderUsageIds(value)),
    agentLauncherConfig: z
      .object({ order: z.array(z.string()), hidden: z.array(z.string()) })
      .transform((value): AgentLauncherConfig => normalizeAgentLauncherConfig(value)),
    showGroupSwitcher: z.boolean(),
    showProjectHeaderGroup: z.boolean(),
  })
  .partial();

function getDefaultAgentSetting(): AiRuntimeHarness {
  const value = getSetting(DEFAULT_AGENT_SETTING_KEY);
  return isAiRuntimeHarness(value) ? value : "claude-code";
}

function getDefaultModelSetting(): AiModelId | null {
  const value = getSetting(DEFAULT_MODEL_SETTING_KEY);
  return normalizeAiModelId(value);
}

function getShipAgentSetting(): AiRuntimeHarness {
  const value = getSetting(SHIP_AGENT_SETTING_KEY);
  return isAiRuntimeHarness(value) ? value : "claude-code";
}

function getShipModelSetting(): AiModelId | null {
  const value = getSetting(SHIP_MODEL_SETTING_KEY);
  return normalizeAiModelId(value);
}

function getShipPromptSetting(): string {
  const value = getSetting(SHIP_PROMPT_SETTING_KEY);
  return value === null ? DEFAULT_SHIP_PROMPT : normalizeShipPrompt(value);
}

function getProjectsDashboardViewSetting() {
  return normalizeProjectsDashboardView(getSetting(PROJECTS_DASHBOARD_VIEW_KEY));
}

function getActiveProjectGroupSetting() {
  return normalizeActiveProjectGroup(getSetting(ACTIVE_PROJECT_GROUP_KEY));
}

function getCollapsedProjectGroupsSetting() {
  return normalizeCollapsedProjectGroups(
    safeJsonParse<unknown>(getSetting(COLLAPSED_PROJECT_GROUPS_KEY), null),
  );
}

function getTerminalZoomLevelSetting() {
  return normalizeTerminalZoomLevel(getSetting(TERMINAL_ZOOM_LEVEL_KEY)) ?? DEFAULT_TERMINAL_ZOOM_LEVEL;
}

function getSessionHeaderButtonsSetting(): SessionHeaderButtonVisibility {
  return normalizeSessionHeaderButtonVisibility(
    safeJsonParse<unknown>(getSetting(SESSION_HEADER_BUTTONS_KEY), null),
  );
}

function getHeaderButtonsSetting(): HeaderButtonVisibility {
  return normalizeHeaderButtonVisibility(
    safeJsonParse<unknown>(getSetting(HEADER_BUTTONS_KEY), null),
  );
}

function getAgentLauncherConfigSetting(): AgentLauncherConfig {
  return normalizeAgentLauncherConfig(
    safeJsonParse<unknown>(getSetting(AGENT_LAUNCHER_CONFIG_KEY), null),
  );
}

function getShowGroupSwitcherSetting(): boolean {
  return getBooleanSetting(SHOW_GROUP_SWITCHER_KEY, true);
}

function getShowProjectHeaderGroupSetting(): boolean {
  return getBooleanSetting(SHOW_PROJECT_HEADER_GROUP_KEY, true);
}

function settingsPayload() {
  return {
    agentSystemBannerDisabled: getBooleanSetting("agent_system_banner_disabled"),
    mouseGradientDisabled: getBooleanSetting("mouse_gradient_disabled"),
    sessionFinishToastEnabled: getBooleanSetting("session_finish_toast_enabled", true),
    sessionFinishOsNotificationEnabled: getBooleanSetting(
      "session_finish_os_notification_enabled",
      false,
    ),
    notificationSoundEnabled: getBooleanSetting("notification_sound_enabled", true),
    // This feature graduated from experimental; retained in the payload for
    // compatibility with older renderers, but stored preferences no longer gate it.
    questionOverlayEnabled: true,
    projectsDashboardView: getProjectsDashboardViewSetting(),
    activeProjectGroup: getActiveProjectGroupSetting(),
    collapsedProjectGroups: getCollapsedProjectGroupsSetting(),
    terminalZoomLevel: getTerminalZoomLevelSetting(),
    sessionHeaderButtons: getSessionHeaderButtonsSetting(),
    headerButtons: getHeaderButtonsSetting(),
    defaultAgent: getDefaultAgentSetting(),
    defaultModel: getDefaultModelSetting(),
    shipAgent: getShipAgentSetting(),
    shipModel: getShipModelSetting(),
    shipPrompt: getShipPromptSetting(),
    // Off by default: usage reaches out to provider APIs using local logins.
    claudeUsageLimitsEnabled: getBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, false),
    claudeUsageLimitsShowSession: getBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_SESSION_KEY, true),
    claudeUsageLimitsShowWeekly: getBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_WEEKLY_KEY, true),
    // Multi-provider (CodexBar fork). If unset, fall back to legacy Claude-only toggle
    // so existing users who already enabled Claude usage keep their indicator.
    providerUsageEnabled: getProviderUsageEnabledSetting(),
    providerUsageIds: getProviderUsageIdsSetting(),
    agentLauncherConfig: getAgentLauncherConfigSetting(),
    showGroupSwitcher: getShowGroupSwitcherSetting(),
    showProjectHeaderGroup: getShowProjectHeaderGroupSetting(),
  };
}

function getProviderUsageEnabledSetting(): boolean {
  const raw = getSetting(PROVIDER_USAGE_ENABLED_KEY);
  if (raw !== null) return raw === "true" || raw === "1";
  // Legacy: Claude-only toggle stood in for the master switch.
  return getBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, false);
}

function getProviderUsageIdsSetting(): ProviderUsageId[] {
  const raw = getSetting(PROVIDER_USAGE_IDS_KEY);
  if (raw === null) {
    // If only Claude was enabled historically, keep Claude as the sole provider.
    if (getBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, false)) return ["claude"];
    return [...DEFAULT_PROVIDER_USAGE_IDS];
  }
  try {
    return normalizeProviderUsageIds(JSON.parse(raw));
  } catch {
    return [...DEFAULT_PROVIDER_USAGE_IDS];
  }
}

export function read(): Response {
  return json(settingsPayload());
}

export async function update(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, updateSettingsBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (body.agentSystemBannerDisabled !== undefined) {
    setBooleanSetting("agent_system_banner_disabled", body.agentSystemBannerDisabled);
  }
  if (body.mouseGradientDisabled !== undefined) {
    setBooleanSetting("mouse_gradient_disabled", body.mouseGradientDisabled);
  }
  if (body.sessionFinishToastEnabled !== undefined) {
    setBooleanSetting("session_finish_toast_enabled", body.sessionFinishToastEnabled);
  }
  if (body.sessionFinishOsNotificationEnabled !== undefined) {
    setBooleanSetting(
      "session_finish_os_notification_enabled",
      body.sessionFinishOsNotificationEnabled,
    );
  }
  if (body.notificationSoundEnabled !== undefined) {
    setBooleanSetting("notification_sound_enabled", body.notificationSoundEnabled);
  }
  // Native question popups are always on; their legacy field remains
  // accepted so older clients can update other settings safely.
  if (body.projectsDashboardView !== undefined) {
    if (body.projectsDashboardView === null) {
      deleteSetting(PROJECTS_DASHBOARD_VIEW_KEY);
    } else {
      setSetting(PROJECTS_DASHBOARD_VIEW_KEY, body.projectsDashboardView);
    }
  }
  if (body.activeProjectGroup !== undefined) {
    if (body.activeProjectGroup === null) {
      deleteSetting(ACTIVE_PROJECT_GROUP_KEY);
    } else {
      setSetting(ACTIVE_PROJECT_GROUP_KEY, body.activeProjectGroup);
    }
  }
  if (body.collapsedProjectGroups !== undefined) {
    if (body.collapsedProjectGroups === null || body.collapsedProjectGroups.length === 0) {
      deleteSetting(COLLAPSED_PROJECT_GROUPS_KEY);
    } else {
      setSetting(COLLAPSED_PROJECT_GROUPS_KEY, JSON.stringify(body.collapsedProjectGroups));
    }
  }
  if (body.terminalZoomLevel !== undefined) {
    setSetting(TERMINAL_ZOOM_LEVEL_KEY, String(body.terminalZoomLevel));
  }
  if (body.sessionHeaderButtons !== undefined) {
    setSetting(SESSION_HEADER_BUTTONS_KEY, JSON.stringify(body.sessionHeaderButtons));
  }
  if (body.headerButtons !== undefined) {
    setSetting(HEADER_BUTTONS_KEY, JSON.stringify(body.headerButtons));
  }
  if (body.defaultAgent !== undefined) {
    setSetting(DEFAULT_AGENT_SETTING_KEY, body.defaultAgent);
  }
  if (body.defaultModel !== undefined) {
    if (body.defaultModel === null) {
      deleteSetting(DEFAULT_MODEL_SETTING_KEY);
    } else {
      setSetting(DEFAULT_MODEL_SETTING_KEY, body.defaultModel);
    }
  }
  if (body.shipAgent !== undefined) {
    setSetting(SHIP_AGENT_SETTING_KEY, body.shipAgent);
  }
  if (body.shipModel !== undefined) {
    if (body.shipModel === null) {
      deleteSetting(SHIP_MODEL_SETTING_KEY);
    } else {
      setSetting(SHIP_MODEL_SETTING_KEY, body.shipModel);
    }
  }
  if (body.shipPrompt !== undefined) {
    setSetting(SHIP_PROMPT_SETTING_KEY, body.shipPrompt);
  }
  if (body.claudeUsageLimitsEnabled !== undefined) {
    setBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, body.claudeUsageLimitsEnabled);
  }
  if (body.claudeUsageLimitsShowSession !== undefined) {
    setBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_SESSION_KEY, body.claudeUsageLimitsShowSession);
  }
  if (body.claudeUsageLimitsShowWeekly !== undefined) {
    setBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_WEEKLY_KEY, body.claudeUsageLimitsShowWeekly);
  }
  if (body.providerUsageEnabled !== undefined) {
    setBooleanSetting(PROVIDER_USAGE_ENABLED_KEY, body.providerUsageEnabled);
    // Keep Claude legacy flag aligned when Claude is among enabled providers.
    const ids =
      body.providerUsageIds ??
      getProviderUsageIdsSetting();
    if (ids.includes("claude")) {
      setBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, body.providerUsageEnabled);
    }
  }
  if (body.providerUsageIds !== undefined) {
    setSetting(PROVIDER_USAGE_IDS_KEY, JSON.stringify(body.providerUsageIds));
  }
  if (body.agentLauncherConfig !== undefined) {
    setSetting(AGENT_LAUNCHER_CONFIG_KEY, JSON.stringify(body.agentLauncherConfig));
  }
  if (body.showGroupSwitcher !== undefined) {
    setBooleanSetting(SHOW_GROUP_SWITCHER_KEY, body.showGroupSwitcher);
  }
  if (body.showProjectHeaderGroup !== undefined) {
    setBooleanSetting(SHOW_PROJECT_HEADER_GROUP_KEY, body.showProjectHeaderGroup);
  }
  return json(settingsPayload());
}
