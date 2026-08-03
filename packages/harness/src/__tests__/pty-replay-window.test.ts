import { describe, expect, it } from "vitest";
import { sliceReplayWindow } from "../pty-replay-window";

// A reattaching Panel asks for the tail past the last seq it painted. The
// window it gets back must be exactly the missing bytes — never a repeat of
// what's already on screen, and never a silent hole.

const RING = [
  { seq: 5, data: "five" },
  { seq: 6, data: "six" },
  { seq: 7, data: "seven" },
];

describe("sliceReplayWindow", () => {
  it("returns the whole ring when no cursor is given (first attach)", () => {
    expect(sliceReplayWindow(RING, 8)).toEqual({
      data: "fivesixseven",
      nextSeq: 8,
      from: 5,
    });
  });

  it("returns only the chunks at or after the cursor", () => {
    expect(sliceReplayWindow(RING, 8, 6)).toEqual({
      data: "sixseven",
      nextSeq: 8,
      from: 6,
    });
  });

  it("returns nothing when the caller is already current", () => {
    expect(sliceReplayWindow(RING, 8, 8)).toEqual({ data: "", nextSeq: 8 });
  });

  it("reports where the tail really starts when the ring rolled past the cursor", () => {
    // The Panel painted through seq 1 and went away long enough for the ring to
    // drop everything up to 4. `from: 5` is how it learns there's a hole.
    expect(sliceReplayWindow(RING, 8, 2)).toEqual({
      data: "fivesixseven",
      nextSeq: 8,
      from: 5,
    });
  });

  it("returns nothing for a PTY that has emitted nothing", () => {
    expect(sliceReplayWindow([], 0, 3)).toEqual({ data: "", nextSeq: 0 });
  });

  it("ignores a non-finite cursor rather than dropping the scrollback", () => {
    expect(sliceReplayWindow(RING, 8, Number.NaN)).toEqual({
      data: "fivesixseven",
      nextSeq: 8,
      from: 5,
    });
  });
});
