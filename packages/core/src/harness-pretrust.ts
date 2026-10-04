// Pre-trusting the Session workspace in a Harness's own config (#685).
//
// A Harness that has not been told it may work in a folder opens a first-run
// dialog before its composer, and nothing types into a dialog. Each writer here
// records the trust the way the Harness records it itself, so that dialog never
// opens:
//
//   claude-code  `~/.claude.json`  `projects[<dir>].hasTrustDialogAccepted = true`
//                (the entry Claude Code 2.1.289 writes after "Yes, I trust this
//                folder"; read off a real `~/.claude.json` after a manual trust)
//   codex        `~/.codex/config.toml`  `[projects."<dir>"] trust_level = "trusted"`
//                (documented key; `"trusted" | "untrusted"`)
//
//   cursor-cli   `~/.cursor/projects/<slug>/.workspace-trusted`, a JSON object
//                `{ "trustedAt": <ISO time>, "workspacePath": <dir> }`
//                (cursor-agent 2026.10.01-e373342: trusting /home/core by hand
//                created `~/.cursor/projects/home-core/.workspace-trusted`; its
//                `--trust` flag is headless-only, so the marker is the mechanism)
//
// Pi has no writer on purpose: its trust is answered by the global extension
// (ADR 0040).
//
// Every writer is idempotent (an already-trusted dir writes nothing), keeps every
// other key, and writes a temp file beside the target before renaming it over, so
// a reader never sees half a file. A file it cannot parse is left alone and
// reported: overwriting someone's config to add a trust line is the wrong trade.
// This code runs as `core` in the helper (`core-home-ops`), never in the daemon.

import * as fs from "node:fs";
import * as path from "node:path";

export type PretrustOutcome = "written" | "unchanged" | "failed";

export type PretrustResult = {
  harness: (typeof PRETRUST_HARNESSES)[number];
  outcome: PretrustOutcome;
  /** The reason, for `failed`. */
  detail?: string;
};

/** The Harnesses that have a writer. Anything else is not pre-trusted. */
export const PRETRUST_HARNESSES = ["claude-code", "codex", "cursor-cli"] as const;

export function claudeConfigPath(home: string): string {
  return path.join(home, ".claude.json");
}

export function codexConfigPath(home: string): string {
  return path.join(home, ".codex", "config.toml");
}

/** Temp file in the same directory, then rename: atomic on one filesystem. */
function writeAtomic(file: string, text: string, fallbackMode: number): void {
  // Write through a link rather than replacing it: a symlinked config is the
  // user's arrangement, and the confinement check has already followed it.
  let target = file;
  let mode = fallbackMode;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* not there yet */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode });
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────

