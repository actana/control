import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { BOARD_COLUMNS } from "~/lib/task-board";
import { boardColumnOf, dropDecision, type BoardColumnId } from "~/lib/task-board-drop";
import type { TaskDto } from "~/shared/task-wire";

/** Same threshold as the Session grid's header drag: below it a press is a click. */
const DRAG_THRESHOLD_PX = 4;
/** How long a finger has to rest on a card before it lifts it. */
export const LONG_PRESS_MS = 400;
/** A finger that travels this far before the long press is scrolling the page. */
const LONG_PRESS_SLOP_PX = 8;

/** The card being carried, and the column it would land in now (null: outside the board). */
export type BoardDrag = { task: TaskDto; via: "pointer" | "keyboard"; over: BoardColumnId | null };

/** Where the lifted card's ghost sits: the pointer, less where on the card it was grabbed. */
export type GhostPosition = { x: number; y: number; grabX: number; grabY: number; width: number };

/** What a card needs to be picked up; TaskCard spreads it onto its root. */
export type TaskCardDrag = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  /** Handles a key that belongs to the drag and says so; anything else is the card's. */
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => boolean;
  onBlur: () => void;
  /** true once for the click a drag ends with, so it does not also open the Task. */
  consumeClick: () => boolean;
  /** This card is the one being carried. */
  lifted: boolean;
  describedBy: string;
};

const columnLabel = (id: BoardColumnId) => BOARD_COLUMNS.find((c) => c.id === id)?.label ?? id;

/** The column under a point. The ghost has pointer-events none, so it is never what is hit. */
function columnAt(x: number, y: number): BoardColumnId | null {
  // jsdom has no elementFromPoint; a real browser always does.
  const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
  const id = hit?.closest("[data-board-column]")?.getAttribute("data-board-column");
  return BOARD_COLUMNS.some((c) => c.id === id) ? (id as BoardColumnId) : null;
}

/** What the live region says about a column while the card is carried from the keyboard. */
function targetMessage(task: TaskDto, target: BoardColumnId): string {
  const d = dropDecision(task, target);
  if (d.kind === "noop") return `${columnLabel(target)}: where it is now.`;
  if (d.kind === "refuse") return `${columnLabel(target)}: not allowed. ${d.reason}`;
  return `${columnLabel(target)}: allowed.`;
}

/**
 * Picking a Task card up and dropping it on a board column (#827), by mouse or
 * pen (past a 4 px move), by a long press on touch, or from the keyboard
 * (Space, arrows, Enter or Space, Escape). It only tracks the gesture: what a
 * drop does is `onDrop`'s, which is called for every drop on a column, legal
 * or not. A drop outside the board, Escape and pointercancel are a silent cancel.
 */
