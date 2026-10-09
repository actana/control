// Harness status detection, on the Core.
//
// Every step of a harness's work reaches this file: a hook posted to the
// Core's loopback receiver, or the PTY exiting. Each one becomes a write on
// this Core's own session row through {@link CoreSessionWriter}, which appends the
// matching event, which is what the Panel's live card re-renders from — no
// round trip through the Panel, and no Panel needed for the write to happen
// at all (issue 84).
//
// The decisions are not made here. They are in
// `@actana/shared/harness-hook-pipeline`, the same tuned state machine the
// Panel runs for its own rows, so the Stop-downgrade, the recent-finish heal
// and the drain backstop behave identically on both sides.

import log from "@actana/shared/log";
import {
  handleHarnessHookEvent,
  hookResultResponse,
  type HarnessHookBody,
} from "@actana/shared/harness-hook-pipeline";
import { HARNESS_HOOK_EVENTS } from "@actana/shared/harness-hook-events";
import { hookEndpointSlug } from "@actana/shared/mission-control-hook-env";
import type { CoreLinkSessionStatus } from "@actana/sdk/core";
import type { CoreSessionWriter } from "./core-session-writer";
import {
  openProcessTable,
  verifyHookProcess,
  type HookForeignReason,
  type HookOrigin,
  type ProcessEntryReader,
} from "./harness-hook-origin";

export type CoreHarnessStatusDeps = {
  writer: CoreSessionWriter;
  /**
   * Name an unnamed Session from the prompt that started its turn. Optional so
   * a Core with no generator wired (tests) still moves status.
   */
  generateTitle?: (sessionId: string, prompt: string) => void;
  /**
   * The pid this Core spawned for the Session — the root of its process tree
   * — or null when it runs none (`PtyCore.spawnedPidForSession`). Every hook
   * over the wire is held to a place under it (issue 460). Required: a Core
   * that could not answer would take a nested harness's hooks as the
   * Session's own, which is the bug.
   */
  spawnedPid: (sessionId: string) => number | null;
  /**
   * The platform's process table, read for a hook whose reported pid is not
   * the root itself. Defaults to the real one, opened once per hook; tests
   * supply a table of their own.
   */
  readProcess?: ProcessEntryReader;
};

/**
 * The program that has been running a Session's hooks, as the last owned
 * verdict found it, keyed to the root it was found under so a new spawn
 * (a new root) starts over. In memory only: the Core's PTYs do not outlive
 * the Core, so neither does this.
 */
type BoundHarness = { rootPid: number; harnessPid: number };

/**
 * Does an accepted hook answer count as the Session's harness talking?
 *
 * The quiet-Session backstop (issue 243) and the idle rule (issue 391) take an
 * accepted hook as proof of life. A hook the pipeline dropped as another
 * session's (`foreign-session`), or one the origin check dropped as another
 * process's (`foreign-process`, issue 460), is not that proof: neither came
 * from the harness process this Session owns. `ok` is already false for a
 * row this Core does not have.
 */
export function hookEvidencesSession(result: { ok: boolean; body: Record<string, unknown> }): boolean {
  if (!result.ok) return false;
  const ignored = result.body?.ignored;
  return ignored !== "foreign-session" && ignored !== "foreign-process";
}

/**
 * The Core's harness-status service. One instance per Core process; the hook
 * receiver and the PTY exit path both call it.
 */
export class CoreHarnessStatus {
  private readonly boundHarness = new Map<string, BoundHarness>();

  constructor(private readonly deps: CoreHarnessStatusDeps) {}

  /**
   * Apply a hook payload to the session it names. The answer is what the receiver
   * writes back to the harness — a shape the harness ignores, but a `404` is
   * how an operator reading `curl -v` learns the session is gone.
   *
   * `origin` is present for a hook that arrived over the wire and absent for
   * the Core's own synthetic events (PTY exit, output signals), which have no
   * process to prove. With it, the hook is held to the harness this Core
   * spawned for the Session BEFORE the pipeline sees it (issue 460,
   * `harness-hook-origin.ts`): a hook from any other process — a harness
   * nested inside the Session's PTY, running the same hook file with the same
   * inherited env — is acked and dropped as `foreign-process`, so it captures
   * no session id, moves no status, and settles nothing. Acked, not refused:
   * the nested harness's `curl -f` would otherwise record a delivery miss for
   * a hook the Core heard perfectly well and chose not to act on.
   *
   * The family in the URL is held to the row's harness first. A hook file is
   * per workspace and the env is per PTY, so a Codex started inside a Claude
   * Code Session posts `/api/hooks/codex` under the Claude Session's id; that
   * needs no process table to refuse.
   */
  receiveHook(
    sessionId: string,
    payload: HarnessHookBody,
    eventNameFallback = "",
    origin?: HookOrigin,
  ): { ok: boolean; body: Record<string, unknown> } {
    if (origin) {
      const verdict = this.verifyOrigin(sessionId, origin);
      if (verdict.verdict === "foreign") {
        const event = payload.hook_event_name || eventNameFallback || "";
        log.warn("harness-status.foreign-process", {
          sessionId,
          event,
          slug: origin.slug,
          pid: origin.pid,
          reason: verdict.reason,
          rootPid: this.deps.spawnedPid(sessionId),
          harnessPid: this.boundHarness.get(sessionId)?.harnessPid ?? null,
        });
        return hookResultResponse({ outcome: "foreign-process", event });
      }
    }

    const result = handleHarnessHookEvent(
      sessionId,
      payload,
      {
        getSession: (id) => {
          const session = this.deps.writer.readSession(id);
          if (!session) return null;
          return { status: session.status, claudeSessionId: session.claudeSessionId };
        },
        updateStatus: (id, status) => this.writeStatus(id, status),
        setSessionId: (id, harnessSessionId) => {
          this.deps.writer.mutate({ op: "update", sessionId: id, claudeSessionId: harnessSessionId });
        },
        onPrompt: (id, prompt) => this.deps.generateTitle?.(id, prompt),
      },
      eventNameFallback,
    );

    return hookResultResponse(result);
  }

