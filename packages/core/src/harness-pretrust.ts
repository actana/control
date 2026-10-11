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
//   codex hooks  `~/.codex/config.toml`  `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]
//                trusted_hash = "sha256:<hex>"`, one per hook this Core installs (`trustCodexHooks`:
//                codex asks to trust hooks it has not seen, and this is what answering it writes)
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

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { hookEndpointSlug } from "@actana/shared/mission-control-hook-env";
import { canonicalJson, codexGroup, CODEX_HOOK_EVENTS } from "./harness-hooks";

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

// ─── Codex hook trust ────────────────────────────────────────────────

/**
 * The codex version whose hook hash this file reproduces (codex-rs `hooks/src/engine/discovery.rs` `hook_hash`
 * and `config/src/fingerprint.rs` `version_for_toml`, tag rust-v0.160.0). Checked against three entries codex
 * itself wrote for the hooks this Core installed at the time (permission_request 777d6667, user_prompt_submit
 * f23db2db, stop 0fc32051; the command has since grown `&pid=$PPID`, issue 460, and the test hashes the text
 * codex reviewed). A newer codex may normalise differently; a hash that does not match only makes codex ask
 * again.
 */
export const CODEX_HOOK_HASH_VERIFIED = "0.160.0";

/** codex's `hook_event_key_label`: the event as it is spelled in a hook's key and in its hashed identity. */
const CODEX_EVENT_LABELS: Readonly<Record<string, string>> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
};

const DEFAULT_HOOK_TIMEOUT_SEC = 600;

/** `JSON.stringify` of `value` with every object's keys sorted, which is what codex's `canonical_json` hashes. */
function canonicalJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

/**
 * The `trusted_hash` codex computes for one command hook: SHA-256 of the compact, key-sorted JSON of the
 * normalised identity `{event_name, matcher?, hooks: [{type, command, timeout, async, statusMessage?}]}`.
 * Unset options are left out (codex serialises through TOML, which has no null); `timeout` defaults to 600
 * seconds; `matcher` is left out when the group has none (ours never do).
 */
export function codexHookHash(
  event: string,
  handler: { command: string; timeout?: number; async?: boolean; statusMessage?: string },
  matcher?: string,
): string | null {
  const label = CODEX_EVENT_LABELS[event];
  if (!label) return null;
  const timeout = Math.max(1, Math.floor(handler.timeout ?? DEFAULT_HOOK_TIMEOUT_SEC));
  const identity = {
    event_name: label,
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: handler.command,
        timeout,
        async: handler.async === true,
        ...(handler.statusMessage ? { statusMessage: handler.statusMessage } : {}),
      },
    ],
  };
  return `sha256:${createHash("sha256").update(canonicalJsonText(identity)).digest("hex")}`;
}

/** The `hooks.state` key codex gives a hook: the hooks file, the event, the group's index, the handler's index. */
export function codexHookKey(hooksFile: string, event: string, group: number, handler: number): string | null {
  const label = CODEX_EVENT_LABELS[event];
  return label ? `${hooksFile}:${label}:${group}:${handler}` : null;
}

/**
 * The hooks this Core installed in `hooksFile`, as `[key, hash]`, read off the file as codex will read it.
 *
 * Only a group that equals, exactly, what `installHarnessHooks` writes for an event in `CODEX_HOOK_EVENTS`
 * (`codexGroup(slug, event)`: our marker, one command handler with our command and no other option) is trusted.
 * The Core's side is rebuilt here rather than read from the `_acManaged` flag, which a repository's file can carry
 * on anything, under any event, with any command (the principle of `codexOwnsEveryHook`).
 */
export function ownedCodexHookTrust(hooksFile: string, files: readonly string[] = [hooksFile], slug = hookEndpointSlug("codex")): [string, string][] {
  const raw = readIfExists(hooksFile);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const events = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!events || typeof events !== "object") return [];
  const out: [string, string][] = [];
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = events[event];
    if (!Array.isArray(groups)) continue;
    const ours = codexGroup(slug, event);
    const expected = canonicalJson(ours);
    const handler = (ours.hooks as { command: string }[])[0]!;
    const hash = codexHookHash(event, { command: handler.command });
    if (!hash) continue;
    groups.forEach((group, g) => {
      if (canonicalJson(group) !== expected) return;
      for (const file of files) {
        const key = codexHookKey(file, event, g, 0);
        if (key) out.push([key, hash]);
      }
    });
  }
  return out;
}

