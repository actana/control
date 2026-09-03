// Installing a harness's lifecycle hooks so they report to THIS Core.
//
// A harness is a vendor's program (CONTEXT.md "Harness"); the only handle we
// have on what it is doing is the lifecycle hooks it offers, configured through
// a file in the workspace. This module writes those files at spawn time, one
// writer per harness family, and every per-harness difference stays inside this
// Core process — the Panel learns only whether hooks went in (issue 84).
//
// Three of the four families take a table of shell commands, and their writers
// are a few lines each. OpenCode's takes a JavaScript plugin instead, so its
// writer lives next door in `harness-hooks-opencode.ts` (issue 230); the row it
// occupies in `HOOK_FAMILIES` is the same shape as the others'.
//
// Four rules the writers share:
//
//  - An operator's own hooks are preserved. Ours are tagged `_acManaged: true`
//    so the next spawn replaces exactly what a previous spawn wrote and nothing
//    else. A workspace is the operator's, not ours.
//  - The command carries no secret. It reads `$AC_HOOK_URL` and
//    `$AC_HOOK_TOKEN` out of the PTY's environment, so the file on disk stays
//    valid across a Core restart that mints a new token, and a token never
//    lands in a file the operator might commit.
//  - It is fail-soft (`|| true`). A hook that blocks or fails must never take
//    the operator's session down with it; a missed hook costs a stale card,
//    which the PTY-exit settle and the terminal-input fallback still catch.
//  - Fail-soft is not the same as silent (issue 243). The command checks the
//    Core's ack, retries a transient refusal, and records the ones it could
//    not deliver — see `hookCommand` below.
//
// The registry is open by construction: a harness with no entry simply gets no
// hooks, which is what tells the Panel to keep its terminal-input fallback
// armed for that Session.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  readJsonSettingsFile,
  writeJsonSettingsFile,
} from "@actana/shared/json-settings-file";
import { hookEndpointSlug } from "@actana/shared/mission-control-hook-env";
import { ASK_USER_QUESTION_TOOL } from "@actana/shared/harness-questions";
import {
  HOOK_MISS_LOG_ENV,
  HOOK_TASK_ID_ENV,
  HOOK_TOKEN_ENV,
  HOOK_URL_ENV,
} from "./harness-hook-env";
import { HARNESS_HOOK_TRUST_FLAGS } from "@actana/shared/harness-cli-config";
import type { Harness } from "@actana/shared/domain";
import { installOpencodeHooks } from "./harness-hooks-opencode";

/** Marks an entry this Core wrote, so the next spawn can replace just those. */
const MANAGED_FLAG = "_acManaged";

/**
 * The marker the retired Electron app wrote into the same files. Its entries
 * POST to an endpoint that no longer exists, so they are swept out alongside
 * ours rather than left to fail on every turn (ADR 0007 retired the `MC_`
 * prefix; this is the last place it can still be sitting on an operator's
 * disk).
 */
const LEGACY_MANAGED_FLAG = "_mcManaged";

/** Env var names the hook command reads. Set on the PTY by the spawn path. */
export {
  HOOK_URL_ENV,
  HOOK_TOKEN_ENV,
  HOOK_TASK_ID_ENV,
  HOOK_MISS_LOG_ENV,
} from "./harness-hook-env";

