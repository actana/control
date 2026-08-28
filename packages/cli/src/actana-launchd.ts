// The macOS LaunchAgent `actana setup` writes, and the parsers for the
// `launchctl` output the lifecycle verbs read back.
//
// A *LaunchAgent* is the whole point, exactly as the systemd side installs a *user*
// unit: it lands in `~/Library/LaunchAgents`, runs as the installing operator,
// and needs no sudo. The trade macOS makes in return is that a LaunchAgent is
// bound to the operator's session — it starts at login and stops at logout.
// Surviving logout would mean a LaunchDaemon in `/Library/LaunchDaemons`,
// which is root-owned and needs an administrator; the install story is
// sudo-less, so `actana status` says "starts at login" rather than pretending
// otherwise.
//
// Pure string in, pure string out — the mirror of `actana-systemd.ts`. The
// `launchctl` running lives in `actana-service.ts`, which is what lets the
// plist content and the state readback be tested on a machine with no launchd.

import * as path from "node:path";

/** The job label — also the plist's basename and what `launchctl` addresses. */
export const LAUNCH_AGENT_LABEL = "com.actana.core";

/** The plist filename inside `~/Library/LaunchAgents`. */
export const LAUNCH_AGENT_FILENAME = `${LAUNCH_AGENT_LABEL}.plist`;

/**
 * The agent setup wrote when the machine was called a Harness.
 *
 * The launchd half of `LEGACY_UNIT_NAME` in `actana-systemd.ts`, and it exists
 * for the same reason: a machine installed before the Harness → Core rename still has this
 * agent, `KeepAlive` is on, and its `ProgramArguments` point at
 * `…/current/bin/actana` — so after an in-place upgrade the *old* agent
 * launches the *new* binary with the old environment (#348). It has to be
 * booted out and deleted, not left beside the new one.
 *
 * Deletable with `removeLegacyUnit` and its callers, one release after every
 * supported machine has been through a 0.4.2 `actana setup`.
 */
export const LEGACY_LAUNCH_AGENT_LABEL = "com.actana.harness";

/** The pre-rename plist's filename inside `~/Library/LaunchAgents`. */
export const LEGACY_LAUNCH_AGENT_FILENAME = `${LEGACY_LAUNCH_AGENT_LABEL}.plist`;

/** Everything that varies between one machine's LaunchAgent and another's. */
export type ActanaPlistConfig = {
  /** `Label` — the job's name in every `launchctl` invocation. */
  label: string;
  /** The command to run. `argv[0]` must be an absolute path. */
  argv: string[];
  /** `WorkingDirectory` — the operator's home, so agents resolve `~` normally. */
  workingDirectory: string;
  /** `EnvironmentVariables`. Rendered sorted so re-running setup rewrites nothing. */
  environment: Record<string, string>;
  /** Where both of the daemon's streams go — what `actana logs` tails. */
  logPath: string;
};

/** Where the LaunchAgent's plist lives for a given home directory. */
export function launchAgentPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", LAUNCH_AGENT_FILENAME);
}

/**
 * Where a pre-rename install left its plist.
 *
 * Beside {@link launchAgentPath} rather than derived from the layout: launchd
 * reads agents from `~/Library/LaunchAgents` and nowhere else, so the legacy
 * one is in the same directory as the current one by construction.
 */
export function legacyLaunchAgentPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", LEGACY_LAUNCH_AGENT_FILENAME);
}

/**
 * The daemon's log file.
 *
 * launchd has no journal, so the plist redirects both streams to a file and
 * `actana logs` tails it. `~/Library/Logs` is where macOS expects a user's
 * application logs, which also means Console.app finds them without being told.
 */
export function launchdLogPath(home: string): string {
  return path.join(home, "Library", "Logs", "Actana", "core.log");
}

/**
 * Escape a value for an XML `<string>`.
 *
 * `&` first, or the entities introduced by the later replacements would be
 * escaped a second time. Quotes are escaped too — not strictly required inside
 * element content, but it keeps the output safe to paste anywhere in a plist.
 */
