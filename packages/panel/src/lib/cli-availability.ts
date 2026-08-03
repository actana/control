// Per-Core CLI availability.
//
// Every Core publishes its own CLI availability map as (a) a live snapshot
// readable via the `agentsAvailabilityList` core-link frame and (b)
// `agents:availabilityChanged` events on the monotonic event log.
// `useCliAvailability(coreId)` reads from an in-memory per-Core store hydrated
// by (a) on first mount and refreshed by (b) on every change.
//
// The Panel carries no local probe: the Harness that owns the machine those
// CLIs live on is the only process that can honestly answer availability for
// its Core.

import { useEffect, useSyncExternalStore } from "react";
import { getPanelBridge } from "~/lib/panel-bridge";
import { AGENT_REGISTRY, UI_AGENTS } from "@actana/shared/agents";
import type { TaskAgent } from "@actana/shared/domain";
import {
  AGENTS_AVAILABILITY_EVENT_KIND,
  type CoreLinkAgentAvailability,
  type CoreLinkAgentAvailabilityMap,
} from "@actana/shared/core-link-frames";
import { createListenerSet } from "./listener-set";

export type CliAvailabilityStatus = "unknown" | "checking" | "available" | "missing" | "outdated";

export type CliAvailability = {
  status: CliAvailabilityStatus;
  path?: string;
  reason?: string;
  label?: string;
  version?: string;
  requiredVersion?: string;
  packageUrl?: string;
  updateCommands?: readonly string[];
};

export type CliAvailabilityMap = Partial<Record<TaskAgent, CliAvailability>>;

const UNKNOWN: CliAvailability = { status: "unknown" };
const CHECKING_SEED: CliAvailabilityMap = Object.fromEntries(
  UI_AGENTS.map((agent) => [agent, { status: "checking" } as CliAvailability]),
) as CliAvailabilityMap;

/**
 * Per-Core availability snapshot store. Each Core gets its own listener set
 * and its own map so `useCliAvailability(coreId)` re-renders only when THAT
 * Core's availability changes. A Core with no snapshot yet returns the shared
 * `CHECKING_SEED` (all agents in `checking`) — matches the pre-11 boot flow.
 */
type CoreStore = {
  snapshot: CliAvailabilityMap;
  subscribe: (listener: () => void) => () => void;
  emit: () => void;
  hydrating: boolean;
};

const stores = new Map<string, CoreStore>();
/** What a caller with no Core (or no link yet) reads. */
const EMPTY_SNAPSHOT: CliAvailabilityMap = {};

function getStore(coreId: string): CoreStore {
  let store = stores.get(coreId);
  if (!store) {
    const listeners = createListenerSet();
    store = {
      snapshot: CHECKING_SEED,
      subscribe: listeners.subscribe,
      emit: listeners.notify,
      hydrating: false,
    };
    stores.set(coreId, store);
  }
  return store;
}

function setSnapshot(coreId: string, next: CliAvailabilityMap): void {
  const store = getStore(coreId);
  store.snapshot = next;
  store.emit();
}

export function availabilityFor(
  availability: CliAvailabilityMap,
  agent: TaskAgent,
): CliAvailability {
  return availability[agent] ?? UNKNOWN;
}

export function isCliUnavailable(availability: CliAvailabilityMap, agent: TaskAgent): boolean {
  const status = availabilityFor(availability, agent).status;
  return status === "missing" || status === "outdated";
}

export function agentCanLaunch(availability: CliAvailabilityMap, agent: TaskAgent): boolean {
  if (AGENT_REGISTRY[agent].disabled) return false;
  const status = availabilityFor(availability, agent).status;
  if (status === "available") return true;
  // With no link there is no Harness to probe — assume launchable so the picker
  // isn't uniformly disabled on a page that hasn't connected yet.
  if (status === "unknown" && !getPanelBridge()) return true;
  return false;
}

/**
 * Convert the Harness-side {@link CoreLinkAgentAvailability} to the Panel's
 * {@link CliAvailability}. The shapes are identical apart from `unknown` (not
 * emitted by the Harness — only the local dev/web fallback needs it), so this
 * is a straight structural coerce.
 */