/**
 * The shell command a managed hook entry runs: POST the payload the harness
 * pipes on stdin to this Core's loopback receiver, tagged with the task it
 * belongs to. Short timeout and a `|| true` at the end — see the fail-soft
 * rule above.
 *
 * The event name rides the URL as well as the body. The writer knows which
 * event each entry is for, and naming it costs one query parameter: a payload
 * that arrives without `hook_event_name` (an older harness build, a vendor
 * that only sends it for some events) is still routable rather than silently
 * `ignored`, and every request identifies itself in a log or a `curl -v`
 * instead of being one of several indistinguishable opaque bodies. The body
 * still wins when it carries a name — the harness knows better than we do.
 *
 * The tail of the command is issue 243's ack, and every piece of it is there
 * for a failure that really happened — a Session wedged on `running` because
 * its terminal `Stop` was the POST that dropped:
 *
 *  - `-f` makes a non-2xx answer a failure. Without it curl exits 0 on a 401,
 *    a 404 and a 500 alike, so "the Core took it" was never a fact this
 *    command could act on.
 *  - `--retry 2 --retry-delay 1` retries what curl calls a transient error —
 *    a timeout above all, which is exactly what a Core busy serving PTY
 *    fan-out and SQLite writes hands a `-m 3` POST. Three attempts bound the
 *    worst case at about eleven seconds, well inside a harness's own hook
 *    timeout, and only on the path where the Session's status is already
 *    broken. `--retry-connrefused` is deliberately NOT here: it would raise
 *    the curl version this command needs, and a refused connection means the
 *    Core is down, which a second attempt a second later does not fix.
 *  - The `printf` records what could not be delivered — one tab-separated
 *    line per lost hook, drained into the Core's log by
 *    `harness-hook-delivery.ts`. The path defaults to `/dev/null`, so a
 *    workspace opened by hand (or by a Core that wired no miss log) writes
 *    nowhere rather than failing.
 *  - `|| true` still ends the chain, and still means the same thing: when the
 *    POST succeeds the chain short-circuits, when it fails the record is
 *    written, and when the record cannot be written the command still exits 0.
 *    A hook may never fail an operator's turn.
 *
 * `-o /dev/null` is new too, and not cosmetic: Claude Code reads a hook's
 * stdout as control JSON, so the receiver's answer had no business being
 * printed there.
 */
export function hookCommand(slug: string, event: string): string {
  return (
    `sh -c 'curl -sS -f -m 3 --retry 2 --retry-delay 1 -o /dev/null -X POST ` +
    `-H "Authorization: Bearer $${HOOK_TOKEN_ENV}" ` +
    `-H "Content-Type: application/json" ` +
    `--data-binary @- ` +
    `"$${HOOK_URL_ENV}/api/hooks/${slug}` +
    `?taskId=$${HOOK_TASK_ID_ENV}&hookEvent=${encodeURIComponent(event)}"; ` +
    `s=$?; [ "$s" = 0 ] || ` +
    `printf "%s\\t%s\\t%s\\t%s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ` +
    `"$${HOOK_TASK_ID_ENV}" "${event}" "$s" ` +
    `>> "$\{${HOOK_MISS_LOG_ENV}:-/dev/null}" || true'`
  );
}

type ManagedEntry = { [MANAGED_FLAG]: true; type: "command"; command: string };

function managedEntry(slug: string, event: string): ManagedEntry {
  return { [MANAGED_FLAG]: true, type: "command", command: hookCommand(slug, event) };
}

function isManaged(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return Boolean(entry[MANAGED_FLAG] || entry[LEGACY_MANAGED_FLAG]);
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
function claudeGroup(slug: string, event: string, matcher?: string): Record<string, unknown> {
  return {
    [MANAGED_FLAG]: true,
    ...(matcher ? { matcher } : {}),
    hooks: [managedEntry(slug, event)],
  };
}

/**
 * The Claude Code events this Core subscribes to, and how narrowly.
 *
 * `Notification` is included because Claude's permission prompt arrives that
 * way; the pipeline narrows it to `permission_prompt` so idle reminders do not
 * read as `needs-input`.
 *
 * The two tool hooks are where the matcher earns its keep, and the two are
 * deliberately asymmetric:
 *
 *  - `PreToolUse` is matched to `AskUserQuestion`. That is the only tool
 *    either host does anything with — it is what raises `needs-input` and the
 *    Panel's question overlay — so an unmatched subscription would spawn a
 *    `curl` per tool call to learn nothing.
 *  - `PostToolUse` is deliberately UNMATCHED, and costs one `curl` per tool
 *    call. It is what heals a stale `needs-input`: Claude fires no hook when
 *    an operator GRANTS a permission, so without a signal that some tool ran,
 *    a granted permission leaves the card claiming `needs-input` until the
 *    turn's `Stop` — precisely the drift this issue exists to remove. One
 *    subprocess per tool call is the price of that, knowingly paid.
 */
const CLAUDE_HOOK_EVENTS: readonly { name: string; matcher?: string }[] = [
  { name: "UserPromptSubmit" },
  { name: "Stop" },
  { name: "SubagentStart" },
  { name: "SubagentStop" },
  { name: "PreToolUse", matcher: ASK_USER_QUESTION_TOOL },
  { name: "PostToolUse" },
  { name: "Notification" },
  { name: "SessionStart" },
];

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
    hooks[event.name] = mergeMatchers(hooks[event.name], [
      claudeGroup(slug, event.name, event.matcher),
    ]);
  }
  settings.hooks = hooks;
  return writeJsonSettingsFile(file, settings);
}

