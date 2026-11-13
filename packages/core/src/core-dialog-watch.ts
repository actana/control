// When does the Core look at a harness's screen for a dialog? (issue 963)
//
// Not on every chunk. A harness that is working repaints its spinner every
// second, and a dialog is only worth reporting once it has been sitting there:
// the screen has stopped moving. `DialogScreenWatch` is one per agent PTY. It
// keeps the screen the PTY has painted (everything since the last full clear),
// and asks `classifyDialog` once the screen has gone `DIALOG_SETTLE_MS` without
// moving — no bytes at all, or bytes that only repaint the same frame (the
// output classifier's `static`). Output and redraws that carry something new
// restart the wait.
//
// The watch decides nothing about status. It reports a match; whether that
// becomes `needs-input` is `CoreHarnessStatus.dialogOnScreen`'s call, because
// only it knows about hooks.

import {
  classifyDialog,
  type DialogClassification,
} from "@actana/shared/harness-dialog-classifier";
import { lastClearEnd } from "@actana/shared/screen-text";
import type { PtyOutputActivityKind } from "./pty-output-activity";

/** How long a screen must hold still before it is read for a dialog. */
export const DIALOG_SETTLE_MS = 10_000;

/** The painted screen kept per PTY: the tail, which is where a dialog and its footer are. */
const MAX_SCREEN_CHARS = 64 * 1024;

/** Re-asks per stall after a refusal that may pass; bounded so a stuck row costs nothing. */
const MAX_RETRIES = 6;

export type DialogScreenWatchOptions = {
  /** The Session's harness; its rules and `generic` are the only ones tried. */
  harness: string;
  /**
   * `"retry"` says the host refused for a reason that may pass (a hook was too
   * recent, the row was not `running` yet): ask again after another settle time.
   */
  onDialog: (hit: DialogClassification) => "retry" | void;
  settleMs?: number;
  now?: () => number;
};

export class DialogScreenWatch {
  private screen = "";
  private lastMovedAt = 0;
  /** Reported for this stillness already; cleared when the screen moves again. */
  private reported = false;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly opts: DialogScreenWatchOptions) {}

  /**
   * One PTY chunk, with the output classifier's verdict on the burst it
   * belongs to (`null` between the classifier's reports: nothing is learned).
   */
  push(chunk: string, kind: PtyOutputActivityKind | null): void {
    if (this.disposed) return;
    const cleared = lastClearEnd(chunk);
    this.screen = cleared >= 0 ? chunk.slice(cleared) : (this.screen + chunk).slice(-MAX_SCREEN_CHARS);
    const moved = kind === "output" || kind === "redraw" || this.lastMovedAt === 0;
    if (moved) {
      this.lastMovedAt = this.now();
      this.reported = false;
      this.retries = 0;
    }
    if (!this.reported && this.timer === null) this.arm(this.settleMs());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.screen = "";
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => this.check(), ms);
    this.timer.unref?.();
  }

  private check(): void {
    this.timer = null;
    if (this.disposed || this.reported) return;
    const remaining = this.lastMovedAt + this.settleMs() - this.now();
    if (remaining > 0) {
      this.arm(remaining);
      return;
    }
    this.reported = true;
    const hit = classifyDialog(this.opts.harness, this.screen);
    if (hit && this.opts.onDialog(hit) === "retry" && this.retries < MAX_RETRIES) {
      this.retries += 1;
      this.reported = false;
      this.arm(this.settleMs());
    }
  }

  private settleMs(): number {
    return this.opts.settleMs ?? DIALOG_SETTLE_MS;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
