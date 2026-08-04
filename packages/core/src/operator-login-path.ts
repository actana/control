// Keeping the Harnesses Actana installed on the operator's login PATH.
//
// `actana harnesses install <id>` shells to the vendor's own installer, and each
// vendor decides for itself how to put its binary on PATH. OpenCode's
// installer appends its `export PATH=...` to `~/.bashrc` — *below* the guard
// stock Ubuntu ships at the top of that file:
//
//     case $- in
//         *i*) ;;
//           *) return;;
//     esac
//
// So a login but non-interactive shell — `bash -lc`, which is what a
// provisioning script and the agents e2e both use — returns before ever
// reaching the export, and the CLI Actana just installed is not on PATH. The
// binary is exactly where the shared registry says it is; only the wiring is
// missing. Claude Code and Cursor are unaffected only by luck: they install
// into `~/.local/bin`, which Ubuntu's stock `~/.profile` adds unconditionally.
//
// Actana cannot stop a vendor writing to whichever file it likes, so it writes
// its own: one marker-delimited block, in the files the operator's login shell
// genuinely reads, listing the home-relative directories the registry
// declares. Marker-delimited because this runs again on every install, and two
// competing blocks would be worse than none. Nothing outside the markers is
// touched, so an operator who edits around it keeps their edits.
//
// This is the only place Actana writes to an operator's dotfiles. It is
// deliberately narrow: it adds directories to PATH and does nothing else.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harnessHomePathSuffixes } from "@actana/shared/harness-cli-config";
import { resolveShell, shellBasename } from "./shell-env";

/** Opening marker. Everything between this and {@link MANAGED_BLOCK_END} is Actana's. */
export const MANAGED_BLOCK_BEGIN = "# >>> actana managed PATH >>>";

/** Closing marker. */
export const MANAGED_BLOCK_END = "# <<< actana managed PATH <<<";

/** Whether a home-relative file name exists in the operator's home directory. */
export type ProfileExists = (name: string) => boolean;

export type EnsureOperatorLoginPathOptions = {
  /** The operator's login shell, as `resolveShell()` reports it. */
  shell: string;
  platform: NodeJS.Platform;
  /** Home-relative directories to keep on PATH, e.g. `[".opencode/bin"]`. */
  suffixes: readonly string[];
  exists: ProfileExists;
  /** Read a home-relative file. Returns "" when it does not exist. */
  read: (name: string) => string;
  /** Write a home-relative file, creating it when needed. */
  write: (name: string, text: string) => void;
};

export type EnsureOperatorLoginPathResult = {
  /** Home-relative profiles actually written. Empty when there was nothing to do. */
  written: string[];
  /**
   * Profiles that were meant to be written and could not be — a read-only
   * home, most likely. Reported rather than thrown: a CLI that installed fine
   * but is not yet on PATH is worth a sentence, not a failed install.
   */
  failed: string[];
};

/** The bash login files, in the order bash itself tries them. */
const BASH_LOGIN_FILES = [".bash_profile", ".bash_login", ".profile"] as const;

/** What `sh -l` reads, and bash's own last resort. */
const POSIX_PROFILE = ".profile";

/**
 * The home-relative profiles a login shell reads, most specific first.
 *
 * bash opens the *first* of `.bash_profile`, `.bash_login`, `.profile` that
 * exists and stops — so appending to `.profile` when a `.bash_profile` is
 * present writes to a file that login shell will never open. zsh opens none of
 * the three, which is why it gets its own answer.
 *
 * `.profile` is then always included on top of that. `shell` comes from
 * `$SHELL` or the passwd entry, and both can be missing or stale inside a
 * systemd unit or a container; guessing zsh there and writing only
 * `.zprofile` would reproduce exactly the bug this module exists to fix. One
 * extra POSIX file is a much cheaper mistake than a block nothing reads.
 */
export function loginProfileNames(shell: string, exists: ProfileExists): string[] {
  const base = shellBasename(shell);
  const specific =
    base === "zsh"
      ? ".zprofile"
      : base === "bash"
        ? (BASH_LOGIN_FILES.find((name) => exists(name)) ?? POSIX_PROFILE)
        : POSIX_PROFILE;
  return specific === POSIX_PROFILE ? [POSIX_PROFILE] : [specific, POSIX_PROFILE];
}

