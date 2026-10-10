import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import { needsSetupDialog } from "@actana/shared/harness-needs-setup";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { findCoreById } from "../repositories/cores.repo";
import {
  deleteAgent as deleteAgentRow,
  findAgentById,
  findAgents,
  findDefaultAgent,
  insertAgent,
  type AgentRow,
} from "../repositories/agents.repo";
import {
  AGENT_MODEL_PATTERN,
  AGENT_NAME_MAX,
  HARNESSES,
  flagsForHarness,
  isAgentFlag,
  isHarness,
  type Harness,
} from "~/shared/agents";
import { newId } from "./_ids";
import { coreLinkManager } from "./core-link-manager";
import { PI_PROVIDER_API_KEY_ENVS } from "./harness-accounts";

/**
 * Agents (#569): a named harness plus its settings on one Core. Every call takes
 * the owner first and every read and write is scoped to it (ADR 0041 D15): an
 * Agent of another owner is "not found", never "forbidden".
 *
 * An Agent carries a harness id, a model name and flags from a closed set, and
 * nothing else. Anything outside that is refused before it is stored, so there
 * is no field a user-typed command, an argument list, a script or an environment
 * could ride in on, and no field a platform model key could ride in on.
 *
 * Which harnesses a Core has comes from the Core, through the Panel's existing
 * core-link client (`agentsAvailabilityList`), at the moment it is asked.
 */

export type Agent = AgentRow;

/** An Agent as dispatch will launch it (#570): the harness the Core has, and the settings, and nothing else. */
export type ResolvedAgent = {
  agentId: string;
  coreId: string;
  harness: Harness;
  model: string | null;
  flags: string[];
};

/** The Core could not be asked which harnesses it has: no link, or no answer. Nothing was written. */
export class CoreHarnessesUnavailableError extends ConflictError {
  readonly code = "core_harnesses_unavailable";
  constructor(readonly coreId: string) {
    super("this Core cannot be asked which harnesses it has right now");
    this.name = "CoreHarnessesUnavailableError";
  }
}

/** The Core does not report this harness as available, so no Agent may run on it. `detail` says why, when known. */
export class HarnessMissingOnCoreError extends ConflictError {
  readonly code = "harness_missing_on_core";
  constructor(
    readonly coreId: string,
    readonly harness: string,
    readonly detail?: string,
  ) {
    super(`this Core does not have ${harness} available${detail ? `: ${detail}` : ""}`);
    this.name = "HarnessMissingOnCoreError";
  }
}

/**
 * The harness is still being checked, or its last probe failed in a way that may
 * pass on the next one (#706). Not a verdict: a caller may wait and ask again.
 */
export class HarnessNotReadyError extends ConflictError {
  readonly code = "harness_not_ready";
  constructor(
    readonly coreId: string,
    readonly harness: string,
    readonly state: string,
  ) {
    super(`${harness} on this Core is not ready yet (${state})`);
    this.name = "HarnessNotReadyError";
  }
}

export type HarnessReadiness =
  | { kind: "ready" }
  | { kind: "wait"; state: string }
  | { kind: "unavailable"; detail: string };

/**
 * Sort one availability entry into ready, "wait and ask again" (still checking,
 * or a probe that failed or timed out) or "will not run" with the reason (#706).
 */
export function harnessReadiness(entry: CoreLinkHarnessAvailabilityMap[string] | undefined): HarnessReadiness {
  if (!entry) return { kind: "unavailable", detail: "not reported" };
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  switch (entry.status) {
    case "available":
      return { kind: "ready" };
    case "checking":
      return { kind: "wait", state: "checking" };
    case "outdated": {
      if (reason === "version-check-failed") return { kind: "wait", state: "version check failed" };
      const detail = entry.version
        ? entry.requiredVersion
          ? `outdated: ${entry.version} installed, ${entry.requiredVersion} or newer required`
          : `outdated: ${entry.version} installed`
        : entry.requiredVersion
          ? `outdated: ${entry.requiredVersion} or newer required`
          : reason && reason !== "outdated"
            ? `outdated (${reason})`
            : "outdated";
      return { kind: "unavailable", detail };
    }
    case "missing": {
      const dialog = needsSetupDialog(entry.reason);
      if (dialog !== null) return { kind: "unavailable", detail: `needs setup: ${dialog}` };
      if (!reason) return { kind: "unavailable", detail: "missing" };
      if (reason === "not-found" || reason === "disabled") return { kind: "unavailable", detail: `missing (${reason})` };
      // Any other reason is the text of a probe that threw or timed out: it may pass next time.
      return { kind: "wait", state: `probe failed: ${reason}` };
    }
    default:
      return { kind: "unavailable", detail: `unknown status ${String(entry.status)}` };
  }
}

