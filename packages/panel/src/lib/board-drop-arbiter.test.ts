// @vitest-environment jsdom
//
// The arbiter that decides whether a file drop on a Project board belongs to a
// session or to the board (#401).
//
// Real DOM, real `closest`, markup shaped like `SessionGrid`'s: a stub that
// answers `closest` against the same string the module holds would agree with
// any selector, and that tautology is exactly what let the divider seam through
// the first time. The divider case below is the one that decides this file.
import { describe, expect, it } from "vitest";
import { dragTargetIsSessionPane } from "./board-drop-arbiter";

/**
 * The board as it renders in grid view — mirroring `projects.$id.tsx` and
 * `SessionGrid.tsx`:
 *
 *   board                      the drop target that uploads to the Project root
 *     frame                    CardFrame, 8px padding — board space
 *       header                 the project header strip — board space
 *       grid                   [data-session-grid], position: relative
 *         row                  [data-grid-row]
 *           cell / cell        [data-grid-cell], each holding a terminal
 *         divider              absolutely positioned child of the *grid*, a
 *                              sibling of the rows and inside no cell, lying
 *                              across the seam between the two cells
 *       hiddenBar              sibling *after* the grid — board space
 */
function renderBoard() {
  const make = (tag: string, attrs: Record<string, string> = {}) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  const board = make("div");
  const frame = make("div");
  const header = make("div", { class: "mc-project-header" });
  const grid = make("div", { "data-session-grid": "" });
  const row = make("div", { "data-grid-row": "0" });
  const cellA = make("div", { "data-grid-cell": "", "data-task-id": "task-a" });
  const cellB = make("div", { "data-grid-cell": "", "data-task-id": "task-b" });
  const terminalA = make("div", { class: "xterm" });
  const terminalCanvasA = make("canvas");
  const divider = make("div", { style: "position:absolute;z-index:6" });
  const hiddenBar = make("div", { "data-hidden-sessions-bar": "" });

  terminalA.append(terminalCanvasA);
  cellA.append(terminalA);
  row.append(cellA, cellB);
  grid.append(row, divider);
  frame.append(header, grid, hiddenBar);
  board.append(frame);
  document.body.append(board);

  return { board, frame, header, grid, row, cellA, cellB, terminalCanvasA, divider, hiddenBar };
}

describe("dragTargetIsSessionPane", () => {
  it("claims a drop on the terminal inside a cell", () => {
    const { terminalCanvasA } = renderBoard();
    expect(dragTargetIsSessionPane({ target: terminalCanvasA })).toBe(true);
  });

  it("claims a drop on a cell itself", () => {
    const { cellB } = renderBoard();
    expect(dragTargetIsSessionPane({ target: cellB })).toBe(true);
  });

  it("claims a drop on a resize divider lying across the seam between two panes", () => {
    // The regression this file exists for. The divider is a child of the grid
    // and inside no cell, but it is an 8px strip painted over 4px of each
    // neighbouring terminal (HANDLE_HIT = 8 with gridGap = 0), so a drop on it
    // is a drop the operator aimed at a session. `[data-grid-cell]` alone
    // answers null here and the board would have uploaded to the Project root.
    const { divider } = renderBoard();
    expect(divider.closest("[data-grid-cell]")).toBeNull();
    expect(dragTargetIsSessionPane({ target: divider })).toBe(true);
  });

  it("claims a drop on the grid container itself", () => {
    const { grid } = renderBoard();
    expect(dragTargetIsSessionPane({ target: grid })).toBe(true);
  });

  it("leaves the project header strip to the board", () => {
    const { header } = renderBoard();
    expect(dragTargetIsSessionPane({ target: header })).toBe(false);
  });

  it("leaves the frame padding around the grid to the board", () => {
    const { frame } = renderBoard();
    expect(dragTargetIsSessionPane({ target: frame })).toBe(false);
  });

  it("leaves the hidden-sessions bar to the board", () => {
    // It renders as a sibling *after* the grid element, so widening the
    // selector to the grid container did not swallow it.
    const { hiddenBar } = renderBoard();
    expect(dragTargetIsSessionPane({ target: hiddenBar })).toBe(false);
  });

  it("leaves the board's own surface to the board", () => {
    const { board } = renderBoard();
    expect(dragTargetIsSessionPane({ target: board })).toBe(false);
  });

  it("treats a target that is not an element as board space", () => {
    expect(dragTargetIsSessionPane({ target: null })).toBe(false);
    expect(dragTargetIsSessionPane({ target: document.createTextNode("x") })).toBe(false);
    expect(dragTargetIsSessionPane({ target: {} as EventTarget })).toBe(false);
  });
});
