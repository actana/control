// Holding a drag over a folder opens it (#228).
//
// The Finder and VS Code gesture, and with folders closed by default (#226) and
// folder rows taking drops (#227) it is what makes a nested folder reachable at
// all: a drag cannot click a chevron, so without this the only folders an
// operator can drop into are the ones that happened to be open before the drag
// started.
//
// The whole subtlety is in **not restarting the timer**. `dragover` fires
// continuously — tens of times a second, for as long as the pointer is over the
// row — so the obvious `clearTimeout` + `setTimeout` on every event is a timer
// that is always one frame old and never fires. Arming is therefore
// idempotent per path: the first hover over a row starts its clock, every
// hover after that is ignored, and only moving to a different row (or leaving,
// or dropping) stops it.
import { useCallback, useEffect, useRef } from "react";

/**
 * How long a drag must rest on a folder before it opens.
 *
 * A second, which is the interval Finder and VS Code settled on and is what
 * #228 asks for. Shorter and folders spring open while the operator is merely
 * crossing the list on the way somewhere else; longer and it reads as broken.
 */
export const SPRING_LOADED_MS = 1_000;

export type SpringLoad = {
  /** A drag is over this folder. Safe to call on every `dragover`. */
  hover(path: string): void;
  /** The drag left this folder — cancels only if it is the one being timed. */
  leave(path: string): void;
  /** The drag is over nothing, or over: a drop, a leave, an unmount. */
  cancel(): void;
};

/**
 * The hold-to-open timer, one at a time.
 *
 * One timer, because a drag has one pointer: arming a second row cancels the
 * first, so a drag dragged across five folders on its way to the sixth opens
 * the sixth and nothing else. That is the behaviour, not an optimisation — a
 * trail of folders springing open behind a moving pointer is the failure mode
 * this shape avoids.
 */
export function useSpringLoad(
  open: (path: string) => void,
  delayMs: number = SPRING_LOADED_MS,
): SpringLoad {
  // Read through a ref so a caller's inline arrow does not re-create `hover`
  // on every render — and, more to the point, so the armed timer keeps working
  // through the re-render that a highlight change causes mid-drag.
  const openRef = useRef(open);
  openRef.current = open;

  const armed = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const cancel = useCallback(() => {
    if (!armed.current) return;
    clearTimeout(armed.current.timer);
    armed.current = null;
  }, []);

  const hover = useCallback(
    (path: string) => {
      // The line this whole module exists for: already counting for this row,
      // so let it count. Re-arming here is how a `dragover` handler produces a
      // timer that never fires.
      if (armed.current?.path === path) return;
      cancel();
      armed.current = {
        path,
        timer: setTimeout(() => {
          armed.current = null;
          openRef.current(path);
        }, delayMs),
      };
    },
    [cancel, delayMs],
  );

  const leave = useCallback(
    (path: string) => {
      // Only the row being timed. Moving from one row to the next fires the new
      // row's `dragenter` before the old row's `dragleave`, and a `leave` that
      // did not check the path would cancel the timer that had just been armed.
      if (armed.current?.path === path) cancel();
    },
    [cancel],
  );

  // A timer that outlives the view would open a folder in a tree nobody is
  // looking at — or, worse, run against an unmounted component's setter.
  useEffect(() => cancel, [cancel]);

  return { hover, leave, cancel };
}
