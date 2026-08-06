// `actana status` — "is my Core healthy?" as one command.
//
// The report is assembled by the CLI (which reads the manifest, asks the
// machine's service manager, and probes Harnesses) and rendered here.
// Splitting it this way means the health rules and the operator-facing wording
// are unit-testable without an init system, a daemon, or an installed agent
// anywhere near the test — and one renderer serves both systemd and launchd,
// because by the time the report reaches here the platform difference has
// already been reduced to a service name and a persistence row.
//
// Operator-facing strings say "pairing token" — the glossary's UI note. Code
// and frames keep "Registration blob".

import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/core-link-frames";
import type { UpdateCheck } from "@actana/shared/actana-update-check";
import { coreUpdateCommand } from "./actana-container";
import type { ActanaServiceState } from "./actana-service";

/**
 * What stands in for the unit's rows in a container (ADR 0016 D16).
 *
 * There is no unit to ask and no init system to ask it of: the CLI and the
 * daemon are two processes in one container, so "is it running" is answered by
 * connecting to the core-link port, and "does it come back" is the container's
 * restart policy — a fact of the host that nothing inside can read.
 */
export type ContainerStatus = {
  /** Whether something accepted a connection on the core-link port. */
  listening: boolean;
  /** The port that was probed — named in the row, so a miss is actionable. */
  port: number;
};

/** Everything `actana status` reports. */
export type ActanaStatusReport = {
  /** Whether `actana setup` has ever completed on this machine. */
  installed: boolean;
  version: string | null;
  /** The core-link protocol version — what the Panel's version lock compares. */
  protocolVersion: string | null;
  target: string | null;
  /** The `wss://` endpoint the Panel dials. */
  endpoint: string | null;
  /** What the service is called here: `actana-core.service`, `com.actana.core`. */
  serviceName: string | null;
  /** null when no service is installed (or the platform has no init system). */
  service: ActanaServiceState | null;
  /** How the daemon persists across sessions. null when it could not be read. */
  persistence: { label: string; value: string } | null;
  /** Set only in container mode, where the three rows above have no answer. */
  container: ContainerStatus | null;
  /** Whether pairing material exists — i.e. a pairing token can be printed. */
  paired: boolean;
  /** The Core's own view of which Harnesses resolve on its PATH. */
  agents: CoreLinkHarnessAvailabilityMap;
  /**
   * What the update check answered, or null when it was not run.
   *
   * Deliberately outside {@link summarizeHealth}: `actana status` is
   * documented as a health check, and a Core one release behind is not
   * unhealthy — telling a script otherwise would break every deployment the
   * day 0.2.0 ships.
   */
  update: UpdateCheck | null;
};

/** The one-word answer at the top of `actana status`. */
export type ActanaHealth = "healthy" | "stopped" | "degraded" | "not-installed";

/**
 * Collapse the report into one word.
 *
 * `healthy` demands both halves of a working Core: a daemon the init system is
 * actually running, and material to pair with. An install that runs but cannot
 * produce a pairing token is not healthy, it is degraded — the operator has
 * nothing to paste into their Panel.
 */
export function summarizeHealth(report: ActanaStatusReport): ActanaHealth {
  if (!report.installed) return "not-installed";
  // In a container the same two halves are asked of different things: the port
  // stands in for the unit's active state, and there is no third answer — a
  // daemon that is not answering is stopped, and the restart policy is the
  // host's business, not a degradation this Core can see.
  if (report.container) {
    if (!report.container.listening) return "stopped";
    return report.paired ? "healthy" : "degraded";
  }
  if (!report.service) return "degraded";
  if (report.service.activeState === "active") {
    return report.service.subState === "running" && report.paired ? "healthy" : "degraded";
  }
  if (report.service.activeState === "inactive") return "stopped";
  return "degraded";
}

const HEALTH_LINE: Record<ActanaHealth, string> = {
  healthy: "Core: healthy",
  stopped: "Core: stopped",
  degraded: "Core: degraded",
  "not-installed": "Core: not installed",
};

function row(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}`;
}

/**
 * The availability rows, or nothing at all.
 *
 * Silence is the default: no rows when the check is off, when it could not
 * reach the channel, and when this Core is already on the newest release. An
 * "up to date" row would be a claim the check cannot make on the day GitHub is
 * unreachable, and a line that says nothing every day is a line operators stop
 * reading.
 *
 * The remedy differs by how this Core was installed, and only by that: in the
 * image there is no tree to swap, so the command belongs to the operator's
 * host (ADR 0016 D16). Neither remedy runs anything — this is an alert.
 */
function updateRows(report: ActanaStatusReport): string[] {
  const update = report.update;
  if (!update?.updateAvailable || update.latest === null) return [];
  const remedy = coreUpdateCommand(report.container !== null);
  return [
    row("Update", `${update.latest} is available — you're on ${update.current}`),
    row("", `run: ${remedy}`),
  ];
}

/** Render the report as the text `actana status` prints. */
export function formatActanaStatus(report: ActanaStatusReport): string {
  const health = summarizeHealth(report);
  const lines: string[] = [HEALTH_LINE[health]];

  if (health === "not-installed") {
    lines.push("", "  Run `actana setup` to install and pair this machine.");
    return lines.join("\n") + "\n";
  }

  lines.push("");
  lines.push(row("Version", report.version ?? "unknown"));
  lines.push(...updateRows(report));
  lines.push(row("Protocol version", report.protocolVersion ?? "unknown"));
  if (report.target) lines.push(row("Target", report.target));
  lines.push(row("Endpoint", report.endpoint ?? "unknown"));

  if (report.container) {
    // Naming `docker inspect` rather than a policy value is the honest answer:
    // the policy is set on the host and a process inside the container has no
    // way to read it back.
    lines.push(
      row("Auto-start", "the container's restart policy — read it on the host with"),
      row("", "`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' <container>`"),
      row(
        "State",
        report.container.listening
          ? `running (port ${report.container.port} answers)`
          : `not running (nothing answers on port ${report.container.port})`,
      ),
    );
  } else {
    lines.push(row("Auto-start", report.serviceName ?? "unknown"));
    if (report.service) {
      lines.push(row("State", `${report.service.activeState} (${report.service.subState})`));
      lines.push(
        row("PID", report.service.mainPid === null ? "—" : String(report.service.mainPid)),
      );
    } else {
      lines.push(row("State", "not installed"));
    }

    if (report.persistence) {
      lines.push(row(report.persistence.label, report.persistence.value));
    }
  }

  lines.push(
    row(
      "Pairing token",
      report.paired ? "available (`actana token` reprints it)" : "missing — re-run `actana setup`",
    ),
  );

  const harnessIds = Object.keys(report.agents).sort();
  if (harnessIds.length > 0) {
    lines.push("", "Harnesses");
    const width = Math.max(...harnessIds.map((id) => id.length));
    for (const id of harnessIds) {
      const agent = report.agents[id];
      const suffix = agent.version ?? agent.reason ?? "";
      lines.push(`  ${id.padEnd(width + 2)}${agent.status.padEnd(11)}${suffix}`.trimEnd());
    }
  }

  return lines.join("\n") + "\n";
}
