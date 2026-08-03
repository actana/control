import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { Icon } from "~/components/ui/Icon";
import { Field, SettingsSection } from "~/components/views/SettingsParts";
import { ApiError, api, type AppSettings } from "~/lib/api";
import { syncDefaultRuntimeDefaults } from "~/lib/default-model-store";
import { queryKeys, useSettings } from "~/queries";
import { AGENT_REGISTRY } from "@actana/shared/agents";
import {
  AI_RUNTIME_HARNESS_VALUES,
  isAiModelId,
  getAiRuntimeModelOptions,
  modelBelongsToHarnessCatalog,
  type AiModelOption,
  type AiModelId,
  type AiRuntimeHarness,
  type AiRuntimeModelsResponse,
} from "@actana/shared/ai-runtime-defaults";
import { DEFAULT_SHIP_PROMPT } from "~/shared/ship-defaults";

type DefaultsFeatureId = "ship";

const DEFAULTS_FEATURES: Array<{
  id: DefaultsFeatureId;
  label: string;
  description: string;
}> = [
  {
    id: "ship",
    label: "Ship",
    description: "Harness, model, and prompt for the Ship button.",
  },
];

export function DefaultsSettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const currentShipAgent = settings?.shipAgent ?? "claude-code";
  const currentShipModel = settings?.shipModel ?? null;
  const currentShipPrompt = settings?.shipPrompt ?? DEFAULT_SHIP_PROMPT;
  const [activeFeature, setActiveFeature] = useState<DefaultsFeatureId>("ship");
  const [runtimeUpdating, setRuntimeUpdating] = useState(false);
  const runtimeUpdateInFlightRef = useRef(false);
  const [shipPromptDraft, setShipPromptDraft] = useState(currentShipPrompt);
  const [shipPromptSaving, setShipPromptSaving] = useState(false);

  useEffect(() => {
    setShipPromptDraft(currentShipPrompt);
  }, [currentShipPrompt]);

  const updateRuntimeDefaults = async (
    patch: Partial<
      Pick<
        AppSettings,
        | "defaultAgent"
        | "defaultModel"
        | "shipAgent"
        | "shipModel"
        | "shipPrompt"
      >
    >,
  ) => {
    if (runtimeUpdateInFlightRef.current) return;
    runtimeUpdateInFlightRef.current = true;
    setRuntimeUpdating(true);
    await queryClient.cancelQueries({ queryKey: queryKeys.settings });
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    if (previous) {
      const optimistic = { ...previous, ...patch };
      queryClient.setQueryData<AppSettings>(queryKeys.settings, optimistic);
      syncDefaultRuntimeDefaults(optimistic);
    }
    try {
      const next = await api.updateSettings(patch);
      queryClient.setQueryData(queryKeys.settings, next);
      syncDefaultRuntimeDefaults(next);
    } catch (e) {
      if (previous) {
        queryClient.setQueryData(queryKeys.settings, previous);
        syncDefaultRuntimeDefaults(previous);
      }
      if (isStaleSettingsSchemaError(e, patch)) {
        toast.error(
          "Settings API is still running the old schema. Restart the Actana Control dev server, then choose the harness again.",
        );
        return;
      }
      toast.error(e instanceof Error ? e.message : "Could not update defaults");
    } finally {
      runtimeUpdateInFlightRef.current = false;
      setRuntimeUpdating(false);
    }
  };

  return (
    <>
      <SettingsSection
        title="Defaults"
        subtitle="Tools Actana Control reaches for behind the scenes."
        headingLevel="h1"
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "220px minmax(0, 1fr)",
            gap: 16,
            alignItems: "flex-start",
          }}
        >
          <FeatureNav activeFeature={activeFeature} onSelect={setActiveFeature} />
          <div
            style={{
              minWidth: 0,
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 16,
            }}
          >
            {activeFeature === "ship" && (
              <FeaturePanel
                featureId="ship"
                title="Ship"
                description={
                  <>
                    When you press <strong>Ship</strong>, Actana Control opens
                    an AI session with this harness and injects the prompt below
                    so the agent can push and sync with remote.
                  </>
                }
              >
                <RuntimeDefaultControl
                  agent={currentShipAgent}
                  model={currentShipModel}
                  disabled={runtimeUpdating}
                  onAgentSelect={(agent) =>
                    void updateRuntimeDefaults({
                      shipAgent: agent,
                      shipModel: modelForSelectedHarness(agent, currentShipModel),
                    })
                  }
                  onModelSelect={(model) =>
                    void updateRuntimeDefaults({ shipModel: model })
                  }
                />
                <Field label="Ship prompt">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <textarea
                      value={shipPromptDraft}
                      onChange={(e) => setShipPromptDraft(e.target.value)}
                      rows={4}
                      disabled={shipPromptSaving || runtimeUpdating}
                      style={{
                        width: "100%",
                        resize: "vertical",
                        minHeight: 88,
                        padding: "10px 12px",
                        borderRadius: 7,
                        border: "1px solid var(--border)",
                        background: "var(--surface-0)",
                        color: "var(--text)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        lineHeight: 1.45,
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Btn
                        variant="primary"
                        size="sm"
                        disabled={
                          shipPromptSaving ||
                          runtimeUpdating ||
                          shipPromptDraft.trim() === currentShipPrompt
                        }
                        onClick={() => {
                          const next = shipPromptDraft.trim() || DEFAULT_SHIP_PROMPT;
                          setShipPromptSaving(true);
                          void updateRuntimeDefaults({ shipPrompt: next }).finally(() => {
                            setShipPromptSaving(false);
                          });
                        }}
                      >
                        {shipPromptSaving ? "Saving…" : "Save prompt"}
                      </Btn>
                      <Btn
                        variant="ghost"
                        size="sm"
                        disabled={
                          shipPromptSaving ||
                          runtimeUpdating ||
                          shipPromptDraft === DEFAULT_SHIP_PROMPT
                        }
                        onClick={() => {
                          setShipPromptDraft(DEFAULT_SHIP_PROMPT);
                          setShipPromptSaving(true);
                          void updateRuntimeDefaults({
                            shipPrompt: DEFAULT_SHIP_PROMPT,
                          }).finally(() => {
                            setShipPromptSaving(false);
                          });
                        }}
                      >
                        Reset to default
                      </Btn>
                    </div>
                  </div>
                </Field>
              </FeaturePanel>
            )}
          </div>
        </div>
      </SettingsSection>
    </>
  );
}

