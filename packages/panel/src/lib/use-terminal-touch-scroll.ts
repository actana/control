import { useEffect, useRef, type RefObject } from "react";

/**
 * What the hook needs from a terminal. `mode` says where a scroll gesture goes:
 * `scroll` is the normal screen (move the scrollback), `mouse` is mouse tracking
 * on (SGR wheel reports, as xterm sends for a wheel), `alternate` is the
 * alternate screen without mouse tracking (arrow keys, as xterm sends for a
 * wheel there).
 */
export interface TouchScrollTarget {
  scrollLines(lines: number): void;
  /** One cell's height in CSS px. */
  cellHeight(): number;
  mode(): "scroll" | "mouse" | "alternate";
  size(): { cols: number; rows: number };
  applicationCursorKeys?(): boolean;
  /** Raw bytes to the PTY. */
  write(data: string): void;
}

// Most lines one gesture step may report to a program, so a wild flick cannot
// flood the PTY.
const MAX_LINES_PER_STEP = 30;
// Flick speed (px/ms) below which a release does not coast, and the speed at
// which coasting stops. Friction is per 16 ms frame.
const INERTIA_MIN_START = 0.3;
const INERTIA_STOP = 0.05;
const INERTIA_FRICTION = 0.95;
// A release this long after the last move is a hold, not a flick.
const FLICK_MAX_IDLE_MS = 100;

/** The slice of an xterm `Terminal` the touch target reads. */
export interface TouchScrollTerminal {
  cols: number;
  rows: number;
  element?: HTMLElement;
  scrollLines(lines: number): void;
  buffer: { active: { type: string } };
  modes: { mouseTrackingMode: string; applicationCursorKeysMode: boolean };
}

const FALLBACK_CELL_HEIGHT = 16;

/** Wrap an xterm terminal as a touch-scroll target; `write` sends bytes to its PTY. */
export function createTerminalTouchTarget(
  term: TouchScrollTerminal,
  write: (data: string) => void,
): TouchScrollTarget {
  return {
    scrollLines: (lines) => term.scrollLines(lines),
    cellHeight: () => {
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen") ?? term.element;
      const height = screen?.clientHeight ?? 0;
      return height > 0 && term.rows > 0 ? height / term.rows : FALLBACK_CELL_HEIGHT;
    },
    mode: () =>
      term.modes.mouseTrackingMode !== "none"
        ? "mouse"
        : term.buffer.active.type === "alternate"
          ? "alternate"
          : "scroll",
    size: () => ({ cols: term.cols, rows: term.rows }),
    applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
    write,
  };
}

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

function sgrWheel(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col};${row}M`;
}

/**
 * Touch scrolling for the terminal on a phone or tablet. xterm 6 handles wheel
 * events only, so without this a swipe scrolls the page. Dragging the finger
 * down scrolls back through history, like a wheel up. `enabled` is false on the
 * desktop layout, where nothing is attached. A tap is never prevented, so the
 * browser still sends its click and xterm focuses.
 */
export function useTerminalTouchScroll(
  paneRef: RefObject<HTMLElement | null>,
  getTarget: () => TouchScrollTarget | null,
  enabled: boolean,
) {
  const getTargetRef = useRef(getTarget);
  getTargetRef.current = getTarget;

  useEffect(() => {
    const pane = paneRef.current;
    if (!enabled || !pane) return;

    let lastY = 0;
    let lastX = 0;
    let remainder = 0;
    let velocity = 0; // px/ms, positive = finger moving down
    let lastMoveAt = 0;
    let active = false;
    let raf = 0;

    const cancelInertia = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // Scroll `lines` back (negative = finger down) or forward through the target.
    const apply = (target: TouchScrollTarget, lines: number) => {
      if (lines === 0) return;
      const mode = target.mode();
      if (mode === "scroll") {
        target.scrollLines(lines);
        return;
      }
      const count = Math.min(Math.abs(lines), MAX_LINES_PER_STEP);
      const up = lines < 0;
      let one: string;
      if (mode === "alternate") {
        const appCursor = target.applicationCursorKeys?.() ?? false;
        one = `${appCursor ? "\x1bO" : "\x1b["}${up ? "A" : "B"}`;
      } else {
        const rect = pane.getBoundingClientRect();
        const { cols, rows } = target.size();
        const col = Math.min(cols, Math.max(1, Math.floor(((lastX - rect.left) / (rect.width || 1)) * cols) + 1));
        const row = Math.min(rows, Math.max(1, Math.floor(((lastY - rect.top) / (rect.height || 1)) * rows) + 1));
        one = sgrWheel(up ? WHEEL_UP : WHEEL_DOWN, col, row);
      }
      target.write(one.repeat(count));
    };

    // Feed pixels of finger travel in; whole cells go out, the rest is kept.
    const feed = (target: TouchScrollTarget, deltaPx: number) => {
      const cell = target.cellHeight();
      if (!(cell > 0)) return;
      remainder += deltaPx;
      const cells = Math.trunc(remainder / cell);
      if (cells === 0) return;
      remainder -= cells * cell;
      apply(target, -cells);
    };

    const onStart = (event: TouchEvent) => {
      cancelInertia();
      const t = event.touches[0];
      if (!t || event.touches.length > 1) {
        active = false;
        return;
      }
      active = true;
      lastY = t.clientY;
      lastX = t.clientX;
      remainder = 0;
      velocity = 0;
      lastMoveAt = performance.now();
    };

    const onMove = (event: TouchEvent) => {
      if (!active) return;
      const t = event.touches[0];
      if (!t) return;
      // Keep the page still, including when there is no terminal to scroll.
      event.preventDefault();
      const target = getTargetRef.current();
      const now = performance.now();
      const dy = t.clientY - lastY;
      const dt = now - lastMoveAt;
      if (dt > 0) velocity = 0.6 * velocity + 0.4 * (dy / dt);
      lastY = t.clientY;
      lastX = t.clientX;
      lastMoveAt = now;
      if (target) feed(target, dy);
    };

    const onEnd = () => {
      if (!active) return;
      active = false;
      const now = performance.now();
      if (Math.abs(velocity) < INERTIA_MIN_START || now - lastMoveAt > FLICK_MAX_IDLE_MS) return;
      let prev = now;
      const step = () => {
        raf = 0;
        const target = getTargetRef.current();
        if (!target) return;
        const at = performance.now();
        const dt = at - prev;
        prev = at;
        feed(target, velocity * dt);
        velocity *= Math.pow(INERTIA_FRICTION, dt / 16);
        if (Math.abs(velocity) >= INERTIA_STOP) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    // touchmove must be non-passive for preventDefault to take effect.
    pane.addEventListener("touchstart", onStart, { passive: true });
    pane.addEventListener("touchmove", onMove, { passive: false });
    pane.addEventListener("touchend", onEnd, { passive: true });
    pane.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      cancelInertia();
      pane.removeEventListener("touchstart", onStart);
      pane.removeEventListener("touchmove", onMove);
      pane.removeEventListener("touchend", onEnd);
      pane.removeEventListener("touchcancel", onEnd);
    };
  }, [paneRef, enabled]);
}
