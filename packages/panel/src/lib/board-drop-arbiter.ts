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
// pointer gesture is where the pointer was. Two markers answer that, and it
// takes both:
//
//   [data-grid-cell]     one session's cell (SessionGrid) — the same attribute
//                        the grid's own keyboard navigation walks up to.
//   [data-session-grid]  the grid container itself. Not redundant: the row and
//                        column resize handles are absolutely-positioned
//                        children of *this* element, siblings of the row divs
//                        and inside no cell, at zIndex 6 — above every
//                        non-expanded cell. Their hit area is HANDLE_HIT = 8px
//                        while the shipped layout runs gridGap = 0 and
//                        gridPad = 0, so each one is an 8px strip centred on a
//                        0-width seam: it lies on top of terminal pixels, 4px
//                        into each neighbour, full pane height for a column
//                        divider and full grid width for a row divider. Cell
//                        alone answers null there, and the board would paint
//                        itself hot and upload to the Project root 4px from a
//                        pane edge — #401's exact failure mode, in the one
//                        place the operator cannot see that they are not on a
//                        pane.
//
// So the whole grid element is session space. With gridGap and gridPad both 0
// there is no board space left inside it to protect: the board's own space in
// grid view is the project header strip and the CardFrame's 8px padding, both
// *outside* the grid element, plus the hidden-sessions bar, which renders as a
// sibling after it. Those still upload to the Project root, as they should.
//
// Single-session view needs nothing here: `TerminalPanel` renders as a sibling
// of the board in `__root.tsx`, never a descendant, so its drops never reach
// the board handler in the first place.
//
// Known and accepted gap: a menu portalled out of a cell to `document.body`
// (TerminalPane's session-actions menu) still bubbles to the board through the
// React tree while its DOM sits outside the grid, so `closest` answers null and
// a drop on the open menu uploads to the Project root. It takes a menu held
// open across a drag, and a menu is not a terminal, so it is recorded rather
// than fixed. A DOM-position arbiter cannot see a React-tree ancestor; closing
// that would mean a second signal (a dataset marker on the portal, or the
// menu claiming the drag itself).
const SESSION_PANE_SELECTOR = "[data-grid-cell], [data-session-grid]";

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
 * the operator aimed at a session, or at the grid's own furniture lying across
 * one.
 */
export function dragTargetIsSessionPane(event: { target: EventTarget | null }): boolean {
  const target: unknown = event.target;
  if (!isClosestCapable(target)) return false;
  return target.closest(SESSION_PANE_SELECTOR) != null;
}
