import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Modal } from "~/components/ui/Modal";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { Btn } from "~/components/ui/Btn";
import { HotkeyTooltip, EscTooltip } from "~/components/ui/Tooltip";
import { isEditableTarget, useHotkey } from "~/lib/use-hotkey";
import { HARNESS_META } from "~/lib/design-meta";
import { HarnessLogo } from "~/components/ui/HarnessLogo";
import { getPanelBridge } from "~/lib/panel-bridge";
import {
  harnessCanLaunch,
  firstAvailableHarness,
  availabilityFor,
  installStateFor,
  type CliAvailability,
  useCliAvailability,
  useHarnessInstall,
} from "~/lib/cli-availability";
import { coreHasHarness } from "~/lib/core-has-harness";
import { TITLE_WAITING } from "~/lib/session-sentinels";
import { useSettings } from "~/queries";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import {
  DEFAULT_AGENT_LAUNCHER_CONFIG,
  visibleLauncherHarnesses,
} from "~/shared/harness-launcher-config";
import { useCores } from "~/lib/use-fleet";
import { SESSION_REPORT_LOCATION } from "~/lib/session-report-location";
import type { Harness } from "@actana/shared/domain";

export type RememberPatch = {
  rememberHarnessSettings: boolean;
  savedHarness: Harness | null;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    !!target.closest("button, a, input, textarea, select, [role='button']");
}

const labelStyle: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 500,
  color: "var(--text-dim)",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  display: "block",
  marginBottom: 8,
};

/**
 * Start a new session (design screen 03, issue 560): harness picker + prompt,
 * a Runs on line, no path or cwd. Remember is per Core. Start lists only
 * harnesses this Core has; missing CLIs offer Install on this dialog's Core
 * (the route coreId), never the globally selected Core.
 */
