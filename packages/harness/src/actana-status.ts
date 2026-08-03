// `actana status` — "is my Core healthy?" as one command.
//
// The report is assembled by the CLI (which reads the manifest, asks the
// machine's service manager, and probes agent CLIs) and rendered here.
// Splitting it this way means the health rules and the operator-facing wording
// are unit-testable without an init system, a daemon, or an installed agent
// anywhere near the test — and one renderer serves both systemd and launchd,
// because by the time the report reaches here the platform difference has
// already been reduced to a service name and a persistence row.
//
// Operator-facing strings say "pairing token" — the glossary's UI note. Code
// and frames keep "Registration blob".

import type { CoreLinkAgentAvailabilityMap } from "../../shared/src/core-link-frames";
import type { ActanaServiceState } from "./actana-service";

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
  /** What the service is called here: `actana-harness.service`, `com.actana.harness`. */
  serviceName: string | null;
  /** null when no service is installed (or the platform has no init system). */
  service: ActanaServiceState | null;
  /** How the daemon persists across sessions. null when it could not be read. */
  persistence: { label: string; value: string } | null;
  /** Whether pairing material exists — i.e. a pairing token can be printed. */
  paired: boolean;
  /** The Harness's own view of which agent CLIs resolve on its PATH. */
  agents: CoreLinkAgentAvailabilityMap;
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
  if (!report.service) return "degraded";
  if (report.service.activeState === "active") {
    return report.service.subState === "running" && report.paired ? "healthy" : "degraded";
  }
  if (report.service.activeState === "inactive") return "stopped";
  return "degraded";
}

const HEALTH_LINE: Record<ActanaHealth, string> = {
  healthy: "Harness: healthy",
  stopped: "Harness: stopped",
  degraded: "Harness: degraded",
  "not-installed": "Harness: not installed",
};

function row(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}`;
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
  lines.push(row("Protocol version", report.protocolVersion ?? "unknown"));
  if (report.target) lines.push(row("Target", report.target));
  lines.push(row("Endpoint", report.endpoint ?? "unknown"));

  lines.push(row("Auto-start", report.serviceName ?? "unknown"));
  if (report.service) {
    lines.push(row("State", `${report.service.activeState} (${report.service.subState})`));
    lines.push(row("PID", report.service.mainPid === null ? "—" : String(report.service.mainPid)));
  } else {
    lines.push(row("State", "not installed"));
  }

  if (report.persistence) {
    lines.push(row(report.persistence.label, report.persistence.value));
  }

  lines.push(
    row(
      "Pairing token",
      report.paired ? "available (`actana token` reprints it)" : "missing — re-run `actana setup`",
    ),
  );

  const agentIds = Object.keys(report.agents).sort();
  if (agentIds.length > 0) {
    lines.push("", "Agents");
    const width = Math.max(...agentIds.map((id) => id.length));
    for (const id of agentIds) {
      const agent = report.agents[id];
      const suffix = agent.version ?? agent.reason ?? "";
      lines.push(`  ${id.padEnd(width + 2)}${agent.status.padEnd(11)}${suffix}`.trimEnd());
    }
  }

  return lines.join("\n") + "\n";
}
