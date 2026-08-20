// The init system, behind one interface.
//
// `actana setup` and every lifecycle verb need the same six things — write the
// service definition, register it, make it persist, start it, read its state,
// show its logs — and Linux and macOS spell all six differently. This module is
// where that difference lives and stops: `actana-setup.ts` and `actana-cli.ts`
// know about an `ActanaServiceManager`, not about `systemctl` or `launchctl`.
//
// The rendering and parsing each platform needs stays pure in
// `actana-systemd.ts` / `actana-launchd.ts`. What is left here is the command
// sequencing, which runs through the `ActanaSystem` port and is therefore
// testable on a machine that has neither init system.
//
// The two platforms are not symmetric and this interface does not pretend they
// are. A systemd user unit outlives logout once lingering is on; a LaunchAgent
// is bound to the operator's session by design, and the sudo-less install has
// no way around that. `persistence()` reports what is actually true on each.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ActanaLayout } from "./actana-layout.ts";
import {
  chooseLaunchdDomain,
  LAUNCH_AGENT_LABEL,
  launchdLogPath,
  parseLaunchctlPrint,
  renderActanaPlist,
  serviceTarget,
} from "./actana-launchd.ts";
import {
  LEGACY_UNIT_NAME,
  parseLingerEnabled,
  renderActanaUnit,
  systemdStateFromShow,
  UNIT_NAME,
} from "./actana-systemd.ts";
import type { ActanaSystem, CommandResult } from "./actana-system.ts";

/** What the machine's init system says about the Core's auto-start unit. */
export type ActanaServiceState = {
  /** `loaded` when the unit / plist exists and parsed. */
  loadState: string;
  /** `active` / `inactive` / `failed` / `activating`. */
  activeState: string;
  /** `running` / `dead` / `auto-restart` — the detail under `active`. */
  subState: string;
  /** The daemon's pid, or null when nothing is running. */
  mainPid: number | null;
};

/** What the daemon needs to be started as — the platform-neutral half of a unit. */
export type ServiceDefinition = {
  /** Human description. systemd shows it; launchd has nowhere to put it. */
  description: string;
  /** The command to run. `argv[0]` must be an absolute path. */
  argv: string[];
  /** The operator's home, so agents resolve `~` normally. */
  workingDirectory: string;
  /** Environment for the daemon process. */
  environment: Record<string, string>;
};

/** The one row `actana status` prints about surviving logout. */
export type PersistenceRow = {
  /** `Linger` on systemd, `At login` on launchd. */
  label: string;
  value: string;
};

/** What making the service persist achieved. */
export type PersistenceOutcome = {
  /** Whether the daemon keeps running after the operator logs out. */
  survivesLogout: boolean;
  /** The parenthetical `actana setup` prints after the service's name. */
  summary: string;
};

/** What `actana setup` needs to know before it can prompt about persistence. */
export type PersistenceContext = {
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  /** Skip prompts and take the recommended answer. */
  assumeYes: boolean;
  /** Progress and warnings for the operator. */
  out: (line: string) => void;
};

/** The command `actana logs` hands the operator's terminal to. */
export type LogsCommand = { command: string; args: string[] };

/** The verbs an operator drives the daemon with. */
export type ServiceVerb = "start" | "stop" | "restart";

/** One machine's init system, as much of it as `actana` uses. */
export type ActanaServiceManager = {
  readonly kind: "systemd" | "launchd";
  /** What the operator sees this service called. */
  readonly name: string;
  /** The unit / plist file on disk. */
  readonly filePath: string;
  /** Whether the daemon is running right now. */
  isActive(): boolean;
  /** Stop the daemon, best effort — used before swapping the tree under it. */
  stop(): void;
  /** Write the service definition and register it. Throws when it cannot. */
  install(definition: ServiceDefinition): void;
  /**
   * Stop the daemon, unregister it, and remove the service file.
   *
   * Best effort by design: `actana uninstall` must leave a machine clean even
   * when the unit was already gone, already stopped, or never loaded, so
   * nothing here throws on "there was nothing to do".
   */
  uninstall(): void;
  /**
   * Remove the service a pre-rename install left behind, returning its name,
   * or null when there was nothing to do. See {@link LEGACY_UNIT_NAME} for why
   * this exists and when it goes.
   */
  removeLegacyUnit(): string | null;
  /** Make the daemon survive logout as far as this platform allows. */
  ensurePersistence(context: PersistenceContext): Promise<PersistenceOutcome>;
  /** Start at boot/login from now on, and start now. Throws when it cannot. */
  enableAndStart(): void;
  /** The daemon's state, or null when no service is installed. */
  state(): ActanaServiceState | null;
  /** Run an operator verb, returning the init system's own result. */
  verb(verb: ServiceVerb): CommandResult;
  /** The persistence row for `actana status`, or null when it cannot be read. */
  persistence(): PersistenceRow | null;
  /** What `actana logs` should run. */
  logs(options: { follow: boolean; lines: number }): LogsCommand;
};