  /**
   * A Session's PTY exited. Routed through the same pipeline as a real hook —
   * the synthetic event the pipeline already understands — so the subagent
   * bookkeeping is dropped with the dead process and a Session that was
   * already settled keeps the status it settled on.
   *
   * This runs on every exit, whether or not a Panel is connected: the Core's
   * PTY lifecycle is not the Panel's to observe, and a Session that finished
   * while the link was down must still be `finished` when it comes back.
   */
  sessionExited(sessionId: string, exitCode: number): void {
    if (!sessionId) return;
    // The tree is gone, and with it the program that was running its hooks.
    this.boundHarness.delete(sessionId);
    this.receiveHook(sessionId, {
      hook_event_name: HARNESS_HOOK_EVENTS.sessionProcessExited,
      exit_code: exitCode,
    });
  }

  /**
   * A signal read off the PTY's output rather than a hook (issue 84).
   *
   * `interrupted` — Claude exposes no `UserInterrupt` settings hook, so an
   * operator pressing Esc mid-turn leaves the card claiming `running` with
   * nothing coming to correct it. The synthetic event maps to `interrupted`,
   * which is what Claude is: waiting for revised instructions.
   *
   * `hooks-need-review` — Codex refuses to run newly-installed project hooks
   * until the operator reviews them with `/hooks`. That is precisely the
   * moment the hooks cannot report, so the Session would sit on `running`
   * while it is in fact waiting on a human. `needs-input` says so.
   *
   * `dialog-unanswered` — prompt delivery gave up because a dialog was in the
   * way that the Core could not read (ADR 0026 D5, issue 177 finding 3). The
   * same shape as the one above and the same answer: a harness parked on a
   * question nothing is going to answer for it is waiting on a human, and
   * saying `needs-input` is the difference between a client showing a dialog
   * to attend to and a client showing a Session that appears to have hung.
   */
  outputSignal(
    sessionId: string,
    signal: "interrupted" | "hooks-need-review" | "dialog-unanswered",
  ): void {
    if (!sessionId) return;
    this.receiveHook(sessionId, {
      hook_event_name:
        signal === "interrupted"
          ? HARNESS_HOOK_EVENTS.userInterrupt
          : HARNESS_HOOK_EVENTS.permissionRequest,
    });
  }

  /**
   * Is this request from the harness this Core spawned for the Session?
   *
   * The family in the URL is held to the row's harness first; then the
   * reported pid is placed under the Session's root with the process table
   * (`verifyHookProcess`), against the program already running the Session's
   * hooks. An owned verdict (re)binds that program: a later hook from a
   * process nested under it is foreign, and one from above it — the real
   * harness, arriving after its first POSTs were lost — takes the binding
   * over, so the row can never be wedged on a nested process.
   *
   * "unverifiable" — a platform whose process table the Core cannot read —
   * is taken as owned, with a log line saying so: refusing every hook there
   * would leave a whole platform's Sessions on `ready` for ever, which is
   * worse than the exposure ADR 0020 already accepts. A row this Core does not
   * have is left to the pipeline, which answers 404 as it always did.
   */
  private verifyOrigin(
    sessionId: string,
    origin: HookOrigin,
  ): { verdict: "owned" } | { verdict: "foreign"; reason: HookForeignReason | "wrong-family" } {
    const session = this.deps.writer.readSession(sessionId);
    if (!session) return { verdict: "owned" };
    if (hookEndpointSlug(session.agent) !== origin.slug) return { verdict: "foreign", reason: "wrong-family" };

    const rootPid = this.deps.spawnedPid(sessionId);
    const bound = this.boundHarness.get(sessionId);
    const boundHarnessPid = bound && bound.rootPid === rootPid ? bound.harnessPid : null;
    const verdict = verifyHookProcess(
      origin.pid,
      rootPid,
      boundHarnessPid,
      this.deps.readProcess ?? openProcessTable(),
    );
    if (verdict.verdict === "unverifiable") {
      log.warn("harness-status.origin-unverifiable", {
        sessionId,
        pid: origin.pid,
        platform: process.platform,
      });
      return { verdict: "owned" };
    }
    if (verdict.verdict === "foreign") return verdict;
    if (rootPid !== null && verdict.harnessPid !== boundHarnessPid) {
      this.boundHarness.set(sessionId, { rootPid, harnessPid: verdict.harnessPid });
      log.info("harness-status.harness-bound", {
        sessionId,
        rootPid,
        harnessPid: verdict.harnessPid,
        previous: boundHarnessPid,
      });
    }
    return { verdict: "owned" };
  }

  private writeStatus(sessionId: string, status: CoreLinkSessionStatus): boolean {
    try {
      return Boolean(this.deps.writer.mutate({ op: "update", sessionId, status }));
    } catch (err) {
      log.warn("harness-status.write-failed", { sessionId, status, error: String(err) });
      return false;
    }
  }
}
