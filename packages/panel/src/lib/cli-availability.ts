// Per-Core CLI availability.
//
// Every Core publishes its own CLI availability map as (a) a live snapshot
// readable via the `agentsAvailabilityList` core-link frame and (b)
// `agents:availabilityChanged` events on the monotonic event log.
// `useCliAvailability(coreId)` reads from an in-memory per-Core store hydrated
// by (a) on first mount and refreshed by (b) on every change.
//
// The Panel carries no local probe: the Core that owns the machine those
// CLIs live on is the only process that can honestly answer availability for
// its Core.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getPanelBridge } from "~/lib/panel-bridge";
import { HARNESS_REGISTRY, UI_HARNESSES } from "@actana/shared/harnesses";
import type { Harness } from "@actana/shared/domain";
import {
  HARNESSES_AVAILABILITY_EVENT_KIND,
  HARNESS_INSTALL_FAILED_EVENT_KIND,
  type CoreLinkHarnessAvailability,
  type CoreLinkHarnessAvailabilityMap,
  type CoreLinkHarnessInstallFailedPayload,
} from "@actana/sdk/core-link-frames";
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

export type CliAvailabilityMap = Partial<Record<Harness, CliAvailability>>;

const UNKNOWN: CliAvailability = { status: "unknown" };
const CHECKING_SEED: CliAvailabilityMap = Object.fromEntries(
  UI_HARNESSES.map((agent) => [agent, { status: "checking" } as CliAvailability]),
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
  reconcileInstalls(coreId, next);
}

export function availabilityFor(
  availability: CliAvailabilityMap,
  agent: Harness,
): CliAvailability {
  return availability[agent] ?? UNKNOWN;
}

export function isCliUnavailable(availability: CliAvailabilityMap, agent: Harness): boolean {
  const status = availabilityFor(availability, agent).status;
  return status === "missing" || status === "outdated";
}

export function harnessCanLaunch(availability: CliAvailabilityMap, agent: Harness): boolean {
  if (HARNESS_REGISTRY[agent].disabled) return false;
  const status = availabilityFor(availability, agent).status;
  if (status === "available") return true;
  // With no link there is no Core to probe — assume launchable so the picker
  // isn't uniformly disabled on a page that hasn't connected yet.
  if (status === "unknown" && !getPanelBridge()) return true;
  return false;
}

/**
 * Convert the Core-side {@link CoreLinkHarnessAvailability} to the Panel's
 * {@link CliAvailability}. The shapes are identical apart from `unknown` (not
 * emitted by the Core — only the local dev/web fallback needs it), so this
 * is a straight structural coerce.
 */
