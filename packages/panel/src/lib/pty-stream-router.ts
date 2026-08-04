// One IPC listener per PTY transport, demuxed by ptyId — instead of one
// listener per terminal pane.
//
// Historically every mounted pane subscribed to the transport's `onData`/
// `onExit` and filtered by ptyId itself; with N panes every chunk of every PTY
// invoked N callbacks (and TerminalPane's non-owners each buffered the chunk
// into their own pending map). That made renderer work per chunk O(panes).
// The router keeps a single subscription per transport and routes each message
// to the pane that CLAIMED its ptyId.
//
// Output for a pty nobody has claimed yet (the window between `spawn()`
// starting and the pane learning its ptyId) is buffered here — bounded per pty
// and in total — and handed over via `takePendingData`/`takePendingExit` when
// the pane wires up, exactly like the per-pane pending maps used to.

import {
  appendBoundedSequencedData,
  sequencedPtyData,
  type SequencedPtyData,
} from "./terminal-replay";

export type PtyDataMsg = { ptyId: string; data: string; seq: number };
export type PtyExitMsg = { ptyId: string; exitCode: number; signal?: number };

/** Structural match for a Core's PTY bridge. */
export type PtyStreamTransport = {
  onData: (cb: (msg: PtyDataMsg) => void) => () => void;
  onExit: (cb: (msg: PtyExitMsg) => void) => () => void;
  /**
   * The transport came back after a drop. Present on transports that can drop
   * — the panel link — and absent on ones that can't; without it the router
   * simply never reattaches.
   */
  onReconnect?: (cb: () => void) => () => void;
  /** The pty's buffered output, all of it or the tail past `sinceSeq`. */
  replay?: (
    ptyId: string,
    sinceSeq?: number,
  ) => Promise<{ data: string; nextSeq: number; from?: number }>;
};

export type PtyStreamHandlers = {
  data: (msg: PtyDataMsg) => void;
  exit: (msg: PtyExitMsg) => void;
  /**
   * Throw away what is on screen — the next `data` is a fresh screen, not a
   * continuation. Called only when a reattach finds the Core's ring has
   * rolled past what this surface last painted.
   */
  reset?: () => void;
};

export interface PtyStreamRouter {
  /**
   * Route this pty's messages to `handlers` from now on. Returns an unclaim
   * fn; unclaiming only removes the claim if it is still the active one, so a
   * stale surface tearing down can't detach its successor.
   */
  claim(ptyId: string, handlers: PtyStreamHandlers): () => void;
  /**
   * Drain buffered output that arrived while the pty was unclaimed. Draining
   * it means painting it, so the reattach cursor moves with it.
   */
  takePendingData(ptyId: string): SequencedPtyData[];
  /**
   * The pane replayed this pty itself (its first attach) and painted up to
   * `nextSeq`. Tells the router where a later reattach should resume — without
   * it, a link that drops before the pty says anything new would replay that
   * whole scrollback a second time.
   */
  noteReplayed(ptyId: string, nextSeq: number): void;
  /** Drain a buffered exit that arrived while the pty was unclaimed. */
  takePendingExit(ptyId: string): PtyExitMsg | null;
}

/** Per-pty cap on buffered unclaimed output (same bound the panes used). */
const PENDING_OUTPUT_MAX_CHARS = 64_000;
/** Total unclaimed ptys tracked; beyond this the oldest entries are dropped.
 *  Anything dropped is still recoverable through the main-process replay ring. */
const MAX_UNCLAIMED_PTYS = 64;