function fromCoreLinkAvailability(entry: CoreLinkAgentAvailability): CliAvailability {
  const next: CliAvailability = { status: entry.status };
  if (entry.path !== undefined) next.path = entry.path;
  if (entry.reason !== undefined) next.reason = entry.reason;
  if (entry.label !== undefined) next.label = entry.label;
  if (entry.version !== undefined) next.version = entry.version;
  if (entry.requiredVersion !== undefined) next.requiredVersion = entry.requiredVersion;
  if (entry.packageUrl !== undefined) next.packageUrl = entry.packageUrl;
  if (entry.updateCommands !== undefined) next.updateCommands = entry.updateCommands;
  return next;
}

function fromCoreLinkMap(map: CoreLinkAgentAvailabilityMap): CliAvailabilityMap {
  const out: CliAvailabilityMap = {};
  for (const [agent, entry] of Object.entries(map)) {
    if (!entry) continue;
    out[agent as TaskAgent] = fromCoreLinkAvailability(entry);
  }
  return out;
}

export function firstAvailableAgent(availability: CliAvailabilityMap): TaskAgent | null {
  return UI_AGENTS.find((agent) => agentCanLaunch(availability, agent)) ?? null;
}

/**
 * Hydrate a Core's availability snapshot once over the panel link. Idempotent
 * — a second call while the first is in flight is a no-op. A failure leaves the
 * "checking" seed in place; the next `agents:availabilityChanged` event, or a
 * remount on a healthy link, recovers.
 */
function hydrateOnce(coreId: string): void {
  const store = getStore(coreId);
  if (store.hydrating) return;
  const bridge = getPanelBridge();
  if (!bridge) return;
  store.hydrating = true;
  bridge
    .listAgentAvailability(coreId)
    .then((map) => {
      setSnapshot(coreId, fromCoreLinkMap(map));
      store.hydrating = false;
    })
    .catch(() => {
      store.hydrating = false;
    });
}

/**
 * Follow a Core's `agents:availabilityChanged` stream. Every Core's events
 * arrive on the tab's one link, tagged with their owner, so this is a filter
 * rather than a per-Core transport.
 */
function subscribeAvailabilityEvents(coreId: string): () => void {
  const bridge = getPanelBridge();
  if (!bridge) return () => {};
  const release = bridge.watchCore(coreId);
  const off = bridge.onEvent(({ coreId: owner, event }) => {
    if (owner !== coreId || event.kind !== AGENTS_AVAILABILITY_EVENT_KIND) return;
    try {
      const payload = JSON.parse(event.payload) as {
        availability?: CoreLinkAgentAvailabilityMap;
      };
      if (!payload.availability) return;
      setSnapshot(coreId, fromCoreLinkMap(payload.availability));
    } catch {
      // Malformed payload — leave the current snapshot in place.
    }
  });
  return () => {
    off();
    release();
  };
}

/**
 * Per-Core availability hook. A Core id is required: with no Core
 * gone there is no "the local machine" to default to, and a caller that does
 * not know whose CLIs it is asking about is asking the wrong question.
 */
export function useCliAvailability(coreId: string | null): CliAvailabilityMap {
  const bridge = getPanelBridge();
  const store = bridge && coreId ? getStore(coreId) : null;

  useEffect(() => {
    if (!bridge || !coreId) return;
    hydrateOnce(coreId);
    return subscribeAvailabilityEvents(coreId);
  }, [bridge, coreId]);

  const snapshot = useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    store ? () => store.snapshot : getEmptySnapshot,
    store ? () => store.snapshot : getEmptySnapshot,
  );
  return snapshot;
}

function subscribeNoop(): () => void {
  return () => {};
}

function getEmptySnapshot(): CliAvailabilityMap {
  return EMPTY_SNAPSHOT;
}

/**
 * Testing seam — reset every Core store. Not used at runtime.
 * @internal
 */
export function __resetCliAvailabilityStoresForTests(): void {
  stores.clear();
}

/**
 * Force-load a Core's availability snapshot outside a React render — used by
 * imperative flows (e.g. a menu action that wants to inspect current
 * availability before opening a picker). No-op without a live panel link.
 */
export function ensureCliAvailability(coreId: string): void {
  hydrateOnce(coreId);
}
