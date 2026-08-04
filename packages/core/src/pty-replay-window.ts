// Slicing the PTY output ring for a reattaching Panel.
//
// A Panel that loses its link and comes back has already painted everything up
// to some seq. Handing it the whole ring again would duplicate that output on
// screen; handing it only "what's live from now on" would lose whatever the
// PTY emitted while the link was down. So a reattach asks for the tail past a
// cursor, and the answer says where the tail actually starts — because the ring
// is bounded and may have rolled past the cursor while the Panel was away.
//
// `from` is the seq of the first chunk returned. A caller that asked for
// `sinceSeq` and gets `from > sinceSeq` knows its cursor fell out of the ring:
// there is a hole, and the honest move is to reset the surface and paint the
// returned tail as a fresh screen rather than splice it onto a stale one.

import type { CoreLinkPtyReplay } from "@actana/shared/core-link-frames";

export type PtyReplayChunk = {
  seq: number;
  data: string;
};

/** The wire shape, re-exported so this module reads as its own vocabulary. */
export type PtyReplayWindow = CoreLinkPtyReplay;

/**
 * The ring tail at or after `sinceSeq`. Omitting `sinceSeq` (or passing a value
 * at or below the oldest chunk) returns the whole ring — the full-scrollback
 * replay a first attach wants.
 */
export function sliceReplayWindow(
  chunks: readonly PtyReplayChunk[],
  nextSeq: number,
  sinceSeq?: number,
): PtyReplayWindow {
  const wanted =
    typeof sinceSeq === "number" && Number.isFinite(sinceSeq)
      ? chunks.filter((chunk) => chunk.seq >= sinceSeq)
      : [...chunks];
  const first = wanted[0];
  if (!first) return { data: "", nextSeq };
  return {
    data: wanted.map((chunk) => chunk.data).join(""),
    nextSeq,
    from: first.seq,
  };
}