export function createPtyStreamRouter(transport: PtyStreamTransport): PtyStreamRouter {
  const claims = new Map<string, PtyStreamHandlers>();
  const pendingData = new Map<string, SequencedPtyData[]>();
  const pendingExit = new Map<string, PtyExitMsg>();
  /** Highest seq delivered to each claimed pty — where a reattach resumes. */
  const delivered = new Map<string, number>();
  /**
   * Ptys with a reattach request in flight, holding whatever arrived live in
   * the meantime. The Core resumes pushing the moment the link is back, and
   * those same chunks are inside the replay window still on its way — so they
   * wait here and are flushed, deduped by seq, once the window has landed.
   */
  const held = new Map<string, { data: SequencedPtyData[]; exit: PtyExitMsg | null }>();

  const noteDelivered = (ptyId: string, seq: number) => {
    if (!Number.isFinite(seq)) return;
    const seen = delivered.get(ptyId);
    if (seen === undefined || seq > seen) delivered.set(ptyId, seq);
  };

  /**
   * The link is back. Every pty still on screen is behind by whatever it
   * emitted during the gap, so ask the Core for exactly that and paint it.
   *
   * When the answer starts past where we resumed from, the Core's bounded
   * ring rolled over during the outage: the missing bytes are gone, and
   * appending the tail would put a lie on the screen. Reset the surface and
   * paint the tail as a fresh screen instead.
   */
  const reattach = async (ptyId: string, handlers: PtyStreamHandlers) => {
    const replay = transport.replay;
    if (!replay) return;
    const sinceSeq = (delivered.get(ptyId) ?? -1) + 1;
    held.set(ptyId, { data: [], exit: null });
    let window: { data: string; nextSeq: number; from?: number } | null = null;
    try {
      window = await replay(ptyId, sinceSeq);
    } catch {
      // The link died again mid-reattach. Its own reconnect will bring us back
      // here; what arrived meanwhile is still owed to the screen, so it goes
      // out below rather than being dropped.
    }
    const waiting = held.get(ptyId);
    held.delete(ptyId);
    // A surface that was replaced while the request was in flight owns the
    // screen now — writing any of this into it would corrupt its scrollback.
    if (claims.get(ptyId) !== handlers) return;
    if (window?.data) {
      if (window.from !== undefined && window.from > sinceSeq) handlers.reset?.();
      noteDelivered(ptyId, window.nextSeq - 1);
      handlers.data({ ptyId, data: window.data, seq: window.nextSeq - 1 });
    }
    for (const chunk of waiting?.data ?? []) {
      // The window already carries everything up to `nextSeq`; only what the
      // Core pushed past it is still unpainted.
      if (chunk.seq <= (delivered.get(ptyId) ?? -1)) continue;
      noteDelivered(ptyId, chunk.seq);
      handlers.data({ ptyId, data: chunk.data, seq: chunk.seq });
    }
    if (waiting?.exit) handlers.exit(waiting.exit);
  };

  transport.onReconnect?.(() => {
    for (const [ptyId, handlers] of [...claims]) void reattach(ptyId, handlers);
  });

  const evictOldest = (map: Map<string, unknown>) => {
    while (map.size > MAX_UNCLAIMED_PTYS) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  };

  // Subscribed for the transport's lifetime — this pair replaces the
  // two-listeners-per-pane pattern, it is not a leak.
  transport.onData((msg) => {
    const handlers = claims.get(msg.ptyId);
    if (handlers) {
      const waiting = held.get(msg.ptyId);
      if (waiting) {
        waiting.data.push(sequencedPtyData(msg.seq, msg.data));
        return;
      }
      noteDelivered(msg.ptyId, msg.seq);
      handlers.data(msg);
      return;
    }
    const chunks = pendingData.get(msg.ptyId) ?? [];
    appendBoundedSequencedData(
      chunks,
      sequencedPtyData(msg.seq, msg.data),
      PENDING_OUTPUT_MAX_CHARS,
    );
    pendingData.set(msg.ptyId, chunks);
    evictOldest(pendingData);
  });
  transport.onExit((msg) => {
    const handlers = claims.get(msg.ptyId);
    if (handlers) {
      const waiting = held.get(msg.ptyId);
      if (waiting) {
        waiting.exit = msg;
        return;
      }
      handlers.exit(msg);
      return;
    }
    pendingExit.set(msg.ptyId, msg);
    evictOldest(pendingExit);
  });

  return {
    claim(ptyId, handlers) {
      claims.set(ptyId, handlers);
      return () => {
        if (claims.get(ptyId) !== handlers) return;
        claims.delete(ptyId);
        // The cursor goes with the claim. A surface that takes this pty over
        // later starts from an empty screen and paints it through its own
        // replay (which re-seeds the cursor via `noteReplayed`); keeping a
        // stale cursor would have that surface miss the scrollback entirely.
        delivered.delete(ptyId);
        held.delete(ptyId);
      };
    },
    takePendingData(ptyId) {
      const chunks = pendingData.get(ptyId) ?? [];
      pendingData.delete(ptyId);
      for (const chunk of chunks) noteDelivered(ptyId, chunk.seq);
      return chunks;
    },
    noteReplayed(ptyId, nextSeq) {
      noteDelivered(ptyId, nextSeq - 1);
    },
    takePendingExit(ptyId) {
      const msg = pendingExit.get(ptyId) ?? null;
      pendingExit.delete(ptyId);
      return msg;
    },
  };
}

const routers = new WeakMap<PtyStreamTransport, PtyStreamRouter>();

/** The shared router for a transport (a Core's PTY bridge). */
export function getPtyStreamRouter(transport: PtyStreamTransport): PtyStreamRouter {
  let router = routers.get(transport);
  if (!router) {
    router = createPtyStreamRouter(transport);
    routers.set(transport, router);
  }
  return router;
}