export function trustClaudeCode(file: string, dirs: readonly string[]): "written" | "unchanged" {
  const raw = readIfExists(file);
  let config: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== "") {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object`);
    }
    config = parsed as Record<string, unknown>;
  }
  const existing = config.projects;
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    throw new Error(`${file} has a "projects" that is not an object`);
  }
  const projects = (existing ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const dir of dirs) {
    const entry = projects[dir];
    if (entry !== undefined && (typeof entry !== "object" || entry === null || Array.isArray(entry))) {
      throw new Error(`${file} has a projects entry for ${dir} that is not an object`);
    }
    if ((entry as Record<string, unknown> | undefined)?.hasTrustDialogAccepted === true) continue;
    projects[dir] = { ...(entry as Record<string, unknown> | undefined), hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return "unchanged";
  config.projects = projects;
  writeAtomic(file, JSON.stringify(config, null, 2) + "\n", 0o600);
  return "written";
}

// ─── Codex ───────────────────────────────────────────────────────────

const TOML_BASIC_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The key a `[projects.<key>]` header names, or null when it is some other table. */
function projectHeaderKey(line: string): string | null {
  const m = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const quoted = m[1]!;
  if (quoted.startsWith("'")) return quoted.slice(1, -1);
  return quoted.slice(1, -1).replace(/\\(["\\btnfr])/g, (_all, c: string) => TOML_BASIC_ESCAPES[c]!);
}

/**
 * Anything that defines `projects` other than as `[projects."dir"]` tables (an
 * inline table, dotted keys) is a shape this line editor does not rewrite: adding
 * a second definition would make the file invalid TOML.
 */
function definesProjectsElsewhere(lines: readonly string[]): boolean {
  return lines.some((line) => /^\s*projects\s*[=.]/.test(line) || /^\s*\[\s*projects\s*\]/.test(line));
}

export function trustCodex(file: string, dirs: readonly string[]): "written" | "unchanged" {
  const raw = readIfExists(file) ?? "";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  if (definesProjectsElsewhere(lines)) {
    throw new Error(`${file} defines "projects" in a form this writer does not edit`);
  }
  let changed = false;
  for (const dir of dirs) {
    const header = lines.findIndex((line) => projectHeaderKey(line) === dir);
    if (header === -1) {
      // One blank line between the old text and the new table (`""` last means the
      // file already ended in a newline).
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`[projects.${tomlQuote(dir)}]`, 'trust_level = "trusted"', "");
      changed = true;
      continue;
    }
    let end = lines.length;
    for (let i = header + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    const level = lines.findIndex((line, i) => i > header && i < end && /^\s*trust_level\s*=/.test(line));
    if (level === -1) {
      lines.splice(header + 1, 0, 'trust_level = "trusted"');
      changed = true;
    } else if (!/^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/.test(lines[level]!)) {
      lines[level] = 'trust_level = "trusted"';
      changed = true;
    }
  }
  if (!changed) return "unchanged";
  let text = lines.join(eol);
  if (!text.endsWith(eol)) text += eol;
  writeAtomic(file, text, 0o600);
  return "written";
}

// ─── Cursor CLI ──────────────────────────────────────────────────────

/**
 * The directory name Cursor gives a workspace: the absolute path with the leading
 * slash dropped and every other slash turned into a dash (`/home/core` ->
 * `home-core`). **The mapping is not injective**: a dash already in the path stays
 * a dash, so `/home/a-b` and `/home/a/b` are both `home-a-b`. Cursor itself has
 * that ambiguity; the marker's `workspacePath` is what tells them apart, and an
 * existing marker is never overwritten, so the second of two colliding paths is
 * simply not written (it is reported as unchanged and the setup check still
 * catches a dialog that shows).
 */
export function cursorProjectSlug(dir: string): string {
  return dir.replace(/^\/+/, "").replace(/\//g, "-");
}

export function cursorMarkerPath(home: string, dir: string): string {
  return path.join(home, ".cursor", "projects", cursorProjectSlug(dir), ".workspace-trusted");
}

/**
 * Write the marker for each dir that has none. An existing marker, whatever it
 * holds, is left alone: it is Cursor's (or the operator's) record, and the file is
 * created with a hard link so a marker that appears between the check and the write
 * is not replaced either.
 */
export function trustCursor(home: string, dirs: readonly string[], now: () => Date = () => new Date()): "written" | "unchanged" {
  let changed = false;
  for (const dir of dirs) {
    if (!path.isAbsolute(dir) || cursorProjectSlug(dir) === "") continue;
    const marker = cursorMarkerPath(home, dir);
    if (fs.existsSync(marker)) continue;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    const temp = `${marker}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ trustedAt: now().toISOString(), workspacePath: dir }, null, 2), {
        encoding: "utf8",
        mode: 0o644,
      });
      fs.linkSync(temp, marker);
      changed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  return changed ? "written" : "unchanged";
}

// ─── both ────────────────────────────────────────────────────────────

/**
 * Trust `dirs` in each of `harnesses` that has a writer. One Harness failing does
 * not stop the next; the failure is the result, not a throw.
 */
export function pretrustWorkspaces(
  home: string,
  harnesses: readonly string[],
  dirs: readonly string[],
): PretrustResult[] {
  const results: PretrustResult[] = [];
  for (const harness of PRETRUST_HARNESSES) {
    if (!harnesses.includes(harness)) continue;
    try {
      const outcome =
        harness === "claude-code"
          ? trustClaudeCode(claudeConfigPath(home), dirs)
          : harness === "codex"
            ? trustCodex(codexConfigPath(home), dirs)
            : trustCursor(home, dirs);
      results.push({ harness, outcome });
    } catch (err) {
      results.push({ harness, outcome: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