export function useBoardDrag({
  onDrop,
  announce,
  describedBy,
}: {
  onDrop: (task: TaskDto, target: BoardColumnId) => void;
  announce: (message: string) => void;
  describedBy: string;
}) {
  const [drag, setDragState] = useState<BoardDrag | null>(null);
  const dragRef = useRef<BoardDrag | null>(null);
  const ghostEl = useRef<HTMLDivElement | null>(null);
  const ghostPos = useRef<GhostPosition | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  // A touch-lifted card is held: the finger moving it must not also scroll the page.
  const touchHeld = useRef(false);
  // iOS Safari and Chrome decide at touchstart whether a touchmove may be cancelled,
  // so this non-passive listener is on the board for as long as it is shown, not
  // added mid-gesture; on the board only, so scrolling anywhere else stays fast.
  const onTouchMove = useRef((e: TouchEvent) => {
    if (touchHeld.current) e.preventDefault();
  }).current;
  const boardEl = useRef<HTMLElement | null>(null);
  // A callback ref: the board's columns render only once the Tasks have loaded.
  const boardRef = useCallback(
    (el: HTMLElement | null) => {
      boardEl.current?.removeEventListener("touchmove", onTouchMove);
      boardEl.current = el;
      el?.addEventListener("touchmove", onTouchMove, { passive: false });
    },
    [onTouchMove],
  );
  // Kept current so the window listeners of a gesture call the latest ones.
  const onDropRef = useRef(onDrop);
  const announceRef = useRef(announce);
  useEffect(() => {
    onDropRef.current = onDrop;
    announceRef.current = announce;
  });

  const setDrag = useCallback((next: BoardDrag | null) => {
    dragRef.current = next;
    setDragState(next);
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  // The ghost is moved here, not through React state, so a pointermove does
  // not re-render the board; React never sets its transform or width.
  const placeGhost = () => {
    const el = ghostEl.current;
    const p = ghostPos.current;
    if (!el || !p) return;
    el.style.width = `${p.width}px`;
    el.style.transform = `translate(${p.x - p.grabX}px, ${p.y - p.grabY}px)`;
  };
  const ghostRef = useCallback((el: HTMLDivElement | null) => {
    ghostEl.current = el;
    placeGhost();
  }, []);

  const startPointer = (task: TaskDto, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // The Reply button inside a card is the button's to press.
    if ((event.target as HTMLElement | null)?.closest("button, a, input, textarea")) return;
    cleanupRef.current?.();
    const touch = event.pointerType === "touch";
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const cardEl = event.currentTarget;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const lift = (x: number, y: number) => {
      active = true;
      if (touch) touchHeld.current = true;
      const rect = cardEl.getBoundingClientRect();
      ghostPos.current = { x, y, grabX: startX - rect.left, grabY: startY - rect.top, width: rect.width };
      // Best effort: keeps the drag tracking when the pointer leaves the window.
      try {
        cardEl.setPointerCapture?.(pointerId);
      } catch {
        /* the card may be gone, or capture unsupported */
      }
      setDrag({ task, via: "pointer", over: columnAt(x, y) ?? boardColumnOf(task.status) });
    };

    const follow = (x: number, y: number) => {
      if (ghostPos.current) {
        ghostPos.current.x = x;
        ghostPos.current.y = y;
      }
      placeGhost();
      const over = columnAt(x, y);
      const cur = dragRef.current;
      if (cur && cur.over !== over) setDrag({ ...cur, over });
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (!active) {
        if (touch) {
          // Moving before the long press is a scroll: leave the page to it.
          if (dist > LONG_PRESS_SLOP_PX) cleanup();
          return;
        }
        if (dist < DRAG_THRESHOLD_PX) return;
        lift(e.clientX, e.clientY);
      }
      e.preventDefault();
      follow(e.clientX, e.clientY);
    };

    const finish = (target: BoardColumnId | null | undefined) => {
      const carried = dragRef.current;
      const wasActive = active;
      cleanup();
      if (!wasActive) return;
      // The browser sends a click on the card after this pointerup; it is the drag's.
      // The next press clears it, in case no click comes.
      suppressClick.current = true;
      setDrag(null);
      if (carried && target) onDropRef.current(carried.task, target);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      finish(active ? columnAt(e.clientX, e.clientY) : null);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !active) return;
      e.preventDefault();
      finish(null);
    };
    // A long press would otherwise open the browser's context menu (or text callout).
    const onContextMenu = (e: Event) => e.preventDefault();

    function cleanup() {
      if (timer) clearTimeout(timer);
      timer = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onContextMenu);
      try {
        if (cardEl.hasPointerCapture?.(pointerId)) cardEl.releasePointerCapture(pointerId);
      } catch {
        /* nothing to release */
      }
      ghostPos.current = null;
      if (active && dragRef.current?.via === "pointer") setDrag(null);
      active = false;
      touchHeld.current = false;
      if (cleanupRef.current === cleanup) cleanupRef.current = null;
    }

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKey, true);
    if (touch) {
      window.addEventListener("contextmenu", onContextMenu);
      timer = setTimeout(() => {
        timer = null;
        lift(startX, startY);
      }, LONG_PRESS_MS);
    }
    cleanupRef.current = cleanup;
  };

  const keyDown = (task: TaskDto, e: ReactKeyboardEvent<HTMLElement>): boolean => {
    const cur = dragRef.current;
    const carrying = cur?.via === "keyboard" && cur.task.id === task.id ? cur : null;
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
    if (!carrying) {
      // Enter stays the card's: it opens the Task.
      if (e.key !== " ") return false;
      setDrag({ task, via: "keyboard", over: boardColumnOf(task.status) });
      announceRef.current(
        `Picked up ${task.title}, in ${columnLabel(boardColumnOf(task.status))}. Arrow keys choose a column, Space or Enter drops it, Escape cancels.`,
      );
      return claim();
    }
    const ids = BOARD_COLUMNS.map((c) => c.id);
    const at = ids.indexOf(carrying.over ?? boardColumnOf(task.status));
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowUp":
      case "ArrowRight":
      case "ArrowDown": {
        const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        const over = ids[Math.min(ids.length - 1, Math.max(0, at + step))]!;
        setDrag({ ...carrying, over });
        announceRef.current(targetMessage(task, over));
        return claim();
      }
      case "Enter":
      case " ":
        setDrag(null);
        if (carrying.over) onDropRef.current(task, carrying.over);
        return claim();
      case "Escape":
        setDrag(null);
        announceRef.current("Cancelled.");
        return claim();
      default:
        return false;
    }
  };

  const blur = (task: TaskDto) => {
    const cur = dragRef.current;
    if (cur?.via !== "keyboard" || cur.task.id !== task.id) return;
    setDrag(null);
    announceRef.current("Cancelled.");
  };

  /** Drops whatever is carried without a drop: the pointer gesture's listeners go too. */
  const cancel = useCallback(() => {
    cleanupRef.current?.();
    setDrag(null);
  }, [setDrag]);

  /** The drag handlers for one card; `disabled` (its move is still in flight) makes it stay put. */
  const cardDrag = (task: TaskDto, disabled = false): TaskCardDrag => ({
    onPointerDown: (e) => {
      // A new press: the click a past drag ended with has come, or never will.
      suppressClick.current = false;
      if (!disabled) startPointer(task, e);
    },
    onKeyDown: (e) => {
      if (!disabled) return keyDown(task, e);
      // Space would otherwise pick it up; while it is moving it does nothing.
      if (e.key !== " ") return false;
      e.preventDefault();
      return true;
    },
    onBlur: () => blur(task),
    consumeClick: () => {
      if (!suppressClick.current) return false;
      suppressClick.current = false;
      return true;
    },
    lifted: drag?.task.id === task.id,
    describedBy,
  });

  return { drag, cardDrag, ghostRef, boardRef, cancel };
}