/** The key a `[hooks.state."<key>"]` header names, or null when it is some other table. */
function hookStateHeaderKey(line: string): string | null {
  const m = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const quoted = m[1]!;
  if (quoted.startsWith("'")) return quoted.slice(1, -1);
  return quoted.slice(1, -1).replace(/\\(["\\btnfr])/g, (_all, c: string) => TOML_BASIC_ESCAPES[c]!);
}

/** The parts of a TOML dotted key (`a."b.c".d` -> `["a", "b.c", "d"]`), or null when it is not one this scanner reads. */
function tomlKeyPath(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (text[i] === " " || text[i] === "\t") i++;
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          out += TOML_BASIC_ESCAPES[text[j + 1]!] ?? text[j + 1]!;
          j += 2;
        } else out += text[j++];
      }
      if (text[j] !== '"') return null;
      parts.push(out);
      i = j + 1;
    } else if (ch === "'") {
      const j = text.indexOf("'", i + 1);
      if (j === -1) return null;
      parts.push(text.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] === ".") {
      i++;
      continue;
    }
    return parts;
  }
}

/**
 * Why this config cannot take `[hooks.state."key"]` tables appended to it, or null when it can.
 *
 * Table-aware: only a `hooks` key at the top of the file, a `state` key inside `[hooks]`, or a bare
 * `[hooks.state]` table (also written dotted or quoted) define `hooks.state` some other way (an inline table, dotted
 * keys), and a second `[hooks.state."k"]` beside any of them is invalid TOML that codex cannot load. A `hooks` key
 * in another table is something else and is ignored: `[features] hooks = true` is codex's own switch for
 * `--enable hooks`.
 */
export function hookStateConflict(lines: readonly string[]): string | null {
  let table: string[] = [];
  for (const line of lines) {
    const header = /^\s*(\[\[?)\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header && !/^\s*[A-Za-z0-9_"'-]+[^\]]*=/.test(line)) {
      table = tomlKeyPath(header[2]!) ?? ["?"];
      if (table[0] === "hooks" && table[1] === "state" && table.length === 2) return "a [hooks.state] table";
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || /^\s*(#|$)/.test(line)) continue;
    const key = tomlKeyPath(line.slice(0, eq));
    if (!key) continue;
    if (table.length === 0 && key[0] === "hooks") return "a top-level `hooks` key";
    if (table.length === 1 && table[0] === "hooks" && key[0] === "state") return "a `state` key in [hooks]";
  }
  return null;
}

/**
 * Record `trusted_hash` for each `[key, hash]` in `file` (`~/.codex/config.toml`), the way codex records it when
 * its hook review is answered. Idempotent, keeps every other key (including a table's own `enabled`), writes
 * atomically, and leaves a file it cannot edit alone and says so.
 */
export function trustCodexHooks(file: string, entries: readonly (readonly [string, string])[]): "written" | "unchanged" {
  if (entries.length === 0) return "unchanged";
  const raw = readIfExists(file) ?? "";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  const conflict = hookStateConflict(lines);
  if (conflict) throw new Error(`${file} defines "hooks.state" as ${conflict}, a form this writer does not edit`);
  let changed = false;
  for (const [key, hash] of entries) {
    const header = lines.findIndex((line) => hookStateHeaderKey(line) === key);
    const want = `trusted_hash = ${tomlQuote(hash)}`;
    if (header === -1) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`[hooks.state.${tomlQuote(key)}]`, want, "");
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
    const at = lines.findIndex((line, i) => i > header && i < end && /^\s*trusted_hash\s*=/.test(line));
    if (at === -1) {
      lines.splice(header + 1, 0, want);
      changed = true;
    } else if (/^\s*trusted_hash\s*=\s*"([^"]*)"/.exec(lines[at]!)?.[1] !== hash) {
      lines[at] = want;
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
