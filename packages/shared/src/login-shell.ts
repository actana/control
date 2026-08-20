// The operator's login shell, as both halves of `actana` have to read it.
//
// Two callers, on either side of the daemon/CLI line, need the same answer:
// `packages/core/src/shell-env.ts` builds the PATH a Harness is spawned with,
// and `operator-login-path.ts` picks which login profile a managed PATH block
// is written into. Both switch on the same shell name, so the name has one
// definition here rather than one on each side of the move (#288 D2's rule —
// both halves use it, so it belongs to neither).
//
// `dscl` is the one subprocess in this file and it is macOS-only: a login
// shell changed with `chsh` lands in Directory Services, and neither `$SHELL`
// (inherited from whatever started the process) nor `os.userInfo()` sees it
// there. Everything else is `fs.existsSync` on a candidate list.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** macOS's record of the login shell — what `chsh` writes and `$SHELL` misses. */
function userShellFromDirectoryService(): string | null {
  if (os.platform() !== "darwin") return null;
  try {
    const username = os.userInfo().username;
    const result = spawnSync("/usr/bin/dscl", [".", "-read", `/Users/${username}`, "UserShell"], {
      encoding: "utf8",
      timeout: 1000,
    });
    const match = result.stdout.match(/UserShell:\s*(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The operator's login shell: `$SHELL`, then the passwd entry, then macOS's
 * Directory Services, then the first of the usual three that exists.
 *
 * Every candidate is checked for existence before it is returned — a `$SHELL`
 * pointing at a shell that has since been uninstalled is a real state, and
 * returning it would move the failure to the spawn.
 */
export function resolveShell(): string {
  const envShell = process.env.SHELL;
  if (envShell && fs.existsSync(envShell)) return envShell;

  const infoShell = (os.userInfo() as { shell?: string }).shell;
  if (infoShell && fs.existsSync(infoShell)) return infoShell;

  const dsclShell = userShellFromDirectoryService();
  if (dsclShell && fs.existsSync(dsclShell)) return dsclShell;

  if (os.platform() === "win32") return "powershell.exe";
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

/**
 * A shell path reduced to the lowercased name callers switch on, extension and
 * all: `/usr/bin/zsh` → `zsh`, `pwsh.exe` → `pwsh.exe`.
 */
export function shellBasename(shell: string): string {
  return path.basename(shell).toLowerCase();
}
