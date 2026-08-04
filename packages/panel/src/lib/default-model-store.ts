// Module-level cache of the user's default agent/model, kept in sync by
// the settings query (mirrors the setApiToken pattern in api.ts). commandForTask
// reads it to append `--model` to every new matching agent session, so the choice
// in Settings → Defaults applies consistently to warm-pooled and cold spawns
// alike without prop-drilling settings through the terminal store.

import {
  isHarness,
  normalizeAiModelId,
  type AiModelId,
  type Harness,
} from "@actana/shared/ai-runtime-defaults";

let defaultHarness: Harness = "claude-code";
let defaultModel: AiModelId | null = null;

export function setDefaultHarness(agent: Harness): void {
  defaultHarness = agent;
}

export function setDefaultModel(model: AiModelId | null): void {
  defaultModel = model;
}

export function syncDefaultRuntimeDefaults(settings: {
  defaultHarness?: unknown;
  defaultModel?: unknown;
}): void {
  defaultHarness = isHarness(settings.defaultHarness)
    ? settings.defaultHarness
    : "claude-code";
  defaultModel = normalizeAiModelId(settings.defaultModel);
}

export function getDefaultModelForHarness(agent: Harness): AiModelId | null {
  return agent === defaultHarness ? defaultModel : null;
}