export function NewHarnessDialog({
  open,
  coreId = null,
  coreLabel: coreLabelProp,
  initialRemember,
  onClose,
  onStart,
  onPersistRemember,
  onHarnessUpdateRequired,
  onPrepareWarm,
}: {
  open: boolean;
  /** Which Core the Session will belong to. Null means nothing can launch. */
  coreId?: string | null;
  /** Display name for the Runs on line; falls back to the Core registry. */
  coreLabel?: string;
  /** Seed for the Remember checkbox (from {@link readCoreRemember}). */
  initialRemember?: RememberPatch | null;
  onClose: () => void;
  onStart: (data: {
    agent: Harness;
    title: string;
    prompt: string;
    bareSession: boolean;
  }) => Promise<void> | void;
  onPersistRemember: (patch: RememberPatch) => Promise<void> | void;
  onHarnessUpdateRequired?: (agent: Harness, availability: CliAvailability) => void;
  onPrepareWarm?: (payload: {
    agent: Harness;
    bareSession: boolean;
  }) => void;
}) {
  const [agent, setHarness] = useState<Harness>("claude-code");
  const [prompt, setPrompt] = useState("");
  const [rememberSettings, setRememberSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cliAvailability = useCliAvailability(coreId);
  const { installs, install } = useHarnessInstall(coreId);
  const [installIntent, setInstallIntent] = useState<Harness | null>(null);
  const { data: settings } = useSettings();
  const { cores } = useCores();
  const coreLabel =
    cores.find((c) => c.id === coreId)?.label ||
    coreLabelProp ||
    coreId ||
    "Core";

  const launcherConfig = settings?.harnessLauncherConfig ?? DEFAULT_AGENT_LAUNCHER_CONFIG;
  const allLauncher = useMemo(
    () =>
      visibleLauncherHarnesses(launcherConfig)
        .filter((id) => HARNESS_REGISTRY[id].uiVisible)
        .map((id) => ({ id, ...HARNESS_REGISTRY[id] })),
    [launcherConfig],
  );
  // Start only with harnesses this Core has (issue 560).
  const harnessOptions = useMemo(
    () => allLauncher.filter((a) => coreHasHarness(cliAvailability, a.id)),
    [allLauncher, cliAvailability],
  );
  // Missing on this Core — Install targets the dialog's coreId, not Providers'
  // globally selected Core.
  const missingOptions = useMemo(
    () =>
      allLauncher.filter((a) => {
        if (a.disabled) return false;
        const status = availabilityFor(cliAvailability, a.id).status;
        return status === "missing" || installStateFor(installs, a.id).installing;
      }),
    [allLauncher, cliAvailability, installs],
  );

  const buildRememberPatch = (
    nextRememberSettings: boolean,
    nextHarness: Harness,
  ): RememberPatch => ({
    rememberHarnessSettings: nextRememberSettings,
    savedHarness: nextHarness,
  });

  useEffect(() => {
    if (!open || !onPrepareWarm) return;
    onPrepareWarm({ agent, bareSession: false });
  }, [open, agent, onPrepareWarm]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
      return;
    }
    const seedHarness: Harness =
      initialRemember?.savedHarness &&
      harnessOptions.some((a) => a.id === initialRemember.savedHarness)
        ? initialRemember.savedHarness
        : firstAvailableHarness(cliAvailability, harnessOptions.map((a) => a.id)) ?? "claude-code";
    setHarness(seedHarness);
    setPrompt("");
    setInstallIntent(
      missingOptions.find((a) => installStateFor(installs, a.id).installing)?.id ?? null,
    );
    setRememberSettings(!!initialRemember?.rememberHarnessSettings);
    setError(null);
    setSubmitting(false);
    // Focus the prompt — New Session is prompt-first (design 03).
    requestAnimationFrame(() => promptRef.current?.focus());
    // Seed only when the dialog opens.
  }, [open]);

  const toggleRemember = async (next: boolean) => {
    setRememberSettings(next);
    await onPersistRemember(buildRememberPatch(next, agent));
  };

  const selectHarness = (nextHarness: Harness) => {
    const nextAvailability = availabilityFor(cliAvailability, nextHarness);
    const canSelect = harnessCanLaunch(cliAvailability, nextHarness) ||
      nextAvailability.status === "outdated";
    if (!canSelect) return;
    setHarness(nextHarness);
    void onPersistRemember(buildRememberPatch(rememberSettings, nextHarness));
  };

  const submit = () => {
    if (submitting) return;
    const selectedAvailability = availabilityFor(cliAvailability, agent);
    if (selectedAvailability.status === "outdated") {
      onHarnessUpdateRequired?.(agent, selectedAvailability);
      return;
    }
    if (selectedAvailability.status === "missing") {
      setError(
        `${HARNESS_REGISTRY[agent].command} is not on PATH on \`${coreLabel}\`. Use Install on this Core below.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      void onPersistRemember(buildRememberPatch(rememberSettings, agent));
      Promise.resolve(
        onStart({
          agent,
          title: TITLE_WAITING,
          prompt: prompt.trim(),
          bareSession: false,
        }),
      ).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to start session"),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start session");
    } finally {
      setSubmitting(false);
    }
  };

  const startInstall = (nextHarness: Harness) => {
    setError(null);
    setInstallIntent(nextHarness);
    // Install on this dialog's Core — the route coreId — never Providers'
    // globally selected Core.
    install(nextHarness);
  };

  useEffect(() => {
    if (!open || !installIntent) return;
    if (!harnessCanLaunch(cliAvailability, installIntent)) return;
    setInstallIntent(null);
    selectHarness(installIntent);
  }, [open, installIntent, cliAvailability]);

  useEffect(() => {
    if (!open) return;
    if (harnessOptions.some((a) => a.id === agent)) return;
    const next = firstAvailableHarness(cliAvailability, harnessOptions.map((a) => a.id)) ?? harnessOptions[0]?.id;
    if (next) setHarness(next);
  }, [open, agent, harnessOptions, cliAvailability]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const ids = harnessOptions
          .filter((a) => {
            const availability = availabilityFor(cliAvailability, a.id);
            return harnessCanLaunch(cliAvailability, a.id) ||
              availability.status === "outdated";
          })
          .map((a) => a.id);
        const idx = ids.indexOf(agent);
        const next = e.key === "ArrowDown"
          ? Math.min(ids.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        if (next !== idx && ids[next]) setHarness(ids[next]);
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, agent, submitting, rememberSettings, cliAvailability, harnessOptions, prompt]);

  const selectedAvailability = availabilityFor(cliAvailability, agent);
  const selectedHarnessOutdated = selectedAvailability.status === "outdated";
  const startDisabled =
    submitting ||
    harnessOptions.length === 0 ||
    (!selectedHarnessOutdated && !harnessCanLaunch(cliAvailability, agent));

  useHotkey("dialog.submit", () => void submit(), { enabled: open && !startDisabled });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a new session"
      width={540}
      footer={
        <>
          <EscTooltip label="Cancel">
            <Btn variant="ghost" onClick={onClose}>
              Cancel
            </Btn>
          </EscTooltip>
          <HotkeyTooltip action="dialog.submit">
            <Btn variant="primary" icon="play" onClick={submit} disabled={startDisabled}>
              Start session
            </Btn>
          </HotkeyTooltip>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <span style={labelStyle}>Runs on</span>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--text)",
              lineHeight: 1.45,
            }}
          >
            {coreLabel}
            {"  ·  in ~  ·  reports → "}
            {SESSION_REPORT_LOCATION}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Harness</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {harnessOptions.length === 0 && missingOptions.length === 0 && (
              <div
                style={{
                  padding: "12px 14px",
                  background: "var(--surface-0)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--text-dim)",
                  lineHeight: 1.45,
                }}
              >
                No harnesses are offered for this Core yet.
              </div>
            )}
            {harnessOptions.map((a) => {
              const meta = HARNESS_META[a.id];
              const selected = agent === a.id;
              const availability = availabilityFor(cliAvailability, a.id);
              const cliChecking =
                availability.status === "checking" ||
                (availability.status === "unknown" && !!getPanelBridge());
              const cliOutdated = availability.status === "outdated";
              const cliNeedsSetup = availability.status === "needs-setup";
              const disabled =
                !cliOutdated && !harnessCanLaunch(cliAvailability, a.id);
              return (
                <div key={a.id} style={{ position: "relative", display: "flex" }}>
                  <button
                    onClick={() => !disabled && selectHarness(a.id)}
                    disabled={disabled}
                    aria-disabled={disabled}
                    title={
                      a.disabled
                        ? "Coming soon"
                        : cliOutdated
                          ? `${a.command} must be updated before launching`
                        : cliChecking
                          ? `Checking for ${a.command}`
                        : undefined
                    }
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      textAlign: "left",
                      padding: "12px 14px",
                      background: selected ? "var(--surface-2)" : "var(--surface-0)",
                      border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 8,
                      cursor: disabled ? "not-allowed" : "pointer",
                      color: "var(--text)",
                      boxShadow: selected ? "0 0 0 1px var(--accent)" : "none",
                      opacity: disabled ? 0.56 : 1,
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 6,
                        background: `${meta.color}22`,
                        border: `1px solid ${meta.color}44`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: meta.color,
                        fontSize: 15,
                        fontFamily: "var(--mono)",
                        flexShrink: 0,
                      }}
                    >
                      <HarnessLogo agent={a.id} size={20} title={a.label} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{a.label}</div>
                      <div
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--text-dim)",
                          lineHeight: 1.4,
                        }}
                      >
                        {a.description}
                      </div>
                      {(cliChecking || cliOutdated || cliNeedsSetup) && (
                        <div
                          style={{
                            marginTop: 5,
                            fontFamily: "var(--mono)",
                            fontSize: 10.5,
                            color: cliOutdated ? "var(--status-failed)" : cliNeedsSetup ? "var(--warning)" : "var(--text-faint)",
                            lineHeight: 1.35,
                          }}
                        >
                          {cliOutdated
                            ? `Update required: ${availability.label ?? a.label} ${availability.requiredVersion ?? "latest"} or newer.`
                            : cliNeedsSetup
                              ? `Needs setup (${availability.setupDialog}): start a Session and finish it in ${a.label}.`
                              : "Checking PATH..."}
                        </div>
                      )}
                    </div>
                    <code
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10.5,
                        color: "var(--text-faint)",
                        background: "var(--surface-0)",
                        padding: "3px 7px",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        textTransform: disabled ? "uppercase" : "none",
                        letterSpacing: disabled ? "0.05em" : "normal",
                      }}
                    >
                      {a.disabled
                        ? "Coming soon"
                        : cliOutdated
                          ? "Update"
                          : cliChecking
                            ? "Checking"
                            : `$${a.command}`}
                    </code>
                  </button>
                </div>
              );
            })}
            {missingOptions.length > 0 && (
              <>
                {harnessOptions.length > 0 && (
                  <span style={{ ...labelStyle, marginTop: 6, marginBottom: 0 }}>
                    Not on {coreLabel} yet
                  </span>
                )}
                {harnessOptions.length === 0 && (
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      color: "var(--text-dim)",
                      lineHeight: 1.45,
                      marginBottom: 4,
                    }}
                  >
                    This Core has no harness CLIs yet. Install one on {coreLabel}:
                  </div>
                )}
                {missingOptions.map((a) => {
                  const meta = HARNESS_META[a.id];
                  const installState = installStateFor(installs, a.id);
                  const installing = installState.installing;
                  return (
                    <div key={a.id} style={{ position: "relative", display: "flex" }}>
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          textAlign: "left",
                          padding: "12px 108px 12px 14px",
                          background: "var(--surface-0)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          color: "var(--text)",
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 6,
                            background: `${meta.color}22`,
                            border: `1px solid ${meta.color}44`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: meta.color,
                            flexShrink: 0,
                          }}
                        >
                          <HarnessLogo agent={a.id} size={20} title={a.label} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                            {a.label}
                          </div>
                          <div
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 10.5,
                              color: installing ? "var(--text-faint)" : "var(--status-failed)",
                              lineHeight: 1.35,
                            }}
                          >
                            {installing
                              ? `Installing on ${coreLabel}...`
                              : installState.error ?? "CLI not found on PATH."}
                          </div>
                        </div>
                      </div>
                      <Btn
                        size="sm"
                        variant="frame"
                        icon={installing ? undefined : "download"}
                        disabled={installing || !coreId}
                        onClick={() => startInstall(a.id)}
                        title={
                          installing
                            ? `Installing ${a.command} on ${coreLabel}`
                            : `Install ${a.command} on ${coreLabel}`
                        }
                        style={{
                          position: "absolute",
                          right: 10,
                          top: "50%",
                          transform: "translateY(-50%)",
                        }}
                      >
                        {installing ? "Installing..." : "Install"}
                      </Btn>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <div>
          <label style={labelStyle} htmlFor="new-session-prompt">
            Prompt
          </label>
          <textarea
            id="new-session-prompt"
            ref={promptRef}
            aria-label="Prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Implement issue 558 in the control repo..."
            rows={4}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              minHeight: 88,
              padding: "10px 12px",
              fontFamily: "var(--mono)",
              fontSize: 12.5,
              lineHeight: 1.45,
              color: "var(--text)",
              background: "var(--surface-0)",
              border: "1px solid var(--border)",
              borderRadius: 7,
            }}
          />
          <div
            style={{
              marginTop: 6,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-dim)",
              lineHeight: 1.4,
            }}
          >
            A Session always starts in ~ and has no path of its own. Name a folder in the prompt to
            focus it.
          </div>
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 12px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={rememberSettings}
            onChange={(e) => void toggleRemember(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>
              Remember this harness for this Core
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-dim)",
                lineHeight: 1.4,
              }}
            >
              The New session button will skip this dialog and start{" "}
              <code style={{ color: "var(--text)" }}>{HARNESS_META[agent].label}</code> directly.
            </div>
          </div>
        </label>

        <FormErrorBox error={error} />
      </div>
    </Modal>
  );
}
