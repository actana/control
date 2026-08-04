// A throwaway home directory for the tests that write to an operator's
// dotfiles. Filesystem work is deliberately not behind the system port (see
// `actana-system.ts`), so these run against a real temp home rather than a
// fake — and every one of them has to be able to say "and nothing was written
// to the developer's actual home".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Stock Ubuntu 24.04's `~/.bashrc` guard, with OpenCode's export below it. */
export const UBUNTU_BASHRC_AFTER_OPENCODE = [
  "# ~/.bashrc: executed by bash(1) for non-login shells.",
  "",
  "# If not running interactively, don't do anything",
  "case $- in",
  "    *i*) ;;",
  "      *) return;;",
  "esac",
  "",
  "# opencode",
  "export PATH=$HOME/.opencode/bin:$PATH",
].join("\n");

/**
 * Temp homes handed out since the last {@link cleanupTempHomes}.
 *
 * A module-level list rather than a fixture object because every caller wants
 * the same `afterEach`, and threading one through would be more ceremony than
 * the thing it manages.
 */
const homes: string[] = [];

/** A fresh empty home, seeded with whatever dotfiles the test needs. */
export function makeTempHome(files: Record<string, string> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-home-"));
  homes.push(home);
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, name), text);
  }
  return home;
}

/** Read a home-relative file, or "" when it was never created. */
export function readHomeFile(home: string, name: string): string {
  const file = path.join(home, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** Remove every home handed out so far. Call from `afterEach`. */
export function cleanupTempHomes(): void {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
}
