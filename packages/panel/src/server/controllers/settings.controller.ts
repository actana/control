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
  HARNESSES,
  isHarness,
  normalizeAiModelId,
  type AiModelId,
  type Harness,
} from "@actana/shared/ai-runtime-defaults";
import { safeJsonParse } from "@actana/shared/safe-json";
import {
  DEFAULT_PROVIDER_USAGE_IDS,
  normalizeProviderUsageIds,
  type ProviderUsageId,
} from "~/shared/provider-usage";
import {
  normalizeHarnessLauncherConfig,
  type HarnessLauncherConfig,
} from "~/shared/harness-launcher-config";
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
import { json, parseJsonBody } from "./_helpers";

const DEFAULT_AGENT_SETTING_KEY = "default_agent";
const DEFAULT_MODEL_SETTING_KEY = "default_model";
const SHIP_AGENT_SETTING_KEY = "ship_agent";
const SHIP_MODEL_SETTING_KEY = "ship_model";
const SHIP_PROMPT_SETTING_KEY = "ship_prompt";
const TERMINAL_ZOOM_LEVEL_KEY = "terminal_zoom_level";
const SESSION_HEADER_BUTTONS_KEY = "session_header_buttons";
const HEADER_BUTTONS_KEY = "header_buttons";
const CLAUDE_USAGE_LIMITS_ENABLED_KEY = "claude_usage_limits_enabled";
const CLAUDE_USAGE_LIMITS_SHOW_SESSION_KEY = "claude_usage_limits_show_session";
const CLAUDE_USAGE_LIMITS_SHOW_WEEKLY_KEY = "claude_usage_limits_show_weekly";
const PROVIDER_USAGE_ENABLED_KEY = "provider_usage_enabled";
const PROVIDER_USAGE_IDS_KEY = "provider_usage_ids";
const HARNESS_LAUNCHER_CONFIG_KEY = "agent_launcher_config";

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
// each Core's Core, not the Panel, so no page can exfiltrate it via fetch
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
    defaultHarness: z.enum(HARNESSES),
    defaultModel: aiModelBody,
    shipHarness: z.enum(HARNESSES),
    shipModel: aiModelBody,
    shipPrompt: z.string().transform((value) => normalizeShipPrompt(value)),
    claudeUsageLimitsEnabled: z.boolean(),
    claudeUsageLimitsShowSession: z.boolean(),
    claudeUsageLimitsShowWeekly: z.boolean(),
    providerUsageEnabled: z.boolean(),
    providerUsageIds: z.array(z.string()).transform((value) => normalizeProviderUsageIds(value)),
    harnessLauncherConfig: z
      .object({ order: z.array(z.string()), hidden: z.array(z.string()) })
      .transform((value): HarnessLauncherConfig => normalizeHarnessLauncherConfig(value)),
  })
  .partial();

async function getDefaultHarnessSetting(): Promise<Harness> {
  const value = await getSetting(DEFAULT_AGENT_SETTING_KEY);
  return isHarness(value) ? value : "claude-code";
}

async function getDefaultModelSetting(): Promise<AiModelId | null> {
  const value = await getSetting(DEFAULT_MODEL_SETTING_KEY);
  return normalizeAiModelId(value);
}

async function getShipHarnessSetting(): Promise<Harness> {
  const value = await getSetting(SHIP_AGENT_SETTING_KEY);
  return isHarness(value) ? value : "claude-code";
}

async function getShipModelSetting(): Promise<AiModelId | null> {
  const value = await getSetting(SHIP_MODEL_SETTING_KEY);
  return normalizeAiModelId(value);
}

async function getShipPromptSetting(): Promise<string> {
  const value = await getSetting(SHIP_PROMPT_SETTING_KEY);
  return value === null ? DEFAULT_SHIP_PROMPT : normalizeShipPrompt(value);
}

