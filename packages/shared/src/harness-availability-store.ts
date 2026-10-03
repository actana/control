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
} from "./sdk-link-frames";
import {
  pickHarnessCandidateMeetingVersion,
  resolveAllHarnessCommandsOnPath,
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
    opts?: { ptyId?: string | null; sessionId?: string | null },
  ) => number;
  /** Override the probe tick for tests. Default {@link DEFAULT_AVAILABILITY_TICK_MS}. */
  tickMs?: number;
  /** Injectable probe for tests. Default runs the real PATH resolution. */
  probe?: (agent: Harness) => CoreLinkHarnessAvailability;
  /**
   * An asynchronous probe, for a Core whose daemon cannot look into the home the
   * Harness CLIs live in (the container: the daemon is `actana`, the home is
   * `core`'s and 0750). When set it replaces `probe` for {@link refresh}, which
   * is what the tick, SIGHUP and the install service use; {@link runProbe} stays
   * the synchronous one-shot the CLI and the tests call.
   */
  probeAsync?: (agent: Harness) => Promise<CoreLinkHarnessAvailability>;
};

export class HarnessAvailabilityStore {
  private readonly appendEvent: HarnessAvailabilityStoreOptions["appendEvent"];
  private readonly tickMs: number;
  private readonly probe: (agent: Harness) => CoreLinkHarnessAvailability;
  private readonly probeAsync: ((agent: Harness) => Promise<CoreLinkHarnessAvailability>) | null;
  private refreshing: Promise<void> | null = null;
  /** The one round queued behind {@link refreshing}, shared by every caller that arrived meanwhile. */
  private trailing: Promise<void> | null = null;
  private current: CoreLinkHarnessAvailabilityMap;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HarnessAvailabilityStoreOptions) {
    this.appendEvent = opts.appendEvent;
    this.tickMs = opts.tickMs ?? DEFAULT_AVAILABILITY_TICK_MS;
    this.probe = opts.probe ?? defaultProbe;
    this.probeAsync = opts.probeAsync ?? null;
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
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.tickMs);
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
        next[agent] = DISABLED;
        continue;
      }
      try {
        next[agent] = this.probe(agent);
      } catch (err) {
        next[agent] = probeFailed(err);
      }
    }
    this.publish(next);
  }

  /**
   * Re-probe with the asynchronous probe when there is one, else {@link runProbe}.
   * Resolves once the map is published, and **from a round that started after this
   * call**: a caller who arrives while a round is running (the install service,
   * just after the vendor installer wrote the binary) may have changed what that
   * round is looking at after it looked, so it is not handed the round in flight.
   * It gets the next one, and callers that arrive meanwhile share that one.
   */
  refresh(): Promise<void> {
    const probeAsync = this.probeAsync;
    if (!probeAsync) {
      this.runProbe();
      return Promise.resolve();
    }
    const running = this.refreshing;
    if (!running) {
      this.refreshing = this.round(probeAsync).finally(() => {
        this.refreshing = null;
      });
      return this.refreshing;
    }
    this.trailing ??= running.then(() => {
      this.trailing = null;
      return this.refresh();
    });
    return this.trailing;
  }

  private async round(probeAsync: (agent: Harness) => Promise<CoreLinkHarnessAvailability>): Promise<void> {
    const next: CoreLinkHarnessAvailabilityMap = {};
    for (const agent of UI_HARNESSES) {
      if (HARNESS_REGISTRY[agent].disabled) {
        next[agent] = DISABLED;
        continue;
      }
      try {
        next[agent] = await probeAsync(agent);
      } catch (err) {
        next[agent] = probeFailed(err);
      }
    }
    this.publish(next);
  }

  private publish(next: CoreLinkHarnessAvailabilityMap): void {
    if (mapsEqual(this.current, next)) return;
    this.current = next;
    try {
      this.appendEvent(
        HARNESSES_AVAILABILITY_EVENT_KIND,
        JSON.stringify({ availability: next }),
        { ptyId: null, sessionId: null },
      );
    } catch (err) {
      log.warn("core-availability.append-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const DISABLED: CoreLinkHarnessAvailability = { status: "missing", reason: "disabled" };

function probeFailed(err: unknown): CoreLinkHarnessAvailability {
  return { status: "missing", reason: err instanceof Error ? err.message : "probe-failed" };
}

/**
 * Default probe — PATH resolution plus a version check. Runs in the Core
 * process, so `sanitizedProcessEnv` +
 * `resolveHarnessCommandMeetingVersion` are directly available.
 */
function defaultProbe(agent: Harness): CoreLinkHarnessAvailability {
  const command = HARNESS_REGISTRY[agent].command;
  const env = sanitizedProcessEnv();
  const platform = os.platform();
  return availabilityFromCandidates(
    agent,
    resolveAllHarnessCommandsOnPath(command, env, platform),
    env,
    platform,
  );
}

/**
 * The availability of `agent` given every executable match for its command, in
 * search order, version-checked here. For a caller that can see the directories
 * and run the binaries itself; in the container the daemon can do neither, and
 * {@link availabilityFromProbe} takes what `core` found and checked instead.
 */
export function availabilityFromCandidates(
  agent: Harness,
  candidates: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = os.platform(),
): CoreLinkHarnessAvailability {
  const requirement = HARNESS_CLI_CONFIG_BY_COMMAND[HARNESS_REGISTRY[agent].command];
  const meeting = requirement ? pickHarnessCandidateMeetingVersion(candidates, requirement, env, platform) : null;
  return availabilityFromProbe(agent, candidates, meeting, platform);
}

/** What a version check, made somewhere else, said about one binary. Only these fields are read. */
export type ProbedVersionCheck = { ok: boolean; version?: string | null; reason?: string };

/**
 * The availability of `agent` from candidates found, and a version check made, by
 * somebody else. The label, floor and update commands are the registry's, never
 * the answer's: all that is taken from `meeting` is which binary and what its
 * check said.
 */
export function availabilityFromProbe(
  agent: Harness,
  candidates: readonly string[],
  meeting: { binary: string; check: ProbedVersionCheck } | null,
  platform: NodeJS.Platform = os.platform(),
): CoreLinkHarnessAvailability {
  const command = HARNESS_REGISTRY[agent].command;
  const requirement = HARNESS_CLI_CONFIG_BY_COMMAND[command];

  if (!requirement) {
    // No version requirement registered — a plain PATH lookup is the answer.
    return candidates[0]
      ? { status: "available", path: candidates[0] }
      : { status: "missing", reason: "not-found" };
  }

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
    reason: check.reason as Extract<CoreLinkHarnessAvailability, { status: "outdated" }>["reason"],
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