export function modelForSelectedHarness(
  agent: AiRuntimeHarness,
  model: AiModelId | null,
): AiModelId | null {
  return modelBelongsToHarnessCatalog(agent, model) ? model : null;
}

function isStaleSettingsSchemaError(
  error: unknown,
  patch: Partial<Pick<AppSettings, "defaultAgent" | "shipAgent">>,
): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) return false;
  const message = error.message;
  return (
    ("defaultAgent" in patch && message.includes('Unrecognized key: "defaultAgent"')) ||
    ("shipAgent" in patch && message.includes('Unrecognized key: "shipAgent"'))
  );
}

function FeatureNav({
  activeFeature,
  onSelect,
}: {
  activeFeature: DefaultsFeatureId;
  onSelect: (feature: DefaultsFeatureId) => void;
}) {
  return (
    <nav
      aria-label="Default feature settings"
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {DEFAULTS_FEATURES.map((feature) => {
        const selected = feature.id === activeFeature;
        return (
          <button
            key={feature.id}
            type="button"
            onClick={() => onSelect(feature.id)}
            aria-pressed={selected}
            style={{
              padding: "12px 13px",
              borderRadius: 8,
              border: `1px solid ${selected ? "var(--accent-border)" : "var(--border)"}`,
              background: selected ? "var(--accent-dim)" : "var(--surface-0)",
              color: "var(--text)",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>
              {feature.label}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.4 }}>
              {feature.description}
            </div>
          </button>
        );
      })}
    </nav>
  );
}

