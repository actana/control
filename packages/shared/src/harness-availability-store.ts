// Core-side CLI availability probe (issue 11).
//
// Runs inside the Core process — the same code path that used to answer the
// The Panel's boot-time CLI probe now lives here, on the Core that
// owns the machine those CLIs are installed on. Every Core probes its own
// PATH and publishes the resulting `{harnessId → {status, version?, ...}}` map
// two ways:
//
//   • Snapshot: readable at any time via {@link HarnessAvailabilityStore.snapshot}
//     — the `agentsAvailabilityList` core-link frame serves this to fresh
//     Panels so they hydrate without waiting for the next probe tick.
//   • Change stream: whenever the probe returns a map that differs from the
//     previous one, the store appends an `agents:availabilityChanged` event to
//     the monotonic event log via the injected `appendEvent` callback. The
//     event's payload IS the full map (not a diff) so a Panel replaying only
//     the tail lands on the latest state without stitching.
//
// The probe recomputes on Core startup and on a periodic tick (60s). No
// filesystem watch — a periodic re-probe covers "user installed the CLI in
// another terminal" within a window comparable to the local IPC probe's own
// staleness (which never re-ran until the app was reloaded).

import * as os from "node:os";
import log from "./log";
import { HARNESS_REGISTRY, UI_HARNESSES } from "./harnesses";
import {
  HARNESS_CLI_CONFIG_BY_COMMAND,
  resolveHarnessCliUpdateCommands,
} from "./harness-cli-config";
import type { Harness } from "./domain";
import {
  HARNESSES_AVAILABILITY_EVENT_KIND,
  type CoreLinkHarnessAvailability,
  type CoreLinkHarnessAvailabilityMap,
} from "@actana/sdk/core-link-frames";
import {
  resolveHarnessCommandMeetingVersion,
  resolveHarnessCommandOnPath,
} from "./harness-cli-resolution";
import { sanitizedProcessEnv } from "./shell-env";

/** How often the Core re-probes for changes. Explicit so tests can override. */
export const DEFAULT_AVAILABILITY_TICK_MS = 60_000;

export type HarnessAvailabilityStoreOptions = {
  /**
   * Append a domain event to the monotonic event log. The store calls this
   * whenever the probe returns a map that differs from the previous one — the
   * `agents:availabilityChanged` event carries the full serialized map so a
   * reconnecting Panel catches up through the standard replay path.
   */
  appendEvent: (
    kind: string,
    payload: string,
    opts?: { ptyId?: string | null; taskId?: string | null },
  ) => number;
  /** Override the probe tick for tests. Default {@link DEFAULT_AVAILABILITY_TICK_MS}. */
  tickMs?: number;
  /** Injectable probe for tests. Default runs the real PATH resolution. */
  probe?: (agent: Harness) => CoreLinkHarnessAvailability;
};

