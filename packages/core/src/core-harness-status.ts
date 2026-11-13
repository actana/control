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
  readProcessEntry,
  verifyHookProcess,
  type HookOrigin,
  type ProcessEntryReader,
  type SpawnedProcess,
} from "./harness-hook-origin";
import { DIALOG_SETTLE_MS } from "./core-dialog-watch";
import type { PtySessionExit } from "./pty-manager";
import { SESSION_KILLED_EVENT_KIND, type SessionKilledPayload } from "./session-kill";

export type CoreHarnessStatusDeps = {
  writer: CoreSessionWriter;
  /**
   * Name an unnamed Session from the prompt that started its turn. Optional so
   * a Core with no generator wired (tests) still moves status.
   */
  generateTitle?: (sessionId: string, prompt: string) => void;
  /**
   * The process this Core spawned for the Session — its pid, and whether that
   * is the harness or a wrapper the harness runs under — or null when it runs
   * none (`PtyCore.spawnedProcessForSession`). What a hook over the wire is
   * held to (issue 460). Required: a Core that could not answer would take a
   * nested harness's hooks as the Session's own, which is the bug.
   */
  spawned: (sessionId: string) => SpawnedProcess | null;
  /**
   * The platform's process table, for a hook whose reported pid is not the
   * spawned one but may climb to it through shells. Defaults to the real one;
   * tests supply a table of their own.
   */
  readProcess?: ProcessEntryReader;
  /** The clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** How long a hook silences the screen rules. Defaults to `DIALOG_SETTLE_MS`. */
  dialogSettleMs?: number;
};

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
  constructor(private readonly deps: CoreHarnessStatusDeps) {}

  /** When a Session's last hook arrived (issue 963): hooks win over screen rules. */
  private readonly lastHookAt = new Map<string, number>();
  /** Sessions whose current `needs-input` was set by a screen rule, and which rule. */
  private readonly screenSet = new Map<string, string>();

  /**
   * Apply a hook payload to the session it names. The answer is what the receiver
   * writes back to the harness — a shape the harness ignores, but a `404` is
   * how an operator reading `curl -v` learns the session is gone.
   *
   * `origin` is present for a hook that arrived over the wire and absent for
   * the Core's own synthetic events (PTY exit, output signals), which have no
   * process to prove. With it, the hook is held to the process this Core
   * spawned for the Session BEFORE the pipeline sees it (issue 460): a hook
   * from any other process — a harness nested inside the Session's PTY,
   * running the same hook file with the same inherited env — is acked and
   * dropped as `foreign-process`, so it captures no session id, moves no
   * status, and settles nothing. Acked, not refused: the nested harness's
   * `curl -f` would otherwise record a delivery miss for a hook the Core
   * heard perfectly well and chose not to act on.
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
    const result = this.applyHook(sessionId, payload, eventNameFallback, origin);
    // A hook the Session's own harness sent speaks for it: no screen rule may
    // overrule it (issue 963). Dropped or foreign hooks prove nothing. A hook
    // that writes no status leaves a screen-set needs-input the screen's to
    // undo; one that does write takes ownership (the updateStatus port below).
    if (sessionId && hookEvidencesSession(result) && this.deps.writer.readSession(sessionId)) this.lastHookAt.set(sessionId, this.now());
    return result;
  }

  private applyHook(
    sessionId: string,
    payload: HarnessHookBody,
    eventNameFallback: string,
    origin?: HookOrigin,
  ): { ok: boolean; body: Record<string, unknown> } {
    if (origin) {
      const verdict = this.verifyOrigin(sessionId, origin);
      if (verdict === "foreign") {
        const event = payload.hook_event_name || eventNameFallback || "";
        const spawned = this.deps.spawned(sessionId);
        log.warn("harness-status.foreign-process", {
          sessionId,
          event,
          slug: origin.slug,
          pid: origin.pid,
          spawnedPid: spawned?.pid ?? null,
          launcher: spawned?.launcher ?? null,
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
        updateStatus: (id, status) => {
          this.screenSet.delete(id);
          return this.writeStatus(id, status);
        },
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
   *
   * A killed PTY (issue 292) settles a live turn as `terminated` whatever its
   * exit code, and appends one `session:killed` event naming the task, the
   * time, the reason and whether a turn was in flight — the trace a caller who
   * was not present reads afterwards. The event goes after the settle, so the
   * status it reports is the one the row now carries.
   */
  sessionExited(exit: PtySessionExit): void {
    const { sessionId, ptyId, exitCode, signal, kill } = exit;
    if (!sessionId) return;
    const statusBefore = kill ? (this.deps.writer.readSession(sessionId)?.status ?? null) : null;
    this.screenSet.delete(sessionId);
    this.lastHookAt.delete(sessionId);
    this.applyHook(sessionId, {
      hook_event_name: HARNESS_HOOK_EVENTS.sessionProcessExited,
      exit_code: exitCode,
      ...(typeof signal === "number" ? { signal } : {}),
      ...(kill ? { killed: true } : {}),
    }, "");
    if (!kill) return;
    const payload: SessionKilledPayload = {
      sessionId,
      ptyId,
      reason: kill.reason,
      killedAt: new Date(kill.at).toISOString(),
      liveTurn: statusBefore === "running" || statusBefore === "needs-input",
      statusBefore,
      status: this.deps.writer.readSession(sessionId)?.status ?? null,
      exitCode,
      signal: typeof signal === "number" && signal !== 0 ? signal : null,
    };
    try {
      this.deps.writer.recordSessionEvent(SESSION_KILLED_EVENT_KIND, JSON.stringify(payload), {
        sessionId,
        ptyId,
      });
    } catch (err) {
      log.warn("harness-status.kill-event-failed", { sessionId, error: String(err) });
    }
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
    this.applyHook(
      sessionId,
      {
        hook_event_name:
          signal === "interrupted"
            ? HARNESS_HOOK_EVENTS.userInterrupt
            : HARNESS_HOOK_EVENTS.permissionRequest,
      },
      "",
    );
  }

  /**
   * A dialog no hook announced is on the Session's screen (issue 963): the
   * screen has held still for `DIALOG_SETTLE_MS` and `classifyDialog` matched.
   * Sets `needs-input` through the same `writeStatus` port the hook pipeline
   * uses, with `source: "screen:<ruleId>"` in the event so a screen-set status
   * can be told from a hook-set one. Returns whether it wrote.
   *
   * Hooks always win. It writes only on a Session that is `running` (so `ready`,
   * `finished` and every status a hook or the Core wrote are left alone, and a
   * Session already `needs-input` is not written twice) and only when no hook of
   * that Session arrived in the settle time.
   *
   * The answer says why nothing was written, so the screen watch can ask again
   * when the refusal is only "a hook was too recent" (the dialog may still be
   * there once the hook's window passes): `wrote`, `already-set`, `not-running`
   * (also an unknown Session), `hook-recent`.
   */
  dialogOnScreen(
    sessionId: string,
    hit: { ruleId: string; kind: string },
  ): "wrote" | "already-set" | "not-running" | "hook-recent" {
    if (!sessionId) return "not-running";
    const session = this.deps.writer.readSession(sessionId);
    if (session?.status === "needs-input") return "already-set";
    if (session?.status !== "running") return "not-running";
    const hookAt = this.lastHookAt.get(sessionId);
    if (hookAt !== undefined && this.now() - hookAt < (this.deps.dialogSettleMs ?? DIALOG_SETTLE_MS)) {
      return "hook-recent";
    }
    if (!this.writeStatus(sessionId, "needs-input", `screen:${hit.ruleId}`)) return "not-running";
    this.screenSet.set(sessionId, hit.ruleId);
    log.info("harness-status.screen-needs-input", { sessionId, ruleId: hit.ruleId, kind: hit.kind });
    return "wrote";
  }

  /**
   * What the Session's output is doing, from the output classifier. New output
   * puts a screen-set `needs-input` back to `running`: the dialog was answered.
   * A `needs-input` a hook wrote is never undone here (it is not in `screenSet`).
   */
  screenActivity(sessionId: string, kind: "output" | "redraw" | "static"): void {
    if (kind !== "output" || !this.screenSet.has(sessionId)) return;
    this.screenSet.delete(sessionId);
    if (this.deps.writer.readSession(sessionId)?.status !== "needs-input") return;
    this.writeStatus(sessionId, "running", "screen:output");
  }

  /**
   * Is this request from the harness this Core spawned for the Session?
   *
   * "unverifiable" — a platform whose process table the Core cannot read —
   * is taken as owned, with a log line saying so: refusing every hook there
   * would leave a whole platform's Sessions on `ready` for ever, which is
   * worse than the exposure ADR 0020 already accepts. A row this Core does not
   * have is left to the pipeline, which answers 404 as it always did.
   */
  private verifyOrigin(sessionId: string, origin: HookOrigin): "owned" | "foreign" {
    const session = this.deps.writer.readSession(sessionId);
    if (!session) return "owned";
    if (hookEndpointSlug(session.agent) !== origin.slug) return "foreign";
    const verdict = verifyHookProcess(
      origin.pid,
      this.deps.spawned(sessionId),
      this.deps.readProcess ?? readProcessEntry,
    );
    if (verdict === "unverifiable") {
      log.warn("harness-status.origin-unverifiable", {
        sessionId,
        pid: origin.pid,
        platform: process.platform,
      });
      return "owned";
    }
    return verdict;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private writeStatus(sessionId: string, status: CoreLinkSessionStatus, source?: string): boolean {
    try {
      return Boolean(this.deps.writer.mutate({ op: "update", sessionId, status }, source ? { source } : {}));
    } catch (err) {
      log.warn("harness-status.write-failed", { sessionId, status, error: String(err) });
      return false;
    }
  }
}