export type NewAgent = {
  coreId: string;
  name: string;
  harness: Harness;
  model?: string | null;
  flags?: readonly string[];
};

/** How the service asks a Core what it has. A test hands in a fake list. */
export type AgentDeps = {
  harnesses?: (coreId: string) => Promise<CoreLinkHarnessAvailabilityMap>;
};

async function askCore(coreId: string): Promise<CoreLinkHarnessAvailabilityMap> {
  const client = coreLinkManager().client(coreId);
  if (!client) throw new Error("no core-link to this Core");
  const answer = await client.request({ type: "agentsAvailabilityList", reqId: "" });
  if (answer.type !== "agentsAvailabilityListResult") throw new Error(`unexpected answer: ${answer.type}`);
  return answer.availability;
}

async function reportedHarnesses(coreId: string, deps: AgentDeps): Promise<CoreLinkHarnessAvailabilityMap> {
  try {
    return await (deps.harnesses ?? askCore)(coreId);
  } catch {
    throw new CoreHarnessesUnavailableError(coreId);
  }
}

/**
 * Only `available` can run an Agent or Task. This is deliberately stricter than
 * the Panel's `harnessCanLaunch`: a needs-setup Harness can open an interactive
 * Session, but a Task cannot finish an interactive setup.
 */
function hasHarness(map: CoreLinkHarnessAvailabilityMap, harness: string): boolean {
  return map[harness]?.status === "available";
}

const ALLOWED_FIELDS = ["coreId", "name", "harness", "model", "flags"];

/** Values that look like a provider key, for a key the Panel does not hold itself. */
const KEY_SHAPE =
  /^(sk-|sk_|xai-|gsk_|AIza|ghp_|gho_|ghu_|ghs_|github_pat_|hf_|AKIA|ASIA|pplx-|r8_|nvapi-)|\beyJ[A-Za-z0-9_-]{20,}\./;

/** The values of the provider keys in the Panel's own environment, which no Agent may carry. */
function platformKeyValues(): string[] {
  return PI_PROVIDER_API_KEY_ENVS.map((name) => process.env[name]?.trim() ?? "").filter((v) => v.length >= 8);
}

function refusePlatformKey(field: string, value: string): void {
  if (KEY_SHAPE.test(value) || platformKeyValues().some((key) => value.includes(key))) {
    throw new ValidationError(`an Agent's ${field} cannot be a platform key`);
  }
}

function cleanNewAgent(input: NewAgent): { name: string; harness: Harness; model: string | null; flags: string[] } {
  const extra = Object.keys(input).filter((k) => !ALLOWED_FIELDS.includes(k));
  if (extra.length) throw new ValidationError(`unknown field on an Agent: ${extra.join(", ")}`);
  if (!isHarness(input.harness)) throw new ValidationError(`unknown harness: ${String(input.harness)}`);
  const harness = input.harness;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ValidationError("an Agent needs a name");
  if (name.length > AGENT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ValidationError(`an Agent's name is one line of at most ${AGENT_NAME_MAX} characters`);
  }
  refusePlatformKey("name", name);
  const model = typeof input.model === "string" ? input.model.trim() || null : null;
  if (input.model != null && typeof input.model !== "string") throw new ValidationError("an Agent's model is a name");
  if (model !== null) {
    refusePlatformKey("model", model);
    if (!AGENT_MODEL_PATTERN.test(model)) {
      throw new ValidationError("an Agent's model is a model id: letters, digits and . _ : / @ + -");
    }
  }
  const allowed = flagsForHarness(harness);
  const flags = [...new Set(input.flags ?? [])].sort();
  for (const flag of flags) {
    if (!isAgentFlag(flag)) throw new ValidationError(`unknown flag: ${String(flag)}`);
    if (!allowed.includes(flag)) throw new ValidationError(`${harness} has no ${flag} flag`);
  }
  return { name, harness, model, flags };
}

function row(ownerId: number, coreId: string, fields: ReturnType<typeof cleanNewAgent>, isDefault: boolean, now: number): AgentRow {
  return { id: newId("agent"), ownerId, coreId, ...fields, isDefault, createdAt: now, updatedAt: now };
}