function FeaturePanel({
  featureId,
  title,
  description,
  children,
}: {
  featureId: DefaultsFeatureId;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={featurePanelId(featureId)}
      role="region"
      aria-labelledby={featureHeadingId(featureId)}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div>
        <h2
          id={featureHeadingId(featureId)}
          style={{
            margin: "0 0 4px",
            fontSize: 18,
            lineHeight: 1.2,
            color: "var(--text)",
          }}
        >
          {title}
        </h2>
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.55 }}>
          {description}
        </div>
      </div>
      {children}
    </section>
  );
}

function featurePanelId(featureId: DefaultsFeatureId): string {
  return `defaults-feature-panel-${featureId}`;
}

function featureHeadingId(featureId: DefaultsFeatureId): string {
  return `defaults-feature-heading-${featureId}`;
}

export function RuntimeDefaultControl({
  agent,
  model,
  disabled,
  onAgentSelect,
  onModelSelect,
}: {
  agent: AiRuntimeHarness;
  model: AiModelId | null;
  disabled: boolean;
  onAgentSelect: (agent: AiRuntimeHarness) => void;
  onModelSelect: (model: AiModelId | null) => void;
}) {
  const modelSelectId = useId();
  const modelHelpId = useId();
  const [liveModels, setLiveModels] = useState<AiRuntimeModelsResponse | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const fallbackModels = getAiRuntimeModelOptions(agent);
  const discoveredModels =
    liveModels?.harness === agent && liveModels.models.length > 0
      ? liveModels.models
      : fallbackModels;
  const modelOptions = includeSavedModel(discoveredModels, model);
  const focusHarness = (nextAgent: AiRuntimeHarness) => {
    requestAnimationFrame(() => {
      document.getElementById(harnessOptionId(nextAgent))?.focus();
    });
  };
  const selectHarnessByOffset = (offset: number) => {
    const index = AI_RUNTIME_HARNESS_VALUES.indexOf(agent);
    const nextIndex =
      (index + offset + AI_RUNTIME_HARNESS_VALUES.length) %
      AI_RUNTIME_HARNESS_VALUES.length;
    const nextAgent = AI_RUNTIME_HARNESS_VALUES[nextIndex]!;
    onAgentSelect(nextAgent);
    focusHarness(nextAgent);
  };

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    api
      .listAiRuntimeModels(agent)
      .then((result) => {
        if (!cancelled) setLiveModels(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setLiveModels({
            harness: agent,
            source: "catalog",
            models: [...fallbackModels],
            error:
              error instanceof Error
                ? `Could not reach model list API: ${error.message}`
                : "Could not reach model list API.",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, fallbackModels]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Harness">
        <div
          role="radiogroup"
          aria-label="Harness"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowRight") {
              event.preventDefault();
              selectHarnessByOffset(1);
            } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
              event.preventDefault();
              selectHarnessByOffset(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              const nextAgent = AI_RUNTIME_HARNESS_VALUES[0]!;
              onAgentSelect(nextAgent);
              focusHarness(nextAgent);
            } else if (event.key === "End") {
              event.preventDefault();
              const nextAgent =
                AI_RUNTIME_HARNESS_VALUES[AI_RUNTIME_HARNESS_VALUES.length - 1]!;
              onAgentSelect(nextAgent);
              focusHarness(nextAgent);
            }
          }}
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          {AI_RUNTIME_HARNESS_VALUES.map((value) => (
            <HarnessOption
              key={value}
              agent={value}
              selected={agent === value}
              disabled={disabled}
              tabIndex={agent === value ? 0 : -1}
              onSelect={() => onAgentSelect(value)}
            />
          ))}
        </div>
      </Field>
      <Field label="Model">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <select
            id={modelSelectId}
            value={model ?? ""}
            disabled={disabled}
            aria-label="Model"
            onChange={(event) => {
              const value = event.target.value;
              onModelSelect(value ? (value as AiModelId) : null);
            }}
            aria-describedby={modelHelpId}
            style={{
              width: "100%",
              padding: "9px 10px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--surface-0)",
              color: "var(--text)",
              fontFamily: "var(--mono)",
              fontSize: 12,
            }}
          >
            <option value="">Use {AGENT_REGISTRY[agent].label} default</option>
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} ({option.id})
              </option>
            ))}
          </select>
          <div
            id={modelHelpId}
            role={
              loadingModels || (liveModels?.harness === agent && liveModels.error)
                ? "status"
                : undefined
            }
            aria-live={
              loadingModels || (liveModels?.harness === agent && liveModels.error)
                ? "polite"
                : undefined
            }
            aria-busy={loadingModels}
            style={{
              fontSize: 11.5,
              color:
                liveModels?.harness === agent && liveModels.error
                  ? "var(--status-failed)"
                  : "var(--text-faint)",
              lineHeight: 1.45,
            }}
          >
            {modelHelpText(agent, liveModels, loadingModels)}
          </div>
          {selectedModelDescription(modelOptions, model) && (
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.45 }}>
              {selectedModelDescription(modelOptions, model)}
            </div>
          )}
        </div>
      </Field>
    </div>
  );
}