/**
 * The block, for a set of home-relative directories.
 *
 * POSIX sh only: this is sourced by bash, zsh and dash logins alike, and a
 * `[[` here would be a syntax error in the last of them. `$HOME` stays a
 * variable rather than being expanded now, so the block survives a home
 * directory that moves.
 */
export function renderManagedBlock(suffixes: readonly string[]): string {
  const quoted = suffixes.map((suffix) => `"$HOME/${suffix}"`).join(" ");
  return [
    MANAGED_BLOCK_BEGIN,
    "# Added by `actana harnesses install`. Edit above or below, not inside:",
    "# this block is rewritten on every install.",
    `for actana_dir in ${quoted}; do`,
    '  case ":$PATH:" in',
    '    *":$actana_dir:"*) ;;',
    '    *) [ -d "$actana_dir" ] && PATH="$actana_dir:$PATH" ;;',
    "  esac",
    "done",
    "unset actana_dir",
    "export PATH",
    MANAGED_BLOCK_END,
  ].join("\n");
}

/**
 * Splice `block` into `existing`, or return null when it is already there.
 *
 * Null rather than the unchanged text so the caller can skip the write
 * entirely — rewriting a dotfile with identical bytes on every install would
 * churn its mtime for nothing.
 */
export function applyManagedBlock(existing: string, block: string): string | null {
  const start = existing.indexOf(MANAGED_BLOCK_BEGIN);
  const end = existing.indexOf(MANAGED_BLOCK_END);

  if (start >= 0 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MANAGED_BLOCK_END.length);
    const replaced = `${before}${block}${after}`;
    return replaced === existing ? null : replaced;
  }

  const base = existing.replace(/\n*$/, "");
  const separator = base === "" ? "" : "\n\n";
  return `${base}${separator}${block}\n`;
}

/**
 * Put every declared Harness directory on the operator's login PATH.
 *
 * Never throws for a shape it does not handle: Windows has no POSIX profile to
 * write, and a registry where no agent declares a home directory has nothing
 * to add. Both are "nothing to do", not failures — this runs after a
 * successful install and must not turn one into an error.
 */
export function ensureOperatorLoginPath(
  opts: EnsureOperatorLoginPathOptions,
): EnsureOperatorLoginPathResult {
  const result: EnsureOperatorLoginPathResult = { written: [], failed: [] };
  if (opts.platform === "win32") return result;
  if (opts.suffixes.length === 0) return result;

  const block = renderManagedBlock(opts.suffixes);
  for (const profile of loginProfileNames(opts.shell, opts.exists)) {
    let existing: string;
    try {
      existing = opts.exists(profile) ? opts.read(profile) : "";
    } catch {
      result.failed.push(profile);
      continue;
    }

    const next = applyManagedBlock(existing, block);
    if (next === null) continue;

    try {
      opts.write(profile, next);
      result.written.push(profile);
    } catch {
      result.failed.push(profile);
    }
  }
  return result;
}

/**
 * {@link ensureOperatorLoginPath} against the real filesystem.
 *
 * Defaults come from the shared registry and the operator's resolved shell.
 * `homeDir` has no default on purpose: this is the one code path that writes
 * to an operator's dotfiles, so a caller names the home it means rather than
 * picking up the developer's own during a unit test.
 */
export function ensureOperatorLoginPathOnDisk(opts: {
  homeDir: string;
  platform?: NodeJS.Platform;
  shell?: string;
  suffixes?: readonly string[];
}): EnsureOperatorLoginPathResult {
  const platform = opts.platform ?? os.platform();
  const resolved = (name: string) => path.join(opts.homeDir, name);

  return ensureOperatorLoginPath({
    platform,
    shell: opts.shell ?? resolveShell(),
    suffixes: opts.suffixes ?? harnessHomePathSuffixes(platform),
    exists: (name) => fs.existsSync(resolved(name)),
    read: (name) => fs.readFileSync(resolved(name), "utf8"),
    write: (name, text) => fs.writeFileSync(resolved(name), text, { mode: 0o644 }),
  });
}