export class HarnessAvailabilityStore {
  private readonly appendEvent: HarnessAvailabilityStoreOptions["appendEvent"];
  private readonly tickMs: number;
  private readonly probe: (agent: Harness) => CoreLinkHarnessAvailability;
  private current: CoreLinkHarnessAvailabilityMap;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HarnessAvailabilityStoreOptions) {
    this.appendEvent = opts.appendEvent;
    this.tickMs = opts.tickMs ?? DEFAULT_AVAILABILITY_TICK_MS;
    this.probe = opts.probe ?? defaultProbe;
    // Start every agent as `checking` so the Panel has a stable initial
    // rendering (matches the pre-issue-11 boot flow where the store seeds
    // "checking" before the first probe completes).
    this.current = Object.fromEntries(
      UI_HARNESSES.map((agent) => [agent, { status: "checking" }]),
    ) as CoreLinkHarnessAvailabilityMap;
  }

  /** Current snapshot for the `agentsAvailabilityList` request frame. */
  snapshot(): CoreLinkHarnessAvailabilityMap {
    return this.current;
  }

  /**
   * Kick off the first probe and start the periodic re-probe timer. Idempotent
   * — a second call is a no-op. Call once during Core startup, after the
   * event-log store is configured (the first probe emits an event).
   */
  start(): void {
    if (this.timer) return;
    this.runProbe();
    this.timer = setInterval(() => this.runProbe(), this.tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the probe timer (shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Re-probe every managed agent, compare against the cached map, and append
   * an `agents:availabilityChanged` event if anything changed. Public for
   * tests + for the "recheck on demand" surface the Providers page might add
   * later — no caller needs it today.
   */
  runProbe(): void {
    const next: CoreLinkHarnessAvailabilityMap = {};
    for (const agent of UI_HARNESSES) {
      if (HARNESS_REGISTRY[agent].disabled) {
        next[agent] = { status: "missing", reason: "disabled" };
        continue;
      }
      try {
        next[agent] = this.probe(agent);
      } catch (err) {
        next[agent] = {
          status: "missing",
          reason: err instanceof Error ? err.message : "probe-failed",
        };
      }
    }
    if (mapsEqual(this.current, next)) return;
    this.current = next;
    try {
      this.appendEvent(
        HARNESSES_AVAILABILITY_EVENT_KIND,
        JSON.stringify({ availability: next }),
        { ptyId: null, taskId: null },
      );
    } catch (err) {
      log.warn("core-availability.append-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Default probe — PATH resolution plus a version check. Runs in the Core
 * process, so `sanitizedProcessEnv` +
 * `resolveHarnessCommandMeetingVersion` are directly available.
 */
function defaultProbe(agent: Harness): CoreLinkHarnessAvailability {
  const command = HARNESS_REGISTRY[agent].command;
  const env = sanitizedProcessEnv();
  const requirement = HARNESS_CLI_CONFIG_BY_COMMAND[command];
  const platform = os.platform();

  if (!requirement) {
    // No version requirement registered — fall back to a plain PATH lookup.
    const resolved = resolveHarnessCommandOnPath(command, env, platform);
    return resolved
      ? { status: "available", path: resolved }
      : { status: "missing", reason: "not-found" };
  }

  const meeting = resolveHarnessCommandMeetingVersion(command, requirement, env, platform);
  if (!meeting) {
    return { status: "missing", reason: "not-found" };
  }
  const { binary, check } = meeting;
  const updateCommands = resolveHarnessCliUpdateCommands(requirement.updateCommands, platform);
  if (check.ok) {
    return {
      status: "available",
      path: binary,
      label: requirement.label,
      version: check.version ?? undefined,
      requiredVersion: requirement.minimumVersion,
      packageUrl: requirement.packageUrl,
      updateCommands,
    };
  }
  // A resolvable binary whose version couldn't be verified or is below the
  // minimum — surface as `outdated` so the Panel's update-required dialog
  // fires and the Providers page can guide the user to fix it.
  const outdated: CoreLinkHarnessAvailability = {
    status: "outdated",
    reason: check.reason,
    path: binary,
    label: requirement.label,
    requiredVersion: requirement.minimumVersion,
    packageUrl: requirement.packageUrl,
    updateCommands,
  };
  if (check.version) outdated.version = check.version;
  return outdated;
}

/**
 * Structural equality for two availability maps — the store only emits an
 * event when the map actually changes, so we don't spam the event log every
 * 60s with identical entries.
 */
function mapsEqual(
  a: CoreLinkHarnessAvailabilityMap,
  b: CoreLinkHarnessAvailabilityMap,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!entriesEqual(a[key], b[key])) return false;
  }
  return true;
}

function entriesEqual(
  a: CoreLinkHarnessAvailability | undefined,
  b: CoreLinkHarnessAvailability | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.status !== b.status) return false;
  if (a.path !== b.path) return false;
  if (a.reason !== b.reason) return false;
  if (a.label !== b.label) return false;
  if (a.version !== b.version) return false;
  if (a.requiredVersion !== b.requiredVersion) return false;
  if (a.packageUrl !== b.packageUrl) return false;
  const aCmds = a.updateCommands ?? [];
  const bCmds = b.updateCommands ?? [];
  if (aCmds.length !== bCmds.length) return false;
  for (let i = 0; i < aCmds.length; i++) {
    if (aCmds[i] !== bCmds[i]) return false;
  }
  return true;
}
