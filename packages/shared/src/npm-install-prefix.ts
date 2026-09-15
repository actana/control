// npm -g without a writable prefix — the bare-metal gap Pi and Codex share.
//
// `npm install -g` writes into whatever `npm prefix -g` reports. On a Core image
// that is `$HOME/.local` (`NPM_CONFIG_PREFIX` in deploy/core.Dockerfile). On bare
// metal where Node came from nodejs.org / nodesource it is usually `/usr/local`,
// which belongs to root. An operator without sudo then gets EACCES, and the
// canary used to hide that by running `npm config set prefix` by hand before
// `actana harnesses install pi` — proving the installer on a machine shape
// real operators do not have (#521).
//
// This module is the product answer: when the effective global prefix is not
// writable, rewrite `npm install -g` / `npm i -g` to `--prefix "$HOME/.local"`
// so the shims land in `$HOME/.local/bin`. The matching PATH suffix lives on
// the Pi and Codex registry rows (`homePathSuffixes`), which
// `operator-login-path.ts` and the Core's PATH probe already read.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** Home-relative npm prefix used when the global one is not writable. */
export const NPM_USER_PREFIX_SUFFIX = ".local";

/** Home-relative bin directory that prefix puts shims in. */
export const NPM_USER_BIN_SUFFIX = ".local/bin";

const NPM_GLOBAL_INSTALL = /^npm\s+(?:install|i)\s+-g\b/;

export type WithNpmUserPrefixOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Override for tests — skip spawning `npm prefix -g`. */
  resolvePrefix?: () => string | null;
  /** Override for tests — skip the real filesystem access check. */
  isWritable?: (dir: string) => boolean;
};

/** True when `command` is an `npm install -g` / `npm i -g` line. */
export function isNpmGlobalInstallCommand(command: string): boolean {
  return NPM_GLOBAL_INSTALL.test(command.trim());
}

/**
 * What `npm prefix -g` would use right now: `NPM_CONFIG_PREFIX` when set
 * (the Core image), else the live npm answer. Null when npm is missing or
 * refuses to answer — the caller then leaves the command alone.
 */
export function resolveNpmGlobalPrefix(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.NPM_CONFIG_PREFIX?.trim();
  if (fromEnv) return fromEnv;

  try {
    const result = spawnSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
    });
    if (result.error || result.status !== 0) return null;
    const prefix = (result.stdout ?? "").trim();
    return prefix.length > 0 ? prefix : null;
  } catch {
    return null;
  }
}

/** Whether `dir` exists and is writable, or can be created by this user. */
export function isDirectoryWritable(
  dir: string,
  access: (path: string, mode?: number) => void = fs.accessSync,
  exists: (path: string) => boolean = fs.existsSync,
): boolean {
  try {
    access(dir, fs.constants.W_OK);
    return true;
  } catch {
    // Prefix may not exist yet (fresh `$HOME/.local`). Walk up to the nearest
    // existing ancestor — if that is writable we can create the rest.
    let current = path.resolve(dir);
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return false;
      if (exists(parent)) {
        try {
          access(parent, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      }
      current = parent;
    }
  }
}

/**
 * Rewrite an `npm install -g` command to `--prefix "$HOME/.local"` when the
 * effective global prefix is not writable. Leaves every other command, every
 * Windows install, and every already-prefixed / already-writable case alone.
 *
 * `$HOME` stays a shell variable so the string is honest in the "Installing …"
 * progress line and survives a home directory that moves.
 */
export function withNpmUserPrefixIfNeeded(
  command: string,
  opts: WithNpmUserPrefixOptions = {},
): string {
  const platform = opts.platform ?? os.platform();
  if (platform === "win32") return command;
  if (!isNpmGlobalInstallCommand(command)) return command;
  if (/\s--prefix(\s|=)/.test(command)) return command;

  const resolvePrefix = opts.resolvePrefix ?? (() => resolveNpmGlobalPrefix(opts.env ?? process.env));
  const prefix = resolvePrefix();
  // No answer from npm → do not guess. The install will fail the same way it
  // would have without us, and the vendor URL is still on the failure line.
  if (!prefix) return command;

  const isWritable = opts.isWritable ?? ((dir: string) => isDirectoryWritable(dir));
  if (isWritable(prefix)) return command;

  return command.replace(NPM_GLOBAL_INSTALL, (match) => `${match} --prefix "$HOME/${NPM_USER_PREFIX_SUFFIX}"`);
}