export async function createAgent(ownerId: number, input: NewAgent, deps: AgentDeps = {}, now = Date.now()): Promise<Agent> {
  const fields = cleanNewAgent(input);
  const coreId = String(input.coreId ?? "");
  if (!(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
  if (!hasHarness(await reportedHarnesses(coreId, deps), fields.harness)) {
    throw new HarnessMissingOnCoreError(coreId, fields.harness);
  }
  const result = await insertAgent(row(ownerId, coreId, fields, false, now));
  if (result.kind === "no-core") throw new NotFoundError("core not found");
  if (result.kind === "conflict") throw new ConflictError(`this Core already has an Agent named ${fields.name}`);
  return result.agent;
}

export async function listAgents(ownerId: number, coreId?: string): Promise<Agent[]> {
  return findAgents(ownerId, coreId);
}

export async function getAgent(ownerId: number, id: string): Promise<Agent> {
  const agent = await findAgentById(ownerId, id);
  if (!agent) throw new NotFoundError("agent not found");
  return agent;
}

/** A default Agent is the Core's own, so it stays; any other Agent can go. */
export async function deleteAgent(ownerId: number, id: string): Promise<void> {
  const agent = await getAgent(ownerId, id);
  if (agent.isDefault) throw new ConflictError("a default Agent cannot be deleted");
  if (!(await deleteAgentRow(ownerId, id))) throw new NotFoundError("agent not found");
}

/**
 * Resolve an Agent to the harness its Core has right now. The Core's report is
 * asked for again each time, because a harness that was there yesterday may be
 * missing today.
 */
export async function resolveAgent(ownerId: number, id: string, deps: AgentDeps = {}): Promise<ResolvedAgent> {
  const agent = await getAgent(ownerId, id);
  const readiness = harnessReadiness((await reportedHarnesses(agent.coreId, deps))[agent.harness]);
  if (readiness.kind === "wait") throw new HarnessNotReadyError(agent.coreId, agent.harness, readiness.state);
  if (readiness.kind === "unavailable") throw new HarnessMissingOnCoreError(agent.coreId, agent.harness, readiness.detail);
  return {
    agentId: agent.id,
    coreId: agent.coreId,
    harness: agent.harness as Harness,
    model: agent.model,
    flags: [...agent.flags],
  };
}

/**
 * Give every harness the Core reports as available a default Agent, and leave
 * the ones it already has. Safe to call again and to call twice at once: the
 * database allows one default per harness per Core. Returns the Core's default
 * Agents, one per available harness.
 */
export async function ensureDefaultAgents(ownerId: number, coreId: string, deps: AgentDeps = {}, now = Date.now()): Promise<Agent[]> {
  if (!(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
  return ensureDefaultsFor(ownerId, coreId, await reportedHarnesses(coreId, deps), now);
}

async function ensureDefaultsFor(ownerId: number, coreId: string, reported: CoreLinkHarnessAvailabilityMap, now: number): Promise<Agent[]> {
  const out: Agent[] = [];
  for (const harness of HARNESSES) {
    if (!hasHarness(reported, harness)) continue;
    out.push(await ensureDefault(ownerId, coreId, harness, now));
  }
  return out;
}

async function ensureDefault(ownerId: number, coreId: string, harness: Harness, now: number): Promise<Agent> {
  const existing = await findDefaultAgent(ownerId, coreId, harness);
  if (existing) return existing;
  const label = HARNESS_REGISTRY[harness].label;
  // An operator may already have an Agent called "Claude Code": take the next free name.
  for (const name of [label, `${label} (default)`]) {
    const result = await insertAgent(row(ownerId, coreId, { name, harness, model: null, flags: [] }, true, now));
    if (result.kind === "ok") return result.agent;
    if (result.kind === "no-core") throw new NotFoundError("core not found");
    // A concurrent call may have made the default: that is the one to return.
    const raced = await findDefaultAgent(ownerId, coreId, harness);
    if (raced) return raced;
  }
  throw new ConflictError(`could not make a default Agent for ${harness}`);
}

/**
 * One Core's Agents, with a default Agent for each harness it has. With
 * `runnableOnly` (the New Task picker) an Agent whose harness the Core does not
 * report available now is left out: hidden, not deleted, and back when the
 * harness is. Without it every Agent is listed, because a Task's Agent must keep
 * its name when its harness goes. A Core that cannot be asked keeps the Agents
 * it already has.
 */
export async function listAgentsForCore(
  ownerId: number,
  coreId: string,
  deps: AgentDeps = {},
  { runnableOnly = false }: { runnableOnly?: boolean } = {},
): Promise<Agent[]> {
  let reported: CoreLinkHarnessAvailabilityMap;
  try {
    if (!(await findCoreById(ownerId, coreId))) throw new NotFoundError("core not found");
    reported = await reportedHarnesses(coreId, deps);
  } catch (err) {
    if (!(err instanceof CoreHarnessesUnavailableError)) throw err;
    return findAgents(ownerId, coreId);
  }
  await ensureDefaultsFor(ownerId, coreId, reported, Date.now());
  const all = await findAgents(ownerId, coreId);
  return runnableOnly ? all.filter((a) => hasHarness(reported, a.harness)) : all;
}
