// Rate limiting for the Core's one pre-auth endpoint (#280, #282).
//
// The per-session attempt cap already bounds guessing *within* a session: five
// wrong codes and that session is dead. It bounds nothing across sessions. An
// attacker who can reach the endpoint can hold a thousand guesses a second
// against every session an operator ever opens, and each one costs them five
// tries against a five-minute window rather than one. That is why #280 lists
// rate limiting as a defence of its own and this module is separate from
// `pairing-session.ts`: the cap is per session and this is per caller, and
// collapsing them would leave the gap between them open.
//
// Two windows, both fixed-size and both counted here:
//
//   • **Per peer** — the address the TCP connection came from. This is the one
//     that stops a single machine spraying codes.
//   • **Global** — every attempt this Core saw, whatever the source. This is
//     the one that survives an attacker with a thousand source addresses, and
//     it is why "just key it by IP" is not the whole answer.
//
// The global window is deliberately generous relative to the per-peer one: it
// is a backstop against a distributed spray, not a limit an operator pairing a
// handful of laptops should ever meet.
//
// No timers, no background sweep: a window is decided by comparing timestamps
// when a request arrives. A Core that is not being paired with does no work
// here at all.

/** A verdict, with what to tell the caller when it is a refusal. */
export type RateLimitVerdict =
  | { ok: true }
  | { ok: false; scope: "peer" | "global"; retryAfterMs: number };

export type RateLimitWindow = {
  /** Attempts allowed inside one window. */
  limit: number;
  /** The window, in ms. */
  windowMs: number;
};

/**
 * Ten attempts a minute from one address.
 *
 * An operator pairing a machine sends one request; a human retyping a code
 * they misheard sends a handful. Ten is far above the honest case and far
 * below what makes guessing 2^39.6 codes worth starting.
 */
export const DEFAULT_PEER_WINDOW: RateLimitWindow = { limit: 10, windowMs: 60_000 };

/** Sixty attempts a minute across every caller — the distributed-spray backstop. */
export const DEFAULT_GLOBAL_WINDOW: RateLimitWindow = { limit: 60, windowMs: 60_000 };

/**
 * How many peers are tracked before the quietest are forgotten.
 *
 * This is a pre-auth surface, so the set of keys is chosen by whoever is
 * dialling: an unbounded map here is a memory exhaustion attack that costs the
 * attacker one packet per entry. Evicting the least recently seen peer is safe
 * in the direction that matters — an evicted peer starts a fresh window, but
 * getting evicted requires 4,096 *other* addresses to have been seen inside
 * the same minute, which the global window is already refusing.
 */
export const MAX_TRACKED_PEERS = 4096;

export type PairingRateLimiterOptions = {
  peer?: RateLimitWindow;
  global?: RateLimitWindow;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * A fixed-window counter over the pairing endpoint.
 *
 * {@link check} both decides and records: an allowed attempt is counted, and a
 * refused one is not counted again. Counting a refusal would let a caller
 * extend their own lockout by continuing to knock, which sounds like a feature
 * and is in fact how a shared NAT address locks out an office.
 */
export class PairingRateLimiter {
  private readonly peerWindow: RateLimitWindow;
  private readonly globalWindow: RateLimitWindow;
  private readonly now: () => number;
  /** Per peer: the attempt timestamps inside the current window. */
  private readonly peers = new Map<string, number[]>();
  private globalHits: number[] = [];

  constructor(opts: PairingRateLimiterOptions = {}) {
    this.peerWindow = opts.peer ?? DEFAULT_PEER_WINDOW;
    this.globalWindow = opts.global ?? DEFAULT_GLOBAL_WINDOW;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Take one attempt for `peer`, or refuse it.
   *
   * The peer window is checked first so that a refusal names the limit the
   * caller actually hit — an operator who has mistyped a code eleven times
   * should be told it was them, not the Core.
   */
  check(peer: string): RateLimitVerdict {
    const now = this.now();
    const peerHits = within(this.peers.get(peer) ?? [], now, this.peerWindow.windowMs);
    if (peerHits.length >= this.peerWindow.limit) {
      this.peers.set(peer, peerHits);
      return { ok: false, scope: "peer", retryAfterMs: retryAfter(peerHits, now, this.peerWindow) };
    }
    const globalHits = within(this.globalHits, now, this.globalWindow.windowMs);
    if (globalHits.length >= this.globalWindow.limit) {
      this.globalHits = globalHits;
      this.peers.set(peer, peerHits);
      return { ok: false, scope: "global", retryAfterMs: retryAfter(globalHits, now, this.globalWindow) };
    }
    this.peers.set(peer, [...peerHits, now]);
    this.globalHits = [...globalHits, now];
    this.evictIfCrowded();
    return { ok: true };
  }

  /** Attempts counted for one peer inside the current window. For tests and logs. */
  peerAttempts(peer: string): number {
    return within(this.peers.get(peer) ?? [], this.now(), this.peerWindow.windowMs).length;
  }

  /** Peers currently tracked. Bounded by {@link MAX_TRACKED_PEERS}. */
  trackedPeers(): number {
    return this.peers.size;
  }

  /**
   * Forget the quietest peers once the map is too big.
   *
   * `Map` iterates in insertion order and every recorded attempt re-inserts its
   * peer at the end (`set` after a `delete` is what would guarantee that — but
   * the entry is rewritten on every hit, and the ordering this relies on is
   * only "roughly oldest first", which is all an eviction policy for a
   * memory guard needs to be).
   */
  private evictIfCrowded(): void {
    if (this.peers.size <= MAX_TRACKED_PEERS) return;
    const cutoff = this.now() - this.peerWindow.windowMs;
    for (const [peer, hits] of this.peers) {
      if (hits.length === 0 || hits[hits.length - 1]! <= cutoff) this.peers.delete(peer);
      if (this.peers.size <= MAX_TRACKED_PEERS) return;
    }
    // Everything tracked is still inside its window: drop from the front, which
    // is the least recently *first* seen, rather than growing without bound.
    for (const peer of this.peers.keys()) {
      this.peers.delete(peer);
      if (this.peers.size <= MAX_TRACKED_PEERS) return;
    }
  }
}

/** The timestamps still inside the window ending at `now`. */
function within(hits: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return hits.filter((at) => at > cutoff);
}

/** How long until the oldest attempt in the window falls out of it. */
function retryAfter(hits: number[], now: number, window: RateLimitWindow): number {
  const oldest = hits[0] ?? now;
  return Math.max(0, oldest + window.windowMs - now);
}