export type ServiceManagerOptions = {
  platform: NodeJS.Platform;
  layout: ActanaLayout;
  system: ActanaSystem;
  /** The operator's username, for `loginctl`. */
  user: string;
  /** The operator's uid, for the launchd domain. */
  uid: number;
};

/** Run a command, throwing with its output when it fails. */
function must(system: ActanaSystem, command: string, args: string[]): CommandResult {
  const result = system.run(command, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

/** A result that stands in for "there was nothing to do". */
const NOOP: CommandResult = { status: 0, stdout: "", stderr: "" };

// ─── systemd ────────────────────────────────────────────────────────────────

function systemdServiceManager(opts: ServiceManagerOptions): ActanaServiceManager {
  const { layout, system, user } = opts;
  const systemctl = (...args: string[]): CommandResult =>
    system.run("systemctl", ["--user", ...args]);

  /**
   * Enable lingering, or explain how to.
   *
   * Never throws: an install on a machine that forbids lingering is still a
   * working install for as long as the operator is logged in, and saying so is
   * more use than aborting.
   */
  async function ensureLinger(context: PersistenceContext): Promise<boolean> {
    const show = system.run("loginctl", ["show-user", user, "--property=Linger"]);
    if (show.status !== 0) {
      context.out(
        "Warning: could not read the linger setting (no logind on this machine?). " +
          "The Core may stop when you log out.",
      );
      return false;
    }
    if (parseLingerEnabled(show.stdout)) return true;

    if (context.interactive && !context.assumeYes) {
      const yes = await system.confirm(
        "Enable lingering so the Core keeps running after you log out?",
        true,
      );
      if (!yes) {
        context.out(
          `Skipped lingering. The Core will stop when you log out — enable it later with ` +
            `\`loginctl enable-linger ${user}\`.`,
        );
        return false;
      }
    }

    if (system.run("loginctl", ["enable-linger", user]).status !== 0) {
      context.out(
        `Warning: could not enable lingering, so the Core will stop when you log out. ` +
          `Run this once with an administrator:\n  sudo loginctl enable-linger ${user}`,
      );
      return false;
    }
    return true;
  }

  /** Stop a unit, unlink it from boot, delete it, and leave no failed entry. */
  function removeUnit(name: string, filePath: string): void {
    systemctl("stop", name);
    // `disable` removes the `default.target.wants` link that starts the unit
    // at boot. Doing it before the file is deleted is what lets systemd find
    // the unit it is unlinking.
    systemctl("disable", name);
    fs.rmSync(filePath, { force: true });
    systemctl("daemon-reload");
    // A unit that died is remembered as failed until this, and a leftover
    // failed entry is exactly the kind of trace an uninstall should not leave.
    systemctl("reset-failed", name);
  }

  return {
    kind: "systemd",
    name: UNIT_NAME,
    filePath: layout.servicePath,

    isActive: () => systemctl("is-active", UNIT_NAME).stdout.trim() === "active",

    stop() {
      systemctl("stop", UNIT_NAME);
    },

    install(definition) {
      fs.mkdirSync(layout.serviceDir, { recursive: true });
      fs.writeFileSync(layout.servicePath, renderActanaUnit(definition), "utf8");
      must(system, "systemctl", ["--user", "daemon-reload"]);
    },

    uninstall() {
      removeUnit(UNIT_NAME, layout.servicePath);
    },

    removeLegacyUnit() {
      // Two places, because deleting a unit file does not disable the unit:
      // systemd reads a user's own units from `$XDG_CONFIG_HOME/systemd/user`,
      // and `enable` leaves a symlink in `default.target.wants` beside it that
      // still starts the daemon at boot on its own.
      const legacyPath = path.join(layout.serviceDir, LEGACY_UNIT_NAME);
      const enabledLink = path.join(layout.serviceDir, "default.target.wants", LEGACY_UNIT_NAME);
      // Asked of the filesystem rather than of systemd, so a machine that never
      // had one runs no commands at all and cannot fail. `lstat` for the link,
      // because once the unit file is gone the link dangles and `existsSync`
      // follows it to nothing — which is exactly the case being caught.
      if (!fs.existsSync(legacyPath) && !fs.lstatSync(enabledLink, { throwIfNoEntry: false })) {
        return null;
      }
      removeUnit(LEGACY_UNIT_NAME, legacyPath);
      return LEGACY_UNIT_NAME;
    },

    async ensurePersistence(context) {
      const linger = await ensureLinger(context);
      return { survivesLogout: linger, summary: linger ? "enabled, lingering" : "enabled" };
    },

    enableAndStart() {
      must(system, "systemctl", ["--user", "enable", UNIT_NAME]);
      // `restart` rather than `start`: on a re-run the unit is already up and
      // must pick up the new tree.
      must(system, "systemctl", ["--user", "restart", UNIT_NAME]);
    },

    state() {
      const show = systemctl(
        "show",
        UNIT_NAME,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
      );
      if (show.status !== 0) return null;
      const state = systemdStateFromShow(show.stdout);
      // `not-found` means systemd has no such unit — reporting "no service" is
      // truer than reporting a load state nobody can act on.
      return state.loadState === "not-found" ? null : state;
    },

    verb: (verb) => systemctl(verb, UNIT_NAME),

    persistence() {
      const show = system.run("loginctl", ["show-user", user, "--property=Linger"]);
      if (show.status !== 0) return null;
      return {
        label: "Linger",
        value: parseLingerEnabled(show.stdout)
          ? "yes"
          : "no — the daemon stops when you log out",
      };
    },

    logs({ follow, lines }) {
      const args = ["--user", "-u", UNIT_NAME, "--no-pager"];
      if (lines > 0) args.push("--lines", String(lines));
      if (follow) args.push("--follow");
      return { command: "journalctl", args };
    },
  };
}

// ─── launchd ────────────────────────────────────────────────────────────────

function launchdServiceManager(opts: ServiceManagerOptions): ActanaServiceManager {
  const { layout, system, uid } = opts;
  const logPath = launchdLogPath(layout.home);

  // Probed once and remembered: every verb has to address the same domain, and
  // `launchctl print` on a whole domain is not a cheap call.
  let domain: string | null = null;
  const resolveDomain = (): string => {
    domain ??= chooseLaunchdDomain(uid, (candidate) =>
      system.run("launchctl", ["print", candidate]).status === 0,
    );
    return domain;
  };
  const target = (): string => serviceTarget(resolveDomain(), LAUNCH_AGENT_LABEL);

  const printJob = (): CommandResult => system.run("launchctl", ["print", target()]);
  /** Whether launchd knows about the job at all — loaded, running or not. */
  const isLoaded = (): boolean => printJob().status === 0;
  /** Whether the daemon is actually up. Loaded but throttled is not running. */
  const isRunning = (): boolean => {
    const printed = printJob();
    return printed.status === 0 && parseLaunchctlPrint(printed.stdout).state === "running";
  };

  /** Register the agent with launchd. `RunAtLoad` is what starts it. */
  const bootstrap = (): CommandResult =>
    system.run("launchctl", ["bootstrap", resolveDomain(), layout.servicePath]);

  return {
    kind: "launchd",
    name: LAUNCH_AGENT_LABEL,
    filePath: layout.servicePath,

    isActive: isRunning,

    stop() {
      // `launchctl stop` would be pointless here: `KeepAlive` is on, so launchd
      // restarts the job the moment it dies. Unloading the agent is what
      // actually stops a Core.
      system.run("launchctl", ["bootout", target()]);
    },

    install(definition) {
      fs.mkdirSync(layout.serviceDir, { recursive: true });
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      // launchd will not create the file itself if the daemon writes nothing,
      // and `actana logs` tailing a missing file is a confusing first failure.
      fs.appendFileSync(logPath, "");
      fs.writeFileSync(
        layout.servicePath,
        renderActanaPlist({
          label: LAUNCH_AGENT_LABEL,
          argv: definition.argv,
          workingDirectory: definition.workingDirectory,
          environment: definition.environment,
          logPath,
        }),
        "utf8",
      );
      // A loaded job holds the plist launchd read at bootstrap time, so a
      // re-run's new definition only takes effect after an unload. Failure
      // here is the ordinary "nothing was loaded" case.
      system.run("launchctl", ["bootout", target()]);
    },

    uninstall() {
      // Unload first, then delete: launchd holds the plist it read at bootstrap
      // time, so removing the file alone would leave the daemon running.
      // Deliberately no `launchctl disable` — that writes a persistent override
      // which survives the plist and blocks every later bootstrap of the label,
      // turning a reinstall into a puzzle.
      system.run("launchctl", ["bootout", target()]);
      fs.rmSync(layout.servicePath, { force: true });
    },

    removeLegacyUnit() {
      // Nothing to clean up: the pre-rename `com.actana.harness` agent only
      // ever existed on a machine that built its own tarball, and the macOS
      // Core targets are being dropped rather than migrated (ADR 0016 D28).
      return null;
    },

    async ensurePersistence() {
      // Nothing to enable, and nothing to prompt about: `RunAtLoad` in a
      // LaunchAgent is the whole mechanism. It also cannot outlive the
      // operator's session — that would take a root-owned LaunchDaemon, and
      // this install is sudo-less by design.
      return { survivesLogout: false, summary: "loaded, starts at login" };
    },

    enableAndStart() {
      // An operator (or an earlier uninstall) may have `launchctl disable`d the
      // label, which makes every bootstrap fail until it is undone.
      system.run("launchctl", ["enable", target()]);
      const booted = bootstrap();
      if (booted.status === 0) return; // RunAtLoad has already started it
      // Already bootstrapped is the common failure, and `kickstart -k` is the
      // right answer to it: kill whatever is running and start it again.
      const kicked = system.run("launchctl", ["kickstart", "-k", target()]);
      if (kicked.status !== 0) {
        const detail = (booted.stderr || booted.stdout).trim();
        throw new Error(
          `launchctl bootstrap ${resolveDomain()} ${layout.servicePath} failed ` +
            `(${booted.status})${detail ? `: ${detail}` : ""}`,
        );
      }
    },

    state() {
      if (!fs.existsSync(layout.servicePath)) return null;
      const printed = printJob();
      if (printed.status !== 0) {
        // The agent is installed but not loaded — `actana stop`, or a session
        // that has not logged in since. That is stopped, not missing.
        return { loadState: "loaded", activeState: "inactive", subState: "dead", mainPid: null };
      }
      const job = parseLaunchctlPrint(printed.stdout);
      if (job.state === "running") {
        return {
          loadState: "loaded",
          activeState: "active",
          subState: "running",
          mainPid: job.pid,
        };
      }
      // Loaded but not running: launchd is between restarts, or throttling a
      // job that keeps dying. Either way the operator has something to fix.
      return {
        loadState: "loaded",
        activeState: "activating",
        subState: job.state ?? "unknown",
        mainPid: null,
      };
    },

    verb(verb) {
      if (verb === "stop") {
        // systemd exits 0 for stopping an already-stopped unit; match that
        // rather than surfacing launchd's "no such service" as a failure.
        return isLoaded() ? system.run("launchctl", ["bootout", target()]) : NOOP;
      }
      if (verb === "start") {
        // Loaded is not the same as running: a job launchd is throttling after
        // repeated crashes is loaded and dead, and `systemctl start` would act
        // on its equivalent. Only an already-running daemon is a no-op.
        if (isRunning()) return NOOP;
        if (isLoaded()) return system.run("launchctl", ["kickstart", "-k", target()]);
        system.run("launchctl", ["enable", target()]);
        return bootstrap();
      }
      return isLoaded() ? system.run("launchctl", ["kickstart", "-k", target()]) : bootstrap();
    },

    persistence() {
      // Not a setting that can be read back, but a property of the mechanism —
      // and the one thing a macOS operator most needs told.
      return {
        label: "At login",
        value: "yes — starts when you log in, stops when you log out",
      };
    },

    logs({ follow, lines }) {
      // launchd has no journal: the plist points both streams at one file and
      // this tails it. `-F` rather than `-f` so a rotated log keeps following.
      const args = follow ? ["-F"] : [];
      // `+1` means "from the first line" — the whole file, matching what
      // `journalctl` with no `--lines` shows.
      args.push("-n", lines > 0 ? String(lines) : "+1", logPath);
      return { command: "tail", args };
    },
  };
}

// ─── factory ────────────────────────────────────────────────────────────────

/** Whether `actana` can install and operate a service on this platform. */
export function supportsService(platform: NodeJS.Platform): boolean {
  return platform === "linux" || platform === "darwin";
}

/**
 * The init system for this machine.
 *
 * Throws on a platform with neither, because every caller's next move is to
 * tell the operator that and stop — there is no partial `actana` on Windows.
 */
export function createServiceManager(opts: ServiceManagerOptions): ActanaServiceManager {
  if (opts.platform === "linux") return systemdServiceManager(opts);
  if (opts.platform === "darwin") return launchdServiceManager(opts);
  throw new Error(
    `actana installs a systemd user unit on Linux and a LaunchAgent on macOS, and ` +
      `supports nothing else (this machine is ${opts.platform}).`,
  );
}
