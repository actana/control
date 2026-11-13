import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Btn } from "~/components/ui/Btn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Modal } from "~/components/ui/Modal";
import { TextField } from "~/components/ui/TextField";
import { Field, SettingsSection } from "~/components/views/SettingsParts";
import { ApiError, api } from "~/lib/api";
import { availabilityFor, useCliAvailability, type CliAvailabilityMap } from "~/lib/cli-availability";
import { useFleet } from "~/lib/fleet-context";
import { useIsPhone } from "~/lib/breakpoint";
import { queryKeys, useCoreAgents } from "~/queries";
import { AGENT_MODEL_PATTERN, AGENT_NAME_MAX, HARNESSES, flagsForHarness, type Harness } from "~/shared/agents";
import type { AgentDto } from "~/shared/task-wire";
import type { CoreWithDial } from "~/shared/cores";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import { getAiRuntimeModelOptions } from "@actana/shared/ai-runtime-defaults";

/**
 * Settings › Agents (#893): each Core's Agents, with create, edit and delete
 * for the signed-in operator, no API key needed. An Agent is a harness, a model
 * and flags from a closed set on one Core; there is deliberately no command,
 * argument, script or environment field. The harness and the Core are fixed
 * once the Agent exists, so editing shows them read-only. A default Agent is
 * the Core's own and can be neither changed nor deleted (the service answers
 * 409); the row says so instead of offering the buttons.
 *
 * Phone: the page is the list screen; the form opens as a full-screen sheet
 * (the shared `Modal` becomes one on phones).
 */

const FLAG_LABELS: Record<string, string> = {
  "skip-permissions": "Skip permission prompts",
};

export const DEFAULT_AGENT_REASON = "A default Agent is the Core's own: it can't be changed or deleted.";
export const OFFLINE_CORE_MESSAGE =
  "This Core is offline or not answering, so its harnesses can't be checked. Try again when it is back online.";

/** What an Agent write's refusal says, in words an operator can act on. */
export function agentErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  const code = error.body && typeof error.body === "object" ? (error.body as { code?: unknown }).code : undefined;
  if (code === "core_harnesses_unavailable") return OFFLINE_CORE_MESSAGE;
  if (code === "harness_missing_on_core") {
    // "not ready yet (…), ask again shortly" is a wait; anything else is a harness the Core does not have.
    return error.message.includes("not ready yet")
      ? `${error.message}. Nothing was created.`
      : `${error.message}. Install or set it up on that Core first.`;
  }
  if (error.status === 409 && /default Agent/.test(error.message)) return DEFAULT_AGENT_REASON;
  return error.message;
}

type HarnessChoice =
  | { harness: Harness; kind: "ready" }
  | { harness: Harness; kind: "wait" | "unavailable"; why: string };

/** Sort the harnesses by what the Core reports: ready ones can be picked, the others say why not. */
export function harnessChoices(availability: CliAvailabilityMap): HarnessChoice[] {
  return HARNESSES.map((harness): HarnessChoice => {
    if (HARNESS_REGISTRY[harness].disabled) return { harness, kind: "unavailable", why: "disabled" };
    const entry = availabilityFor(availability, harness);
    switch (entry.status) {
      case "available":
        return { harness, kind: "ready" };
      case "checking":
      case "unknown":
        return { harness, kind: "wait", why: "not ready yet (checking), ask again shortly" };
      case "outdated":
        return { harness, kind: "unavailable", why: entry.version ? `outdated (${entry.version} installed)` : "outdated" };
      case "needs-setup":
        return { harness, kind: "unavailable", why: "needs setup on the Core" };
      default:
        return { harness, kind: "unavailable", why: "missing" };
    }
  });
}

export function AgentsSettingsPage() {
  const { cores, loading, error } = useFleet();
  return (
    <SettingsSection
      title="Agents"
      subtitle="A harness with a model and flags, on one Core. Tasks are sent to an Agent; the harness and the Core stay fixed once it exists."
      headingLevel="h1"
    >
      {loading && cores.length === 0 && <div role="status">Loading Cores…</div>}
      {error && cores.length === 0 && <div role="alert">{error}</div>}
      {!loading && !error && cores.length === 0 && <div>No Cores yet. Pair a Core first, then its Agents show up here.</div>}
      {cores.map((core) => (
        <CoreAgents key={core.id} core={core} />
      ))}
    </SettingsSection>
  );
}

