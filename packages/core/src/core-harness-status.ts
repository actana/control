// Harness status detection, on the Core.
//
// Every step of a harness's work reaches this file: a hook posted to the
// Core's loopback receiver, or the PTY exiting. Each one becomes a write on
// this Core's own task row through {@link CoreTaskWriter}, which appends the
// matching event, which is what the Panel's live card re-renders from — no
// round trip through the Panel, and no Panel needed for the write to happen
// at all (issue 84).
//
// The decisions are not made here. They are in
// `@actana/shared/harness-hook-pipeline`, the same tuned state machine the
// Panel runs for its own rows, so the Stop-downgrade, the recent-finish heal
// and the drain backstop behave identically on both sides.

import log from "./log";
import {
  handleHarnessHookEvent,
  hookResultResponse,
  type HarnessHookBody,
} from "@actana/shared/harness-hook-pipeline";
import { HARNESS_HOOK_EVENTS } from "@actana/shared/harness-hook-events";
import type { CoreLinkTaskStatus } from "@actana/sdk/core-link-frames";
import type { CoreTaskWriter } from "./core-task-writer";

export type CoreHarnessStatusDeps = {
  writer: CoreTaskWriter;
  /**
   * Name an unnamed Session from the prompt that started its turn. Optional so
   * a Core with no generator wired (tests) still moves status.
   */
  generateTitle?: (taskId: string, prompt: string) => void;
};

/**
 * The Core's harness-status service. One instance per Core process; the hook
 * receiver and the PTY exit path both call it.
 */
export class CoreHarnessStatus {
  constructor(private readonly deps: CoreHarnessStatusDeps) {}

  /**
   * Apply a hook payload to the task it names. The answer is what the receiver
   * writes back to the harness — a shape the harness ignores, but a `404` is
   * how an operator reading `curl -v` learns the task is gone.
   */
  receiveHook(
    taskId: string,
    payload: HarnessHookBody,
    eventNameFallback = "",
  ): { ok: boolean; body: Record<string, unknown> } {
    const result = handleHarnessHookEvent(
      taskId,
      payload,
      {
        getTask: (id) => {
          const task = this.deps.writer.readTask(id);
          if (!task) return null;
          return { status: task.status, claudeSessionId: task.claudeSessionId };
        },
        updateStatus: (id, status) => this.writeStatus(id, status),
        setSessionId: (id, sessionId) => {
          this.deps.writer.mutate({ op: "update", taskId: id, claudeSessionId: sessionId });
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
  sessionExited(taskId: string, exitCode: number): void {
    if (!taskId) return;
    this.receiveHook(taskId, {
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
    taskId: string,
    signal: "interrupted" | "hooks-need-review" | "dialog-unanswered",
  ): void {
    if (!taskId) return;
    this.receiveHook(taskId, {
      hook_event_name:
        signal === "interrupted"
          ? HARNESS_HOOK_EVENTS.userInterrupt
          : HARNESS_HOOK_EVENTS.permissionRequest,
    });
  }

  private writeStatus(taskId: string, status: CoreLinkTaskStatus): boolean {
    try {
      return Boolean(this.deps.writer.mutate({ op: "update", taskId, status }));
    } catch (err) {
      log.warn("harness-status.write-failed", { taskId, status, error: String(err) });
      return false;
    }
  }
}