const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "PermissionRequest"] as const;

/**
 * A Codex matcher group — the same shape as {@link claudeGroup}, and the fix
 * for the first half of issue 290.
 *
 * Codex's hooks file is a table of **matcher groups**, not of handlers:
 * `{"hooks": {"Stop": [{"hooks": [{"type": "command", ...}]}]}}`. Until this
 * issue we wrote the handler where the group belongs — one level too shallow —
 * and the difference is not cosmetic and not partial. Codex parses the file,
 * finds nothing it recognises, and reports no error: the workspace has a hooks
 * file, the Core believes it installed hooks, and Codex has zero of them. It
 * never even reaches the startup review the second half of this issue is
 * about; verified against codex-cli 0.153.0, where the flat file produces no
 * hook on any turn under every combination of workspace trust and
 * `--dangerously-bypass-hook-trust`, and the group file produces "2 hooks are
 * new or changed" on the same workspace.
 *
 * The `_acManaged` tag moves out to the group with everything else, which is
 * where {@link isManaged} already looks — so the next spawn replaces the group
 * this one wrote, and a flat entry left behind by a Core from before this
 * issue is swept out by the same rule rather than left in a file Codex is
 * ignoring anyway.
 *
 * No `matcher` key. Codex applies a group with none to every occurrence of the
 * event, which is what all three of our events want: there is nothing to
 * narrow `Stop` or `UserPromptSubmit` to, and `PermissionRequest` is wanted
 * whatever raised it.
 */
function codexGroup(slug: string, event: string): Record<string, unknown> {
  return { [MANAGED_FLAG]: true, hooks: [managedEntry(slug, event)] };
}

function installCodexHooks(cwd: string, slug: string): boolean {
  const file = path.join(cwd, ".codex", "hooks.json");
  const config = readJsonSettingsFile<{ hooks?: Record<string, unknown>; [k: string]: unknown }>(
    file,
  );
  if (config === null) return false;
  const hooks: Record<string, unknown> = { ...(config.hooks as object) };
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = mergeMatchers(hooks[event], [codexGroup(slug, event)]);
  }
  config.hooks = hooks;
  return writeJsonSettingsFile(file, config);
}

/**
 * Does this workspace carry a Codex hook source THIS Core did not write?
 *
 * The question behind `hookTrustBypassEarned`, and the reason that field is
 * not simply `installed`. Codex's startup review exists to stop hooks that
 * arrived with a repository from running unseen — a cloned project with a
 * committed `.codex/hooks.json` whose `UserPromptSubmit` is `curl … | sh` is
 * the case it is for. Lifting that review for OUR entries is defensible: this
 * process wrote them, from a table in this repository, seconds ago. Lifting it
 * for somebody else's is not, and `mergeMatchers` deliberately preserves
 * somebody else's — a workspace is the operator's, not ours.
 *
 * So the audit is over the file as it stands AFTER our write, and it is
 * deliberately conservative in every direction it can be:
 *
 *  - Any hook entry not tagged `_acManaged` / `_mcManaged`, under any event,
 *    is foreign. One is enough.
 *  - A `.codex/config.toml` in the workspace disqualifies it outright. That
 *    file can declare hooks of its own, it is TOML, and this repository has no
 *    TOML parser — so its mere existence is read as "there may be hooks here
 *    we cannot account for". An operator who wants the bypass back can move
 *    those hooks into `~/.codex/config.toml`, which is theirs rather than the
 *    repository's.
 *  - A file we could not read at all is foreign. Unreadable is not empty.
 *
 * What it cannot see is a Codex plugin supplying hooks from outside the
 * workspace. That is a real edge, and the honest consequence is stated rather
 * than hidden: this narrows the bypass to the common case and does not claim
 * to enumerate every hook source Codex has.
 */
