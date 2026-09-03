// Which nested drop target owns a file drop on a Project board (#401).
//
// A Project's board is itself a drop target: a file dropped anywhere on it
// uploads to the Project root. In grid view the whole session grid renders
// *inside* that board, so every drag aimed at a session's terminal also
// bubbles to the board's handler — and the board, having no idea what the
// operator was aiming at, uploads to the Project root. The file lands
// somewhere the operator did not aim.
//
// Nested drop targets need an arbiter, and the only honest arbiter for a
// pointer gesture is where the pointer was. A grid cell marks itself with
// `data-grid-cell` (SessionGrid), which is already the repo's way of asking
// "is this inside a session pane?" — the same attribute the grid's own
// keyboard navigation walks up to. So the board asks the same question of the
// drag's target, and stands down when the answer is yes.
//
// Single-session view needs nothing here: `TerminalPanel` renders as a sibling
// of the board in `__root.tsx`, never a descendant, so its drops never reach
// the board handler in the first place.
const SESSION_PANE_SELECTOR = "[data-grid-cell]";

/** The subset of `Element` this needs — duck-typed so the check is unit
 *  testable without a DOM, and so a non-Element target (a text node, `null`)
 *  is simply "not a session pane" rather than a throw. */
type ClosestCapable = { closest(selector: string): unknown };

function isClosestCapable(target: unknown): target is ClosestCapable {
  return (
    typeof target === "object" &&
    target !== null &&
    typeof (target as ClosestCapable).closest === "function"
  );
}

/**
 * Whether a drag event landed inside a session pane rather than on the board's
 * own space.
 *
 * True means the board must not treat the gesture as a Project-root upload:
 * the operator aimed at a session, and the space between and around the cells
 * is the only part of the board they can aim at when the grid is up.
 */
export function dragTargetIsSessionPane(event: { target: EventTarget | null }): boolean {
  const target: unknown = event.target;
  if (!isClosestCapable(target)) return false;
  return target.closest(SESSION_PANE_SELECTOR) != null;
}