export function plistEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render the LaunchAgent plist for the Core daemon. */
export function renderActanaPlist(config: ActanaPlistConfig): string {
  if (config.argv.length === 0 || !config.argv[0].startsWith("/")) {
    throw new Error(
      `ProgramArguments needs an absolute path, got: ${config.argv[0] ?? "(nothing)"}`,
    );
  }

  const programArguments = config.argv
    .map((arg) => `      <string>${plistEscape(arg)}</string>`)
    .join("\n");

  const environment = Object.keys(config.environment)
    .sort()
    .map(
      (key) =>
        `      <key>${plistEscape(key)}</key>\n` +
        `      <string>${plistEscape(config.environment[key])}</string>`,
    )
    .join("\n");

  return (
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "  <dict>",
      "    <key>Label</key>",
      `    <string>${plistEscape(config.label)}</string>`,
      "    <key>ProgramArguments</key>",
      "    <array>",
      programArguments,
      "    </array>",
      "    <key>EnvironmentVariables</key>",
      "    <dict>",
      environment,
      "    </dict>",
      "    <key>WorkingDirectory</key>",
      `    <string>${plistEscape(config.workingDirectory)}</string>`,
      // The launchd half of `Restart=always`: start when the agent is loaded
      // (login, or `actana start`), and restart whenever the daemon exits.
      "    <key>RunAtLoad</key>",
      "    <true/>",
      "    <key>KeepAlive</key>",
      "    <true/>",
      // Both streams to one file: the daemon interleaves them anyway, and one
      // file is one thing for `actana logs` to tail.
      "    <key>StandardOutPath</key>",
      `    <string>${plistEscape(config.logPath)}</string>`,
      "    <key>StandardErrorPath</key>",
      `    <string>${plistEscape(config.logPath)}</string>`,
      // Without this launchd files the job as Standard and may throttle it
      // under memory pressure. A Core is running the operator's agents; it is
      // the work the machine is for, not background housekeeping.
      "    <key>ProcessType</key>",
      "    <string>Interactive</string>",
      "  </dict>",
      "</plist>",
    ].join("\n") + "\n"
  );
}

/** What `launchctl print` says about a loaded job. */
export type LaunchctlJobState = {
  /** `running`, `waiting`, … — null when the output had no state line. */
  state: string | null;
  /** The daemon's pid, or null when nothing is running. */
  pid: number | null;
};

/**
 * Parse `launchctl print <domain>/<label>` output.
 *
 * The format is a nested brace dump rather than anything machine-oriented, so
 * this reads the two lines that matter and ignores everything else. Output it
 * does not recognise comes back as all-nulls rather than throwing: the caller's
 * question is "is it running?", and "cannot tell" is an answer it can render.
 */
export function parseLaunchctlPrint(text: string): LaunchctlJobState {
  const state = /^\s*state = (\S+)\s*$/m.exec(text);
  const pid = /^\s*pid = (\d+)\s*$/m.exec(text);
  const parsedPid = pid ? Number(pid[1]) : 0;
  return {
    state: state ? state[1] : null,
    // launchd prints no pid line at all for a job that is not running, but a
    // 0 would mean the same thing and is not a pid either way.
    pid: parsedPid > 0 ? parsedPid : null,
  };
}

/** Address a job inside a launchd domain — what every `launchctl` verb takes. */
export function serviceTarget(domain: string, label: string): string {
  return `${domain}/${label}`;
}

/**
 * Pick the launchd domain to bootstrap the agent into.
 *
 * `gui/<uid>` is where a logged-in Mac's agents live and is what an operator
 * at the keyboard gets. A machine reached over SSH — or a headless CI runner —
 * may have no Aqua session at all, and there `user/<uid>` is the same user's
 * domain minus the GUI. Probing rather than guessing is what lets one code
 * path serve both.
 *
 * When neither answers, the GUI domain comes back anyway so the bootstrap that
 * follows fails with launchd's own message about the domain an operator
 * expects, rather than about a fallback they have never heard of.
 */
export function chooseLaunchdDomain(uid: number, exists: (domain: string) => boolean): string {
  const gui = `gui/${uid}`;
  if (exists(gui)) return gui;
  const user = `user/${uid}`;
  if (exists(user)) return user;
  return gui;
}