function codexHasForeignHookSources(cwd: string): boolean {
  if (fs.existsSync(path.join(cwd, ".codex", "config.toml"))) return true;
  const config = readJsonSettingsFile<{ hooks?: Record<string, unknown> }>(
    path.join(cwd, ".codex", "hooks.json"),
  );
  // `null` is a read that failed for a reason other than "not there yet".
  if (config === null) return true;
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) {
      // A shape we do not understand is a shape we cannot vouch for.
      return true;
    }
    if (entries.some((entry) => !isManaged(entry))) return true;
  }
  return false;
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
    hooks[event] = mergeMatchers(hooks[event], [managedEntry(slug, event)]);
  }
  config.hooks = hooks;
  // Cursor CLI silently ignores a hooks file with no `"version": 1`.
  config.version = 1;
  return writeJsonSettingsFile(file, config);
}

type HookFamily = {
  install: (cwd: string, slug: string) => boolean;
  /**
   * Do the hooks we install for this family actually fire when a turn STARTS?
   *
   * Installing is not reporting, and the difference is the whole point of this
   * field. The Panel stands its terminal-input fallback down on the answer, so
   * a family that takes our hook file but never fires a turn-start event must
   * say `false` — otherwise its Sessions sit on `ready` for the entire first
   * turn with nothing to move them.
   */
  reportsTurnStart: boolean;
  /**
   * For a family whose CLI holds new hooks at a trust review
   * (`HARNESS_CLI_CONFIG[...].hookTrustFlag`): does this workspace carry a
   * hook source this Core did not write?
   *
   * Present only where the question can be asked, which is the same set as
   * `hookTrustFlag` — a family with no review has nothing to lift and no
   * reason to audit. Missing here and a flag over there is a family that gets
   * NO bypass, which is the safe direction to fall.
   */
  foreignHookSources?: (cwd: string) => boolean;
};

/**
 * Per-harness hook writers. A harness absent from this table has no hook
 * surface we install — it is not an error, it is a Session whose status comes
 * from the PTY-exit settle and the Panel's terminal-input fallback instead.
 * Keep this open: adding a family is adding a row.
 */
const HOOK_FAMILIES: Record<string, HookFamily> = {
  "claude-code": { install: installClaudeHooks, reportsTurnStart: true },
  // Codex held newly-installed project hooks behind an operator's `/hooks`
  // review, so its first turn — the one that matters most for the card, and
  // the only one an orchestrator is ever waiting on — reported nothing at all.
  // Issue 290 fixed that in two places, and NEITHER of them is here: the
  // writer above now produces the matcher groups Codex actually parses, and
  // every Codex launch carries `hookTrustFlag` so the hooks this Core wrote
  // run without being held for review. Both halves were needed; either alone
  // still reports nothing.
  //
  // `reportsTurnStart` stays `false` deliberately. `UserPromptSubmit` does now
  // fire — verified on codex-cli 0.153.0 in a workspace Codex had never seen —
  // so `true` would today be honest rather than hopeful. But this field is
  // what stands the Panel's terminal-input fallback DOWN, and flipping it is a
  // change to what the Panel does rather than to whether a hook arrives. It
  // belongs with the codex readiness row (#277), not smuggled in behind a
  // hooks fix: `false` costs a card that under-reports a live turn, and `true`
  // asserted a turn early costs a Session with no `running` signal at all.
  codex: {
    install: installCodexHooks,
    reportsTurnStart: false,
    foreignHookSources: codexHasForeignHookSources,
  },
  // Cursor takes the hooks file and fires `stop` / `sessionStart` from it, but
  // `beforeSubmitPrompt` still does not fire in cursor-agent. The turn's end is
  // reported; its start is not.
  "cursor-cli": { install: installCursorHooks, reportsTurnStart: false },
  // OpenCode's extension point is a plugin rather than a JSON hooks file,
  // which is why it went without status reporting through #84 and #101 and
  // into #230. `harness-hooks-opencode.ts` writes that plugin. It reports a
  // turn's start honestly — `chat.message` fires on the user's message and
  // `session.status` goes `busy` — which is the one thing that earns a family
  // the right to stand the Panel's fallback down.
  opencode: { install: installOpencodeHooks, reportsTurnStart: true },
};