function fromCoreLinkAvailability(entry: CoreLinkHarnessAvailability): CliAvailability {
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

function fromCoreLinkMap(map: CoreLinkHarnessAvailabilityMap): CliAvailabilityMap {
  const out: CliAvailabilityMap = {};
  for (const [agent, entry] of Object.entries(map)) {
    if (!entry) continue;
    out[agent as Harness] = fromCoreLinkAvailability(entry);
  }
  return out;
}

export function firstAvailableHarness(availability: CliAvailabilityMap): Harness | null {
  return UI_HARNESSES.find((agent) => harnessCanLaunch(availability, agent)) ?? null;
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
    .listHarnessAvailability(coreId)
    .then((map) => {
      setSnapshot(coreId, fromCoreLinkMap(map));
      store.hydrating = false;
    })
    .catch(() => {
      store.hydrating = false;
    });
}

/**
 * Follow a Core's availability and install-failure streams. Every Core's events
 * arrive on the tab's one link, tagged with their owner, so this is a filter
 * rather than a per-Core transport.
 */
function subscribeCoreHarnessEvents(coreId: string): () => void {
  const bridge = getPanelBridge();
  if (!bridge) return () => {};
  const release = bridge.watchCore(coreId);
  const off = bridge.onEvent(({ coreId: owner, event }) => {
    if (owner !== coreId) return;
    if (event.kind === HARNESSES_AVAILABILITY_EVENT_KIND) {
      try {
        const payload = JSON.parse(event.payload) as {
          availability?: CoreLinkHarnessAvailabilityMap;
        };
        if (!payload.availability) return;
        setSnapshot(coreId, fromCoreLinkMap(payload.availability));
      } catch {
        // Malformed payload — leave the current snapshot in place.
      }
      return;
    }
    if (event.kind === HARNESS_INSTALL_FAILED_EVENT_KIND) {
      try {
        const payload = JSON.parse(event.payload) as CoreLinkHarnessInstallFailedPayload;
        if (!payload?.harness) return;
        receiveInstallFailure(coreId, payload.harness as Harness, payload.message);
      } catch {
        // Malformed payload — the install stays pending until availability
        // settles it. Inventing a failure here would be worse than waiting.
      }
    }
  });
  return () => {
    off();
    release();
  };
}

/**
 * One event subscription per Core, however many hooks want it. Availability and
 * pending installs are two views of the same stream, and a component reading
 * both should not make the tab process every event twice.
 */
const subscriptions = new Map<string, { refs: number; release: () => void }>();

function retainCoreHarnessEvents(coreId: string): () => void {
  let entry = subscriptions.get(coreId);
  if (!entry) {
    entry = { refs: 0, release: subscribeCoreHarnessEvents(coreId) };
    subscriptions.set(coreId, entry);
  }
  const held = entry;
  held.refs += 1;
  return () => {
    held.refs -= 1;
    if (held.refs > 0) return;
    held.release();
    if (subscriptions.get(coreId) === held) subscriptions.delete(coreId);
  };
}

// ─── Pending installs (issue 83) ────────────────────────────────────────────
//
// Clicking Install in the picker starts something that outlives the click by
// minutes, the dialog by a close-and-reopen, and the component by a remount —
// so the state lives here, beside the availability stores and keyed the same
// way, rather than in React.
//
// `installing` spans the whole lifecycle: from the click until the Harness is
// actually available on that Core. The Core's re-probe legitimately puts a
// Harness through `checking` on the way and an ordinary refresh republishes an
// unchanged `missing` — neither is an outcome, and neither may clear or flicker
// the state. Exactly two things end it:
//
//   • availability for that Harness flips to `available` — it worked; or
//   • the Core publishes a definitive failure — back to plain `missing`, with
//     the Core's message, ready to retry.
//
// A failure message is never written into the availability map. An availability
// entry is a fact about PATH that the next probe overwrites; an error cached
// there would outlive its own truth and disable the Harness permanently, which
// is the one outcome this feature must not produce.

/** What the picker renders for one Harness's install, if anything is going on. */
export type HarnessInstallState = {
  /** An install is in flight for this Harness on this Core. */
  installing: boolean;
  /** The Core's operator-facing reason the last attempt failed. */
  error?: string;
};

export type HarnessInstallMap = Partial<Record<Harness, HarnessInstallState>>;

type InstallStore = {
  snapshot: HarnessInstallMap;
  subscribe: (listener: () => void) => () => void;
  emit: () => void;
};

const installStores = new Map<string, InstallStore>();
const EMPTY_INSTALLS: HarnessInstallMap = {};

function getInstallStore(coreId: string): InstallStore {
  let store = installStores.get(coreId);
  if (!store) {
    const listeners = createListenerSet();
    store = { snapshot: EMPTY_INSTALLS, subscribe: listeners.subscribe, emit: listeners.notify };
    installStores.set(coreId, store);
  }
  return store;
}

function setInstallState(
  coreId: string,
  agent: Harness,
  next: HarnessInstallState | null,
): void {
  const store = getInstallStore(coreId);
  const current = store.snapshot[agent];
  if (!next && !current) return;
  if (
    next &&
    current &&
    current.installing === next.installing &&
    current.error === next.error
  ) {
    return;
  }
  const snapshot: HarnessInstallMap = { ...store.snapshot };
  if (next) snapshot[agent] = next;
  else delete snapshot[agent];
  store.snapshot = snapshot;
  store.emit();
}

/**
 * Fold a fresh availability snapshot into the pending-install state.
 *
 * `available` is the success verdict, and it is the only status that ends an
 * install here. Every other status — `checking` during the post-install
 * re-probe, an unchanged `missing`, the `unknown` of a link that just came
 * back — is the install still running.
 *
 * Stale errors are dropped on the way through: a failure message the operator
 * has already been shown must not ride along into the next snapshot for that
 * Harness, or a Harness that is fine reads as broken.
 */
function reconcileInstalls(coreId: string, availability: CliAvailabilityMap): void {
  const store = installStores.get(coreId);
  if (!store) return;
  for (const [key, state] of Object.entries(store.snapshot)) {
    const agent = key as Harness;
    if (!state) continue;
    const status = availability[agent]?.status;
    if (!status) continue;
    // `outdated` ends it too, for the same reason `available` does: the CLI is
    // on PATH now, so the install is over and the update-required flow — which
    // this feature does not touch — owns the row from here. Leaving it
    // installing would be the one thing this state must never be: stuck.
    if (status === "available" || status === "outdated") {
      setInstallState(coreId, agent, null);
      continue;
    }
    if (state.error) {
      setInstallState(coreId, agent, state.installing ? { installing: true } : null);
    }
  }
}

/** A definitive failure from the Core: stop installing, show why, allow a retry. */
function failInstall(coreId: string, agent: Harness, message?: string): void {
  setInstallState(coreId, agent, {
    installing: false,
    error: message || "The install failed on this Core.",
  });
}

/**
 * A failure event, answered only if this Panel is still waiting on that install.
 *
 * The event log replays: a tab that opens later is served the recent tail from
 * its cursor, so an install that failed before this tab existed arrives here
 * looking brand new. Painting its message would put a red line on a row nobody
 * clicked, for an attempt this operator may already have retried by hand — and
 * on a Harness that stays missing, no later availability change would come
 * along to clear it. An outcome nobody is waiting for is history, not news.
 */
function receiveInstallFailure(coreId: string, agent: Harness, message?: string): void {
  if (!installStores.get(coreId)?.snapshot[agent]?.installing) return;
  failInstall(coreId, agent, message);
}

/**
 * Ask a Core to install a Harness, and mark it installing until it is actually
 * available (or definitively failed).
 *
 * The request's promise settles on the Core's ack — that it started — and
 * nothing about the outcome is read from it. A refusal or a link failure ends
 * the attempt right there; anything else hands the row over to the event
 * stream, which is what survives a reload, a reconnect, and a second tab.
 */
export function requestHarnessInstall(coreId: string, agent: Harness): void {
  const bridge = getPanelBridge();
  if (!bridge) return;
  if (getInstallStore(coreId).snapshot[agent]?.installing) return;
  setInstallState(coreId, agent, { installing: true });
  bridge
    .installHarness(coreId, agent)
    .then((ack) => {
      if (ack.accepted) return;
      failInstall(coreId, agent, ack.message);
    })
    .catch((err: unknown) => {
      // The link dropped, or the Core refused the frame. Not a verdict on the
      // Harness — the row goes back to plain `missing` and can be clicked again.
      failInstall(coreId, agent, err instanceof Error ? err.message : undefined);
    });
}

/**
 * Per-Core pending-install hook. Returns what is installing (and what last
 * failed) for that Core, plus the way to start one. Reads the same event stream
 * {@link useCliAvailability} does, so a row watching both sees one consistent
 * answer.
 */
export function useHarnessInstall(coreId: string | null): {
  installs: HarnessInstallMap;
  install: (agent: Harness) => void;
} {
  const bridge = getPanelBridge();
  const store = bridge && coreId ? getInstallStore(coreId) : null;

  useEffect(() => {
    if (!bridge || !coreId) return;
    hydrateOnce(coreId);
    return retainCoreHarnessEvents(coreId);
  }, [bridge, coreId]);

  const installs = useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    store ? () => store.snapshot : getEmptyInstalls,
    store ? () => store.snapshot : getEmptyInstalls,
  );

  const install = useCallback(
    (agent: Harness) => {
      if (!coreId) return;
      requestHarnessInstall(coreId, agent);
    },
    [coreId],
  );

  return { installs, install };
}

export function installStateFor(installs: HarnessInstallMap, agent: Harness): HarnessInstallState {
  return installs[agent] ?? NOT_INSTALLING;
}

const NOT_INSTALLING: HarnessInstallState = { installing: false };

function getEmptyInstalls(): HarnessInstallMap {
  return EMPTY_INSTALLS;
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
    return retainCoreHarnessEvents(coreId);
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
  installStores.clear();
  for (const entry of subscriptions.values()) entry.release();
  subscriptions.clear();
}

/**
 * Force-load a Core's availability snapshot outside a React render — used by
 * imperative flows (e.g. a menu action that wants to inspect current
 * availability before opening a picker). No-op without a live panel link.
 */
export function ensureCliAvailability(coreId: string): void {
  hydrateOnce(coreId);
}