function CoreAgents({ core }: { core: CoreWithDial }) {
  const { data: agents, isLoading, error } = useCoreAgents(core.id);
  const [form, setForm] = useState<{ mode: "create" } | { mode: "edit"; agent: AgentDto } | null>(null);
  const [deleting, setDeleting] = useState<AgentDto | null>(null);
  const online = core.dial.state === "connected";
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h2 id={headingId} style={{ margin: 0, fontSize: 15, color: "var(--text)" }}>
            {core.label}
          </h2>
          <div style={{ fontSize: 11.5, color: online ? "var(--text-dim)" : "var(--status-failed)" }}>
            {online ? "Online" : "Offline"}
          </div>
        </div>
        <Btn variant="accent" size="sm" icon="plus" onClick={() => setForm({ mode: "create" })} aria-label={`New Agent on ${core.label}`}>
          New Agent
        </Btn>
      </div>
      {!online && (
        <div role="status" style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
          {OFFLINE_CORE_MESSAGE} Existing Agents can still be edited or deleted.
        </div>
      )}
      {isLoading && <div role="status">Loading Agents…</div>}
      {error && <div role="alert">{agentErrorMessage(error)}</div>}
      {agents && agents.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No Agents on this Core yet.</div>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {agents?.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onEdit={() => setForm({ mode: "edit", agent })} onDelete={() => setDeleting(agent)} />
        ))}
      </ul>
      {form && <AgentFormDialog core={core} agent={form.mode === "edit" ? form.agent : null} onClose={() => setForm(null)} />}
      {deleting && <DeleteAgentDialog core={core} agent={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

function AgentRow({ agent, onEdit, onDelete }: { agent: AgentDto; onEdit: () => void; onDelete: () => void }) {
  const isPhone = useIsPhone();
  const harnessLabel = HARNESS_REGISTRY[agent.harness as Harness]?.label ?? agent.harness;
  return (
    <li
      style={{
        display: "flex",
        flexDirection: isPhone ? "column" : "row",
        justifyContent: "space-between",
        alignItems: isPhone ? "stretch" : "center",
        gap: 8,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-0)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, overflowWrap: "anywhere" }}>
          {agent.name}
          {agent.isDefault && <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--text-dim)" }}>default</span>}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)" }}>
          {harnessLabel} · {agent.model ?? "harness default model"}
          {agent.flags && agent.flags.length > 0 ? ` · ${agent.flags.join(", ")}` : ""}
        </div>
        {agent.isDefault && <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4 }}>{DEFAULT_AGENT_REASON}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, flex: "none" }}>
        <Btn size="sm" onClick={onEdit} disabled={agent.isDefault} title={agent.isDefault ? DEFAULT_AGENT_REASON : undefined} aria-label={`Edit ${agent.name}`}>
          Edit
        </Btn>
        <Btn size="sm" variant="danger" onClick={onDelete} disabled={agent.isDefault} title={agent.isDefault ? DEFAULT_AGENT_REASON : undefined} aria-label={`Delete ${agent.name}`}>
          Delete
        </Btn>
      </div>
    </li>
  );
}