/**
 * Does `harness`'s CLI hold newly-installed hooks at a trust review?
 *
 * Read off `HARNESS_CLI_CONFIG`, never restated: `harness` arrives here as a
 * plain string from the spawn path, so an id that is not a Harness at all
 * answers `false` rather than indexing out of the table.
 */
function hasHookTrustReview(harness: string): boolean {
  return (HARNESS_HOOK_TRUST_FLAGS[harness as Harness] ?? null) !== null;
}

/** Does this Core know how to install hooks for `harness`? */
export function harnessSupportsHooks(harness: string | undefined): boolean {
  return Boolean(harness && harness in HOOK_FAMILIES);
}

export type HookInstallResult = {
  /** Did a hook file land in the workspace? */
  installed: boolean;
  /**
   * Will a hook report the start of a turn for this Session? Only this
   * exempts the Panel's terminal-input fallback (issue 84) — it is the
   * conjunction of "we wrote the file" and "this family fires on turn start",
   * and either one alone is a Session with no `running` signal.
   */
  reportsTurnStart: boolean;
  /**
   * May this spawn carry the harness's hook-trust bypass flag?
   *
   * The third state issue 290 asked for, in the shape the evidence turned out
   * to need: not "written but not yet live", which the file-shape fix removed,
   * but **"written, and nothing else was"**. `installed` answers "did a file
   * land"; this answers "is every hook Codex will run one this Core wrote".
   * Only the second earns lifting the vendor's review, and the two come apart
   * on the case that matters — a cloned repository shipping its own
   * `.codex/hooks.json`, which `mergeMatchers` preserves on purpose.
   *
   * `false` for every family with no hook-trust flag, because there is nothing
   * to lift; `false` whenever no file landed, because a Core that wrote
   * nothing has vetted nothing.
   */
  hookTrustBypassEarned: boolean;
};

const NO_HOOKS: HookInstallResult = {
  installed: false,
  reportsTurnStart: false,
  hookTrustBypassEarned: false,
};

/**
 * Install this Core's lifecycle hooks into `cwd` for `harness`.
 *
 * A failed write reports the same as an unsupported harness: from the Panel's
 * point of view those are one fact, and the honest answer is what keeps its
 * fallback armed rather than suppressed on a promise nobody kept.
 */
export function installHarnessHooks(
  harness: string | undefined,
  cwd: string,
): HookInstallResult {
  const family = harness ? HOOK_FAMILIES[harness] : undefined;
  if (!family || !cwd) return NO_HOOKS;
  let installed = false;
  try {
    installed = family.install(cwd, hookEndpointSlug(harness));
  } catch {
    return NO_HOOKS;
  }
  // Audited AFTER the write, over the file as Codex will read it: our entries
  // are in it by now, and so is anything the repository shipped that
  // `mergeMatchers` preserved.
  let hookTrustBypassEarned = false;
  // Two tables have to agree for a bypass to be earned: the vendor fact that
  // this CLI holds new hooks at a review at all, and a writer here that can
  // say whether anything foreign is in the file. Either one missing answers
  // `false`, so a family that grows one half without the other gets no
  // bypass rather than an unaudited one.
  if (installed && hasHookTrustReview(harness ?? "") && family.foreignHookSources) {
    try {
      hookTrustBypassEarned = !family.foreignHookSources(cwd);
    } catch {
      // An audit that threw answers "cannot vouch", never "nothing found".
      hookTrustBypassEarned = false;
    }
  }
  return {
    installed,
    reportsTurnStart: installed && family.reportsTurnStart,
    hookTrustBypassEarned,
  };
}
