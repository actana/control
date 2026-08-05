// Installing a harness's lifecycle hooks so they report to THIS Core.
//
// A harness is a vendor's program (CONTEXT.md "Harness"); the only handle we
// have on what it is doing is the lifecycle hooks it offers, configured through
// a file in the workspace. This module writes those files at spawn time, one
// writer per harness family, and every per-harness difference stays inside this
// Core process — the Panel learns only whether hooks went in (issue 84).
//
// Three rules the writers share:
//
//  - An operator's own hooks are preserved. Ours are tagged `_mcManaged: true`
//    so the next spawn replaces exactly what a previous spawn wrote and nothing
//    else. A workspace is the operator's, not ours.
//  - The command carries no secret. It reads `$AC_HOOK_URL` and
//    `$AC_HOOK_TOKEN` out of the PTY's environment, so the file on disk stays
//    valid across a Core restart that mints a new token, and a token never
//    lands in a file the operator might commit.
//  - It is fail-soft (`|| true`). A hook that blocks or fails must never take
//    the operator's session down with it; a missed hook costs a stale card,
//    which the PTY-exit settle and the terminal-input fallback still catch.
//
// The registry is open by construction: a harness with no entry simply gets no
// hooks and reports `installed: false`, which is what tells the Panel to keep
// its terminal-input fallback armed for that Session.

import * as path from "node:path";
import {
  readJsonSettingsFile,
  writeJsonSettingsFile,
} from "@actana/shared/json-settings-file";
import { hookEndpointSlug } from "@actana/shared/mission-control-hook-env";

/** Marks an entry this Core wrote, so the next spawn can replace just those. */
const MANAGED_FLAG = "_mcManaged";

/** Env var names the hook command reads. Set on the PTY by the spawn path. */
export const HOOK_URL_ENV = "AC_HOOK_URL";
export const HOOK_TOKEN_ENV = "AC_HOOK_TOKEN";
export const HOOK_TASK_ID_ENV = "AC_HOOK_TASK_ID";

/**
 * The shell command a managed hook entry runs: POST the payload the harness
 * pipes on stdin to this Core's loopback receiver, tagged with the task it
 * belongs to. Short timeout and `|| true` — see the fail-soft rule above.
 */
export function hookCommand(slug: string): string {
  return (
    `sh -c 'curl -sS -m 3 -X POST ` +
    `-H "Authorization: Bearer $${HOOK_TOKEN_ENV}" ` +
    `-H "Content-Type: application/json" ` +
    `--data-binary @- ` +
    `"$${HOOK_URL_ENV}/api/hooks/${slug}?taskId=$${HOOK_TASK_ID_ENV}" || true'`
  );
}

type ManagedEntry = { [MANAGED_FLAG]: true; type: "command"; command: string };

function managedEntry(slug: string): ManagedEntry {
  return { [MANAGED_FLAG]: true, type: "command", command: hookCommand(slug) };
}

function isManaged(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[MANAGED_FLAG]);
}

/**
 * Replace this Core's entries in one hook matcher list, preserving the
 * operator's. `null` in means "no list yet"; the result is always a list.
 */
function mergeMatchers(existing: unknown, ours: unknown[]): unknown[] {
  const kept = Array.isArray(existing) ? existing.filter((e) => !isManaged(e)) : [];
  return [...kept, ...ours];
}

/**
 * A Claude Code matcher group. `hooks` is the list of commands; the group
 * itself is what we tag, so a group we own is replaced wholesale and an
 * operator's group beside it is left alone.
 */
function claudeGroup(slug: string): Record<string, unknown> {
  return { [MANAGED_FLAG]: true, hooks: [managedEntry(slug)] };
}

/**
 * The Claude Code events this Core subscribes to. `Notification` is included
 * because Claude's permission prompt arrives that way; the pipeline narrows it
 * to `permission_prompt` so idle reminders do not read as `needs-input`.
 */
const CLAUDE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "SessionStart",
] as const;

function installClaudeHooks(cwd: string, slug: string): boolean {
  const file = path.join(cwd, ".claude", "settings.local.json");
  const settings = readJsonSettingsFile<{ hooks?: Record<string, unknown>; [k: string]: unknown }>(
    file,
  );
  // A read that failed for any reason other than "not there yet" must not be
  // clobbered — the operator's settings are not ours to lose.
  if (settings === null) return false;
  const hooks: Record<string, unknown> = { ...(settings.hooks as object) };
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = mergeMatchers(hooks[event], [claudeGroup(slug)]);
  }
  settings.hooks = hooks;
  return writeJsonSettingsFile(file, settings);
}

const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "PermissionRequest"] as const;

function installCodexHooks(cwd: string, slug: string): boolean {
  const file = path.join(cwd, ".codex", "hooks.json");
  const config = readJsonSettingsFile<{ hooks?: Record<string, unknown>; [k: string]: unknown }>(
    file,
  );
  if (config === null) return false;
  const hooks: Record<string, unknown> = { ...(config.hooks as object) };
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = mergeMatchers(hooks[event], [managedEntry(slug)]);
  }
  config.hooks = hooks;
  return writeJsonSettingsFile(file, config);
}

const CURSOR_HOOK_EVENTS = ["beforeSubmitPrompt", "stop", "afterAgentResponse"] as const;

function installCursorHooks(cwd: string, slug: string): boolean {
  const file = path.join(cwd, ".cursor", "hooks.json");
  const config = readJsonSettingsFile<{
    version?: number;
    hooks?: Record<string, unknown>;
    [k: string]: unknown;
  }>(file);
  if (config === null) return false;
  const hooks: Record<string, unknown> = { ...(config.hooks as object) };
  for (const event of CURSOR_HOOK_EVENTS) {
    hooks[event] = mergeMatchers(hooks[event], [managedEntry(slug)]);
  }
  config.hooks = hooks;
  // Cursor CLI silently ignores a hooks file with no `"version": 1`.
  config.version = 1;
  return writeJsonSettingsFile(file, config);
}

/**
 * Per-harness hook writers. A harness absent from this table has no hook
 * surface we install — it is not an error, it is a Session whose status comes
 * from the PTY-exit settle and the Panel's terminal-input fallback instead.
 * Keep this open: adding a family is adding a row.
 */
const HOOK_INSTALLERS: Record<string, (cwd: string, slug: string) => boolean> = {
  "claude-code": installClaudeHooks,
  codex: installCodexHooks,
  "cursor-cli": installCursorHooks,
};

/** Does this Core know how to install hooks for `harness`? */
export function harnessSupportsHooks(harness: string | undefined): boolean {
  return Boolean(harness && harness in HOOK_INSTALLERS);
}

/**
 * Install this Core's lifecycle hooks into `cwd` for `harness`.
 *
 * Returns whether hooks are now in place and will report for a Session spawned
 * in this workspace. `false` covers both "this harness has no hook surface" and
 * "the write did not land" — from the Panel's point of view those are the same
 * fact, and the honest answer is what keeps its terminal-input fallback armed
 * rather than suppressed on a promise nobody kept (issue 84).
 */
export function installHarnessHooks(harness: string | undefined, cwd: string): boolean {
  const installer = harness ? HOOK_INSTALLERS[harness] : undefined;
  if (!installer || !cwd) return false;
  try {
    return installer(cwd, hookEndpointSlug(harness));
  } catch {
    return false;
  }
}
