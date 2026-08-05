import { useEffect, useMemo, useState } from "react";
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
  availabilityFor,
  installStateFor,
  type CliAvailability,
  useCliAvailability,
  useHarnessInstall,
} from "~/lib/cli-availability";
import { TITLE_WAITING } from "~/lib/task-sentinels";
import { useSettings } from "~/queries";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import {
  DEFAULT_AGENT_LAUNCHER_CONFIG,
  visibleLauncherHarnesses,
} from "~/shared/harness-launcher-config";
import { useCores } from "~/lib/use-fleet";
import { DEFAULT_BRANCH } from "@actana/shared/domain";
import type { Harness } from "@actana/shared/domain";
import type { Project } from "~/db/schema";

export type RememberPatch = {
  rememberHarnessSettings: boolean;
  savedHarness: Harness | null;
  savedSkipPermissions: boolean;
  savedBareSession: boolean;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    !!target.closest("button, a, input, textarea, select, [role='button']");
}

export function NewHarnessDialog({
  open,
  project,
  // The picker reads its availability from the Core this Task will belong to —
  // one dialog for every Core (Singular UI invariant), no branch inside the
  // picker. Missing / outdated states, keyboard skip-over, and the submit gate
  // all consult that Core's Core-published probe.
  coreId = null,
  onClose,
  onStart,
  onPersistRemember,
  onHarnessUpdateRequired,
  onPrepareWarm,
}: {
  open: boolean;
  project: Project | null;
  /** Which Core the created Task will belong to. Null means no Core is
   *  selected, and nothing can launch. */
  coreId?: string | null;
  onClose: () => void;
  onStart: (data: {
    agent: Harness;
    title: string;
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
  const [rememberSettings, setRememberSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cliAvailability = useCliAvailability(coreId);
  // A missing CLI is a thing the operator can fix from here (issue 83): the
  // owning Core installs it and republishes availability. `installIntent` is
  // the Harness they clicked Install on — it wins the selection once it lands,
  // ahead of the effect below that moves the selection off missing rows.
  const { installs, install } = useHarnessInstall(coreId);
  const [installIntent, setInstallIntent] = useState<Harness | null>(null);
  const { data: settings } = useSettings();
  // Resolve the Core's alias for the error copy — an operator with several
  // Cores registered needs to know *where* to install a missing CLI, not just
  // that it's missing. Falls back to the coreId when the label lookup misses
  // (the store hasn't loaded yet, or the coreId isn't in the registry).
  const { cores } = useCores();
  const coreLabel =
    cores.find((c) => c.id === coreId)?.label || coreId;

  // Order + visibility come from Settings → Providers. Hiding only affects
  // this picker; a hidden savedHarness still launches through the skip-dialog path.
  const launcherConfig = settings?.harnessLauncherConfig ?? DEFAULT_AGENT_LAUNCHER_CONFIG;
  const harnessOptions = useMemo(
    () =>
      visibleLauncherHarnesses(launcherConfig)
        .filter((id) => HARNESS_REGISTRY[id].uiVisible)
        .map((id) => ({ id, ...HARNESS_REGISTRY[id] })),
    [launcherConfig],
  );

  // `savedSkipPermissions` is carried for symmetry with the column that still
  // exists, and is always false: auto-mode is unconditional (issue 22) and no
  // launch path reads this field. Setting it from a user choice would
  // reintroduce the control that was removed.
  const buildSessionSettingsPatch = (
    nextRememberSettings: boolean,
    nextHarness: Harness,
  ): RememberPatch => ({
    rememberHarnessSettings: nextRememberSettings,
    savedHarness: nextHarness,
    savedSkipPermissions: false,
    savedBareSession: false,
  });

  useEffect(() => {
    if (!open || !project || !onPrepareWarm) return;
    onPrepareWarm({ agent, bareSession: false });
  }, [open, project, agent, onPrepareWarm]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
      return;
    }
    // A saved agent that has since been hidden can't be highlighted in the
    // picker — seed the first visible option instead.
    const seedHarness: Harness =
      project?.savedHarness && harnessOptions.some((a) => a.id === project.savedHarness)
        ? project.savedHarness
        : harnessOptions[0]?.id ?? "claude-code";
    setHarness(seedHarness);
    // An install still running from a previous opening of this dialog is still
    // the Harness the operator asked for — the store outlives the component, so
    // reopening picks the intent back up rather than dropping it.
    setInstallIntent(
      harnessOptions.find((a) => installStateFor(installs, a.id).installing)?.id ?? null,
    );
    setRememberSettings(!!project?.rememberHarnessSettings);
    setError(null);
    setSubmitting(false);
    // Seed only when the dialog opens; later refreshes of `project` (e.g. after
    // persisting the remember toggle) must not stomp in-flight form state.
  }, [open]);

  const toggleRemember = async (next: boolean) => {
    setRememberSettings(next);
    await onPersistRemember(buildSessionSettingsPatch(next, agent));
  };

  const selectHarness = (nextHarness: Harness) => {
    const nextAvailability = availabilityFor(cliAvailability, nextHarness);
    const canSelect = harnessCanLaunch(cliAvailability, nextHarness) ||
      nextAvailability.status === "outdated";
    if (!canSelect) return;
    setHarness(nextHarness);
    void onPersistRemember(buildSessionSettingsPatch(rememberSettings, nextHarness));
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
        `${HARNESS_REGISTRY[agent].command} is not on PATH on \`${coreLabel}\`.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      void onPersistRemember(buildSessionSettingsPatch(rememberSettings, agent));
      onStart({
        agent,
        title: TITLE_WAITING,
        bareSession: false,
      });
    } catch (e: any) {
      setError(e?.message || "Failed to start session");
    } finally {
      setSubmitting(false);
    }
  };

  const startInstall = (nextHarness: Harness) => {
    setError(null);
    setInstallIntent(nextHarness);
    install(nextHarness);
  };

  // Clicking Install is a choice of Harness, made before that Harness could be
  // chosen. Honour it the moment the Core says it landed — otherwise the
  // operator installs the one they wanted and starts a session on another.
  useEffect(() => {
    if (!open || !installIntent) return;
    if (!harnessCanLaunch(cliAvailability, installIntent)) return;
    setInstallIntent(null);
    selectHarness(installIntent);
  }, [open, installIntent, cliAvailability]);

  useEffect(() => {
    if (!open) return;
    if (availabilityFor(cliAvailability, agent).status !== "missing") return;
    // …but not off a Harness that is being installed right now: the selection
    // would jump away mid-install and the intent effect above would have to
    // fight it back.
    if (installStateFor(installs, agent).installing) return;
    const next = harnessOptions.find((a) => harnessCanLaunch(cliAvailability, a.id))?.id;
    if (next && next !== agent) setHarness(next);
  }, [open, agent, cliAvailability, harnessOptions, installs]);

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
  }, [open, agent, submitting, project, rememberSettings, cliAvailability, harnessOptions]);

  const selectedAvailability = availabilityFor(cliAvailability, agent);
  const selectedHarnessOutdated = selectedAvailability.status === "outdated";
  const startDisabled =
    submitting ||
    (!selectedHarnessOutdated && !harnessCanLaunch(cliAvailability, agent));

  useHotkey("dialog.submit", () => void submit(), { enabled: open && !startDisabled });

  return (
    <>
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
          <label
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 500,
              color: "var(--text-dim)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 8,
            }}
          >
            Harness
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {harnessOptions.map((a) => {
              const meta = HARNESS_META[a.id];
              const selected = agent === a.id;
              const availability = availabilityFor(cliAvailability, a.id);
              const installState = installStateFor(installs, a.id);
              const installing = installState.installing;
              // "unknown" with a live link means the Core hasn't published its
              // snapshot yet — that reads as checking, not as launchable. An
              // install in flight outranks it: the Core's post-install re-probe
              // passes through `checking`, and a row that flipped to "Checking
              // PATH..." there would drop the install the operator is watching.
              const cliChecking =
                !installing &&
                (availability.status === "checking" ||
                  (availability.status === "unknown" && !!getPanelBridge()));
              const cliOutdated = availability.status === "outdated";
              // A registry-disabled Harness ("Coming soon") also probes as
              // `missing`, and nothing about it is installable — it stays the
              // greyed-out row it has always been.
              const cliMissing =
                !a.disabled && !cliOutdated && (availability.status === "missing" || installing);
              // Missing is no longer a dead end (issue 83): the row keeps its
              // full weight and carries an Install button instead. It is still
              // not selectable — that waits for the Core to report it available.
              const disabled =
                !cliOutdated && !cliMissing && !harnessCanLaunch(cliAvailability, a.id);
              return (
                <div key={a.id} style={{ position: "relative", display: "flex" }}>
                  <button
                    onClick={() => !disabled && selectHarness(a.id)}
                    disabled={disabled}
                    aria-disabled={disabled}
                    title={
                      a.disabled
                        ? "Coming soon"
                        : installing
                          ? `Installing ${a.command} on ${coreLabel}`
                        : cliMissing
                          ? `${a.command} was not found on PATH`
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
                      // Room on the right for the Install button, which sits over
                      // the card rather than beside it so the row stays one card.
                      padding: cliMissing ? "12px 108px 12px 14px" : "12px 14px",
                      background: selected ? "var(--surface-2)" : "var(--surface-0)",
                      border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 8,
                      // A missing row is neither greyed out nor selectable: the
                      // Install button beside it is the thing to click, and a
                      // pointer over the card would promise a selection that
                      // `selectHarness` is right to refuse.
                      cursor: disabled ? "not-allowed" : cliMissing ? "default" : "pointer",
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
                      {(cliChecking || cliMissing || cliOutdated) && (
                        <div
                          style={{
                            marginTop: 5,
                            fontFamily: "var(--mono)",
                            fontSize: 10.5,
                            color:
                              (cliMissing && !installing) || cliOutdated
                                ? "var(--status-failed)"
                                : "var(--text-faint)",
                            lineHeight: 1.35,
                          }}
                        >
                          {cliMissing
                            ? installing
                              ? `Installing on ${coreLabel}...`
                              : installState.error ?? "CLI not found on PATH."
                            : cliOutdated
                              ? `Update required: ${availability.label ?? a.label} ${availability.requiredVersion ?? "latest"} or newer.`
                              : "Checking PATH..."}
                        </div>
                      )}
                    </div>
                    {!cliMissing && (
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
                    )}
                  </button>
                  {cliMissing && (
                    // Its own button, a sibling of the row rather than a child:
                    // a button inside a button is not something the DOM keeps.
                    // Overlaid on the card's right edge and in the tab order, so
                    // the row a keyboard operator cannot select is still one
                    // they can act on.
                    <Btn
                      size="sm"
                      variant="frame"
                      icon={installing ? undefined : "download"}
                      disabled={installing}
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
                  )}
                </div>
              );
            })}
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
              Remember settings for this project
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
    </>
  );
}