async function getTerminalZoomLevelSetting() {
  return normalizeTerminalZoomLevel(await getSetting(TERMINAL_ZOOM_LEVEL_KEY)) ?? DEFAULT_TERMINAL_ZOOM_LEVEL;
}

async function getSessionHeaderButtonsSetting(): Promise<SessionHeaderButtonVisibility> {
  return normalizeSessionHeaderButtonVisibility(
    safeJsonParse<unknown>(await getSetting(SESSION_HEADER_BUTTONS_KEY), null),
  );
}

async function getHeaderButtonsSetting(): Promise<HeaderButtonVisibility> {
  return normalizeHeaderButtonVisibility(
    safeJsonParse<unknown>(await getSetting(HEADER_BUTTONS_KEY), null),
  );
}

async function getHarnessLauncherConfigSetting(): Promise<HarnessLauncherConfig> {
  return normalizeHarnessLauncherConfig(
    safeJsonParse<unknown>(await getSetting(HARNESS_LAUNCHER_CONFIG_KEY), null),
  );
}

async function settingsPayload() {
  return {
    agentSystemBannerDisabled: await getBooleanSetting("agent_system_banner_disabled"),
    mouseGradientDisabled: await getBooleanSetting("mouse_gradient_disabled"),
    sessionFinishToastEnabled: await getBooleanSetting("session_finish_toast_enabled", true),
    sessionFinishOsNotificationEnabled: await getBooleanSetting(
      "session_finish_os_notification_enabled",
      false,
    ),
    notificationSoundEnabled: await getBooleanSetting("notification_sound_enabled", true),
    // This feature graduated from experimental; retained in the payload for
    // compatibility with older renderers, but stored preferences no longer gate it.
    questionOverlayEnabled: true,
    terminalZoomLevel: await getTerminalZoomLevelSetting(),
    sessionHeaderButtons: await getSessionHeaderButtonsSetting(),
    headerButtons: await getHeaderButtonsSetting(),
    defaultHarness: await getDefaultHarnessSetting(),
    defaultModel: await getDefaultModelSetting(),
    shipHarness: await getShipHarnessSetting(),
    shipModel: await getShipModelSetting(),
    shipPrompt: await getShipPromptSetting(),
    // Off by default: usage reaches out to provider APIs using local logins.
    claudeUsageLimitsEnabled: await getBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, false),
    claudeUsageLimitsShowSession: await getBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_SESSION_KEY, true),
    claudeUsageLimitsShowWeekly: await getBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_WEEKLY_KEY, true),
    // Multi-provider (CodexBar fork). If unset, fall back to legacy Claude-only toggle
    // so existing users who already enabled Claude usage keep their indicator.
    providerUsageEnabled: await getProviderUsageEnabledSetting(),
    providerUsageIds: await getProviderUsageIdsSetting(),
    harnessLauncherConfig: await getHarnessLauncherConfigSetting(),
  };
}

async function getProviderUsageEnabledSetting(): Promise<boolean> {
  const raw = await getSetting(PROVIDER_USAGE_ENABLED_KEY);
  if (raw !== null) return raw === "true" || raw === "1";
  // Legacy: Claude-only toggle stood in for the master switch.
  return await getBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, false);
}

async function getProviderUsageIdsSetting(): Promise<ProviderUsageId[]> {
  const raw = await getSetting(PROVIDER_USAGE_IDS_KEY);
  if (raw === null) {
    // If only Claude was enabled historically, keep Claude as the sole provider.
    if (await getBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, false)) return ["claude"];
    return [...DEFAULT_PROVIDER_USAGE_IDS];
  }
  try {
    return normalizeProviderUsageIds(JSON.parse(raw));
  } catch {
    return [...DEFAULT_PROVIDER_USAGE_IDS];
  }
}

export async function read(): Promise<Response> {
  return json(await settingsPayload());
}