function DeleteAgentDialog({ core, agent, onClose }: { core: CoreWithDial; agent: AgentDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCoreAgent(core.id, agent.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.coreAgents(core.id) });
      onClose();
    } catch (e) {
      setError(agentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog open onClose={onClose} onConfirm={confirm} title={`Delete ${agent.name}?`} confirmLabel="Delete" loading={busy}>
      <div>
        Tasks that name this Agent can no longer be sent to it. This cannot be undone.
        {error && (
          <div role="alert" style={{ marginTop: 8, color: "var(--status-failed)" }}>
            {error}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

const inputStyle = {
  width: "100%",
  padding: "9px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--surface-0)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
} as const;

function AgentFormDialog({ core, agent, onClose }: { core: CoreWithDial; agent: AgentDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const availability = useCliAvailability(core.id);
  const choices = harnessChoices(availability);
  const ready = choices.filter((c) => c.kind === "ready");
  const online = core.dial.state === "connected";
  const editing = agent !== null;
  const [name, setName] = useState(agent?.name ?? "");
  const [pickedHarness, setPickedHarness] = useState<Harness | null>(null);
  const harness = (editing ? (agent.harness as Harness) : (pickedHarness ?? ready[0]?.harness ?? null)) as Harness | null;
  const [model, setModel] = useState(agent?.model ?? "");
  const [flags, setFlags] = useState<string[]>(agent?.flags ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelListId = useId();
  const modelId = useId();

  const trimmedName = name.trim();
  const trimmedModel = model.trim();
  const nameInvalid = trimmedName.length === 0 || trimmedName.length > AGENT_NAME_MAX;
  const modelInvalid = trimmedModel !== "" && !AGENT_MODEL_PATTERN.test(trimmedModel);
  const canSubmit = !busy && !nameInvalid && !modelInvalid && harness !== null;
  const allowedFlags = harness ? flagsForHarness(harness) : [];

  const submit = async () => {
    if (!canSubmit || !harness) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.updateCoreAgent(core.id, agent.id, { name: trimmedName, model: trimmedModel || null, flags });
      } else {
        await api.createCoreAgent(core.id, {
          name: trimmedName,
          harness,
          ...(trimmedModel ? { model: trimmedModel } : {}),
          flags,
        });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.coreAgents(core.id) });
      onClose();
    } catch (e) {
      setError(agentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? `Edit ${agent.name}` : "New Agent";
  const label = editing ? "Save" : "Create";
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={480}
      primaryAction={{ label, onClick: () => void submit(), disabled: !canSubmit }}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="accent" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Saving…" : label}
          </Btn>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field label="Core">
          <div style={{ fontSize: 13 }}>{core.label}</div>
        </Field>
        <TextField label="Name" value={name} onChange={setName} placeholder="Reviewer" autoFocus hint={`One line, up to ${AGENT_NAME_MAX} characters. One name per Core.`} />
        {editing ? (
          <Field label="Harness">
            <div style={{ fontSize: 13 }}>
              {HARNESS_REGISTRY[harness as Harness]?.label ?? agent.harness}
              <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--text-dim)" }}>fixed once the Agent exists</span>
            </div>
          </Field>
        ) : (
          <Field label="Harness">
            {!online && (
              <div role="alert" style={{ fontSize: 12, color: "var(--status-failed)", marginBottom: 8 }}>
                {OFFLINE_CORE_MESSAGE}
              </div>
            )}
            <div role="radiogroup" aria-label="Harness" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ready.map((c) => (
                <label key={c.harness} style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 36 }}>
                  <input type="radio" name={`harness-${core.id}`} checked={harness === c.harness} onChange={() => setPickedHarness(c.harness)} />
                  {HARNESS_REGISTRY[c.harness].label}
                </label>
              ))}
            </div>
            {online && ready.length === 0 && (
              <div role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                This Core reports no harness ready yet.
              </div>
            )}
            <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, fontSize: 11.5, color: "var(--text-dim)" }}>
              {choices
                .filter((c) => c.kind !== "ready")
                .map((c) => (
                  <li key={c.harness}>
                    {HARNESS_REGISTRY[c.harness].label}: {(c as { why: string }).why}
                  </li>
                ))}
            </ul>
          </Field>
        )}
        <Field label="Model">
          <input
            id={modelId}
            aria-label="Model"
            list={modelListId}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="harness default"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={modelInvalid}
            style={inputStyle}
          />
          <datalist id={modelListId}>
            {(harness ? getAiRuntimeModelOptions(harness) : []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </datalist>
          <div style={{ fontSize: 11.5, color: modelInvalid ? "var(--status-failed)" : "var(--text-faint)", marginTop: 4 }}>
            {modelInvalid
              ? "A model id: letters, digits and . _ : / @ + -"
              : "Leave empty for the harness's own default."}
          </div>
        </Field>
        {allowedFlags.length > 0 && (
          <Field label="Flags">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {allowedFlags.map((flag) => (
                <label key={flag} style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 36 }}>
                  <input
                    type="checkbox"
                    checked={flags.includes(flag)}
                    onChange={(event) => setFlags((prev) => (event.target.checked ? [...new Set([...prev, flag])] : prev.filter((f) => f !== flag)))}
                  />
                  <span>
                    {FLAG_LABELS[flag] ?? flag} <code style={{ fontSize: 11 }}>{flag}</code>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}
        {error && (
          <div role="alert" style={{ color: "var(--status-failed)", fontSize: 12.5 }}>
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
