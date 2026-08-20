// Where `actana` puts things on an operator's machine.
//
// Every path resolves under the operator's home so `actana setup` needs no
// sudo (spec: "Install layout: user-level, sudo-less"). The layout is
// deliberately versioned — `versions/<v>` plus a `current` symlink — so
// `actana update` can land a new tree beside the running one and swap by
// repointing a single link.
//
// Pure: takes an env bag and a home dir, returns paths. Nothing here touches
// the filesystem, so the whole layout is unit-testable against a fake home.

import * as path from "node:path";
import { LAUNCH_AGENT_FILENAME } from "./actana-launchd.ts";
import { UNIT_NAME } from "./actana-systemd.ts";

// Re-exported so `actana-layout.ts` stays the one module that answers "where
// does actana put things". The two state paths themselves live in
// `@actana/shared` because the daemon writes both of them (#288 D2).
export {
  updateCheckCachePath,
  updateNoticeStatePath,
} from "@actana/shared/actana-state-paths";

/** Everywhere `actana` reads or writes on the operator's machine. */
export type ActanaLayout = {
  /** The operator's home directory. */
  home: string;
  /** Root of everything actana installs (`~/.local/share/actana`). */
  root: string;
  /** One directory per installed version (`<root>/versions`). */
  versionsDir: string;
  /** Symlink to the version the unit runs (`<root>/current`). */
  currentLink: string;
  /** `AC_USER_DATA_DIR` — the SQLite lives here and survives an uninstall. */
  dataDir: string;
  /** Where `material.json` and `actana.json` live (`~/.config/actana`). */
  configDir: string;
  /** Directory the `actana` launcher is linked into (`~/.local/bin`). */
  binDir: string;
  /** The launcher symlink itself (`<binDir>/actana`). */
  binLink: string;
  /**
   * Where this platform's init system looks for the operator's own services:
   * `$XDG_CONFIG_HOME/systemd/user` on Linux, `~/Library/LaunchAgents` on macOS.
   */
  serviceDir: string;
  /** The unit / plist file `actana setup` writes. */
  servicePath: string;
};

/**
 * Read an env var that names a directory.
 *
 * Absolute values win. A relative value resolves against the home dir rather
 * than the process CWD — `actana setup` runs from wherever the operator
 * extracted the tarball, and silently installing relative to that is a trap.
 * Empty/unset returns undefined so the caller falls through to its default.
 */
function envDir(env: NodeJS.ProcessEnv, name: string, home: string): string | undefined {
  const value = env[name];
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.join(home, value);
}

/**
 * An XDG base-directory variable. The XDG spec says a relative value is
 * invalid and must be ignored — unlike our own `ACTANA_*` overrides, which
 * are ours to interpret.
 */
function xdgDir(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value && path.isAbsolute(value) ? value : fallback;
}

/**
 * Where this platform's init system reads the operator's own auto-start units,
 * and what the file in there is called.
 *
 * Neither can follow `ACTANA_CONFIG_DIR`: systemd reads user units from
 * `$XDG_CONFIG_HOME/systemd/user` and nowhere else, and launchd reads agents
 * from `~/Library/LaunchAgents` and nowhere else.
 */
function serviceLocation(
  platform: NodeJS.Platform,
  home: string,
  xdgConfig: string,
): { dir: string; file: string } {
  return platform === "darwin"
    ? { dir: path.join(home, "Library", "LaunchAgents"), file: LAUNCH_AGENT_FILENAME }
    : { dir: path.join(xdgConfig, "systemd", "user"), file: UNIT_NAME };
}

/** Resolve every path `actana` uses from the environment, home dir, and platform. */
export function resolveActanaLayout(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): ActanaLayout {
  const xdgData = xdgDir(env, "XDG_DATA_HOME", path.join(home, ".local", "share"));
  const xdgConfig = xdgDir(env, "XDG_CONFIG_HOME", path.join(home, ".config"));

  const root = envDir(env, "ACTANA_HOME", home) ?? path.join(xdgData, "actana");
  const configDir = envDir(env, "ACTANA_CONFIG_DIR", home) ?? path.join(xdgConfig, "actana");
  const dataDir = envDir(env, "ACTANA_DATA_DIR", home) ?? path.join(root, "data");
  const binDir = envDir(env, "ACTANA_BIN_DIR", home) ?? path.join(home, ".local", "bin");
  const service = serviceLocation(platform, home, xdgConfig);

  return {
    home,
    root,
    versionsDir: path.join(root, "versions"),
    currentLink: path.join(root, "current"),
    dataDir,
    configDir,
    binDir,
    binLink: path.join(binDir, "actana"),
    serviceDir: service.dir,
    servicePath: path.join(service.dir, service.file),
  };
}

/**
 * The install directory for a version.
 *
 * The version string comes from a downloaded tarball's manifest, so it is
 * treated as untrusted input: anything that is not a plain path segment is
 * rejected rather than allowed to escape `versionsDir`.
 */
export function installDirFor(layout: ActanaLayout, version: string): string {
  if (!version || version !== path.basename(version) || version === "." || version === "..") {
    throw new Error(`unusable version string: ${JSON.stringify(version)}`);
  }
  return path.join(layout.versionsDir, version);
}

/**
 * Whether the launcher's directory is on `PATH` — if it is not, `actana` works
 * during setup (the operator ran it by path) and then vanishes, so setup says
 * so instead of leaving them to discover it.
 */
export function binDirOnPath(binDir: string, rawPath: string | undefined): boolean {
  if (!rawPath) return false;
  const target = path.resolve(binDir);
  return rawPath
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === target);
}