export async function update(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, updateSettingsBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (body.agentSystemBannerDisabled !== undefined) {
    await setBooleanSetting("agent_system_banner_disabled", body.agentSystemBannerDisabled);
  }
  if (body.mouseGradientDisabled !== undefined) {
    await setBooleanSetting("mouse_gradient_disabled", body.mouseGradientDisabled);
  }
  if (body.sessionFinishToastEnabled !== undefined) {
    await setBooleanSetting("session_finish_toast_enabled", body.sessionFinishToastEnabled);
  }
  if (body.sessionFinishOsNotificationEnabled !== undefined) {
    await setBooleanSetting(
      "session_finish_os_notification_enabled",
      body.sessionFinishOsNotificationEnabled,
    );
  }
  if (body.notificationSoundEnabled !== undefined) {
    await setBooleanSetting("notification_sound_enabled", body.notificationSoundEnabled);
  }
  // Native question popups are always on; their legacy field remains
  // accepted so older clients can update other settings safely.
  if (body.terminalZoomLevel !== undefined) {
    await setSetting(TERMINAL_ZOOM_LEVEL_KEY, String(body.terminalZoomLevel));
  }
  if (body.sessionHeaderButtons !== undefined) {
    await setSetting(SESSION_HEADER_BUTTONS_KEY, JSON.stringify(body.sessionHeaderButtons));
  }
  if (body.headerButtons !== undefined) {
    await setSetting(HEADER_BUTTONS_KEY, JSON.stringify(body.headerButtons));
  }
  if (body.defaultHarness !== undefined) {
    await setSetting(DEFAULT_AGENT_SETTING_KEY, body.defaultHarness);
  }
  if (body.defaultModel !== undefined) {
    if (body.defaultModel === null) {
      await deleteSetting(DEFAULT_MODEL_SETTING_KEY);
    } else {
      await setSetting(DEFAULT_MODEL_SETTING_KEY, body.defaultModel);
    }
  }
  if (body.shipHarness !== undefined) {
    await setSetting(SHIP_AGENT_SETTING_KEY, body.shipHarness);
  }
  if (body.shipModel !== undefined) {
    if (body.shipModel === null) {
      await deleteSetting(SHIP_MODEL_SETTING_KEY);
    } else {
      await setSetting(SHIP_MODEL_SETTING_KEY, body.shipModel);
    }
  }
  if (body.shipPrompt !== undefined) {
    await setSetting(SHIP_PROMPT_SETTING_KEY, body.shipPrompt);
  }
  if (body.claudeUsageLimitsEnabled !== undefined) {
    await setBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, body.claudeUsageLimitsEnabled);
  }
  if (body.claudeUsageLimitsShowSession !== undefined) {
    await setBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_SESSION_KEY, body.claudeUsageLimitsShowSession);
  }
  if (body.claudeUsageLimitsShowWeekly !== undefined) {
    await setBooleanSetting(CLAUDE_USAGE_LIMITS_SHOW_WEEKLY_KEY, body.claudeUsageLimitsShowWeekly);
  }
  if (body.providerUsageEnabled !== undefined) {
    await setBooleanSetting(PROVIDER_USAGE_ENABLED_KEY, body.providerUsageEnabled);
    // Keep Claude legacy flag aligned when Claude is among enabled providers.
    const ids =
      body.providerUsageIds ??
      await getProviderUsageIdsSetting();
    if (ids.includes("claude")) {
      await setBooleanSetting(CLAUDE_USAGE_LIMITS_ENABLED_KEY, body.providerUsageEnabled);
    }
  }
  if (body.providerUsageIds !== undefined) {
    await setSetting(PROVIDER_USAGE_IDS_KEY, JSON.stringify(body.providerUsageIds));
  }
  if (body.harnessLauncherConfig !== undefined) {
    await setSetting(HARNESS_LAUNCHER_CONFIG_KEY, JSON.stringify(body.harnessLauncherConfig));
  }
  return json(await settingsPayload());
}