function includeSavedModel(
  options: readonly AiModelOption[],
  model: AiModelId | null,
): AiModelOption[] {
  const out = [...options];
  if (model && isAiModelId(model) && !out.some((option) => option.id === model)) {
    out.unshift({
      id: model,
      label: "Saved custom model",
      description: "This saved model is not in the current harness model list.",
    });
  }
  return out;
}

function selectedModelDescription(
  options: readonly AiModelOption[],
  model: AiModelId | null,
): string | null {
  if (!model) return null;
  return options.find((option) => option.id === model)?.description ?? null;
}

function modelHelpText(
  agent: AiRuntimeHarness,
  liveModels: AiRuntimeModelsResponse | null,
  loading: boolean,
): string {
  if (loading) return "Refreshing the model list from the selected harness…";
  if (liveModels?.harness !== agent) {
    return "Choose a model id to pass as a single --model argument to the selected CLI.";
  }
  if (liveModels.error) {
    if (liveModels.error.startsWith("Could not reach")) {
      return `${liveModels.error} Showing built-in model choices.`;
    }
    return "Could not refresh models from the selected CLI. Showing known model choices.";
  }
  if (liveModels.source === "cli") {
    return "Models were discovered from the selected harness on this machine.";
  }
  return "Choose a known model id, or leave this on the CLI default.";
}

function HarnessOption({
  agent,
  selected,
  disabled,
  tabIndex,
  onSelect,
}: {
  agent: AiRuntimeHarness;
  selected: boolean;
  disabled: boolean;
  tabIndex: number;
  onSelect: () => void;
}) {
  const meta = AGENT_REGISTRY[agent];
  return (
    <button
      id={harnessOptionId(agent)}
      type="button"
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      tabIndex={tabIndex}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 14px",
        background: selected ? "var(--accent-dim)" : "var(--surface-0)",
        border: `1px solid ${selected ? "var(--accent-border)" : "var(--border)"}`,
        borderRadius: 7,
        cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left",
        color: "var(--text)",
        transition: "background 0.15s, border-color 0.15s",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: 999,
            border: `2px solid ${selected ? "var(--accent)" : "var(--border)"}`,
            background: selected ? "var(--accent)" : "transparent",
            flexShrink: 0,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-dim)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            ${meta.command}
          </div>
        </div>
      </div>
    </button>
  );
}

function harnessOptionId(agent: AiRuntimeHarness): string {
  return `defaults-harness-option-${agent}`;
}
