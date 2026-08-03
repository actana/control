// The systemd user unit `actana setup` writes, and the parsers for the
// `systemctl` / `loginctl` output the lifecycle verbs read back.
//
// A *user* unit is the whole point: it lands in `$XDG_CONFIG_HOME/systemd/user`,
// runs as the installing operator, and needs no sudo. The one privilege-adjacent
// step — `loginctl enable-linger`, which keeps the daemon alive after logout —
// is prompted and explained by the setup flow, never assumed here.
//
// Pure string in, pure string out. The command running lives in
// `actana-systemd-runner.ts`; keeping the rendering and parsing separate is
// what lets the unit content and the status readback be tested without a
// systemd on the machine running the tests.

// Type-only, so nothing is imported at runtime and the two modules stay
// acyclic: the state shape belongs to the service-manager contract, and this
// file is one of the two implementations that produce it.
import type { ActanaServiceState } from "./actana-service";

/** The systemd user unit `actana setup` installs on Linux. */
export const UNIT_NAME = "actana-harness.service";

/** Journal identifier the unit tags its output with — what `actana logs` filters on. */
export const SYSLOG_IDENTIFIER = "actana-harness";

/** Seconds systemd waits before restarting a daemon that died. */
const RESTART_SEC = 5;

/** Everything that varies between one machine's unit and another's. */
export type ActanaUnitConfig = {
  /** `Description=` — what `systemctl --user status` shows. */
  description: string;
  /** The command to run. `argv[0]` must be an absolute path. */
  argv: string[];
  /** `WorkingDirectory=` — the operator's home, so agents resolve `~` normally. */
  workingDirectory: string;
  /** `Environment=` entries. Rendered sorted so re-running setup rewrites nothing. */
  environment: Record<string, string>;
};

/**
 * Quote a value for a systemd directive.
 *
 * systemd's unit syntax takes double-quoted strings with C-style escapes, so
 * backslashes must be doubled before quotes are escaped. Everything is quoted
 * unconditionally rather than only when it looks like it needs it — a home
 * directory with a space in it is the case that quietly breaks otherwise.
 */
export function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render the systemd user unit for the Harness daemon. */
export function renderActanaUnit(config: ActanaUnitConfig): string {
  if (config.argv.length === 0 || !config.argv[0].startsWith("/")) {
    throw new Error(`ExecStart needs an absolute path, got: ${config.argv[0] ?? "(nothing)"}`);
  }
  for (const [key, value] of Object.entries(config.environment)) {
    // A newline would end the directive and turn the rest of the value into
    // unit syntax. Nothing legitimate needs one.
    if (value.includes("\n")) throw new Error(`environment ${key} contains a newline`);
  }

  const environmentLines = Object.keys(config.environment)
    .sort()
    .map((key) => `Environment=${systemdQuote(`${key}=${config.environment[key]}`)}`);

  return (
    [
      "[Unit]",
      `Description=${config.description}`,
      // network-online rather than network.target: the daemon binds a public
      // address, and network.target is reached before addresses are assigned.
      "Wants=network-online.target",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${config.workingDirectory}`,
      ...environmentLines,
      `ExecStart=${config.argv.map(systemdQuote).join(" ")}`,
      "Restart=always",
      `RestartSec=${RESTART_SEC}`,
      `SyslogIdentifier=${SYSLOG_IDENTIFIER}`,
      "",
      "[Install]",
      "WantedBy=default.target",
    ].join("\n") + "\n"
  );
}

/**
 * Parse `systemctl show --property=…` output — one `KEY=VALUE` per line.
 *
 * Values legitimately contain `=`, so only the first one separates. Lines
 * without a key are skipped rather than thrown on: a warning printed onto
 * stdout by a container's systemd should not turn `actana status` into a
 * crash report.
 */
export function parseSystemctlProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    props[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return props;
}

/** Pull the four properties `actana status` cares about out of parsed properties. */
export function systemdStateFrom(props: Record<string, string>): ActanaServiceState {
  const pid = Number(props.MainPID);
  return {
    loadState: props.LoadState || "unknown",
    activeState: props.ActiveState || "unknown",
    subState: props.SubState || "unknown",
    // systemd reports 0 for "no main process", which is not a pid.
    mainPid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

/** Parse `systemctl show` output straight into a service state. */
export function systemdStateFromShow(text: string): ActanaServiceState {
  return systemdStateFrom(parseSystemctlProperties(text));
}

/**
 * Whether lingering is on for the user, from
 * `loginctl show-user <user> --property=Linger`.
 *
 * Absent means not enabled: on a machine where the property cannot be read the
 * honest answer for "will the daemon survive logout?" is no.
 */
export function parseLingerEnabled(text: string): boolean {
  return parseSystemctlProperties(text).Linger === "yes";
}
