// Learning where a Core's event log currently ends.
//
// Two commands need this number and neither can be told it: there is no "what
// is your tip" frame on the core link. `events tail` needs it because a first
// run starts at the end of the log the way `tail -f` does, and `harness install`
// needs it because an install that failed an hour ago is still in the log and
// must not be read as this one's verdict.
//
// The one way the tip is published is the replay: `subscribe { lastEventId }`,
// the Core streams the tail past that id, and `eventsReplayed { lastEventId }`
// closes it. **That marker is not always the tip**, which is the defect the
// review of #205 blocked on. `PtyCoreLinkServer.handleSubscribe` reads the tail
// with `readEventTail(fromEventId, EVENT_TAIL_LIMIT)` and reports the id of the
// last event it *actually sent* (`packages/core/src/pty-core-link-server.ts`,
// `EVENT_TAIL_LIMIT` at :377 and the handler at :1543). When the tail past the
// cursor is longer than that cap the marker is a partial one, and the rest of
// the history then arrives through `pushLiveEvents` as ordinary `event` frames
// with no second marker behind them. Nothing prunes `event_log_store`, so a
// Core that has been up a while is the normal case, not an edge:
//
//   • `events tail` would switch printing on at the cap and then print the
//     remaining history — the replay storm, produced deliberately on the first
//     command an operator types.
//   • `harness install` would pin its tip at the cap, and a `harness:installFailed`
//     for the same Harness from an hour ago, sitting past it, would be reported
//     as this install's outcome. The mirror case is worse: a stale
//     `agents:availabilityChanged` carrying a map where the Harness was
//     available exits 0 on an install that never happened.
//
// So a marker is treated as a *receipt for what was sent*, never as the tip,
// and this asks again from the new cursor until one closes an **empty** tail.
// An empty tail is the Core saying it has nothing past the cursor, which is the
// only sentence that means "this is the end" — and it means it whatever the cap
// is set to.
//
// **Not by mirroring `EVENT_TAIL_LIMIT` here**, which is the other way to write
// this. A copy of that constant would be a second opinion about a number that
// lives in another package, and the two failure directions are not symmetrical:
// a copy that is *higher* than the Core's reads a full tail as a short one and
// silently restores exactly this bug, on a Core nobody thought had changed.
// Asking until the answer is empty costs one extra round trip and cannot drift.
//
// **Not by having the Core report `getLastEventId()` in the marker either**,
// which the review names as the tempting fix: that advances the client's cursor
// past events it has never been sent, trading a replay storm for silent loss.
// The clean version of that — the true tip carried on `subscribeAck` as a field
// *beside* `fromEventId`, which no cursor consumes — is a protocol change, and
// this ticket is not where the wire format moves.

import type { CoreLinkClient } from "./core-connection.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";

/**
 * How many times a tip hunt will re-ask before it settles for what it has.
 *
 * The loop ends on an empty tail, and a Core appending events faster than this
 * side can drain them might never produce one. 200 rounds is far past any real
 * log — the Core serves up to a thousand events per round — so reaching it means
 * a Core in a hot loop, and the answer then is to carry on from the highest
 * event actually seen and *say so*, rather than to hang or to quietly pretend
 * the number is exact.
 */
const MAX_TIP_ROUNDS = 200;

export type EventTipTracker = {
  /**
   * Feed every event delivered while the tip is still unknown, replayed or
   * live. Counting them is how the next marker is read: a marker that closes a
   * tail with events in it is a receipt, not the end.
   */
  saw(eventId: number): void;
  /**
   * Feed each `eventsReplayed` marker.
   *
   * Returns the Core's tip when this marker is the end of the log, and null
   * when it is not — in which case a fresh `subscribe` has already gone out for
   * whatever is past it and another marker is coming.
   */
  tipFrom(lastEventId: number): number | null;
  /** The highest event id seen so far, marker or event. */
  highest(): number;
};

export type EventTipOptions = {
  /**
   * Called when a re-`subscribe` could not be sent, which means the socket has
   * gone. A durable client re-subscribes from its own cursor on the next
   * connection and can wait; a one-shot client cannot, and passes a reject.
   */
  onSendFailed?: () => void;
};

/**
 * Track the replay markers on one client until one of them is the log's tip.
 *
 * Deliberately not a promise: `events tail` has to keep suppressing output
 * across an unknown number of rounds *and* keep serving its own listeners
 * meanwhile, so the caller keeps its event loop and feeds this the two frames
 * it cares about.
 */
export function trackEventTip(
  client: Pick<CoreLinkClient, "subscribeEvents">,
  deps: Pick<ActanaCliDeps, "verbose" | "err">,
  opts: EventTipOptions = {},
): EventTipTracker {
  let inTail = 0;
  let seen = 0;
  let rounds = 0;

  return {
    saw: (eventId) => {
      inTail += 1;
      if (eventId > seen) seen = eventId;
    },
    highest: () => seen,
    tipFrom: (lastEventId) => {
      const delivered = inTail;
      inTail = 0;
      if (lastEventId > seen) seen = lastEventId;

      // The end of the log: the Core had nothing past the cursor it was given.
      if (delivered === 0) return seen;

      if (rounds >= MAX_TIP_ROUNDS) {
        // Stated rather than swallowed. This is the one path where the number
        // handed back is approximate, and an operator reading a surprising
        // first line deserves the reason on stderr.
        deps.err(
          `this Core appended events faster than they could be read (${MAX_TIP_ROUNDS} rounds); ` +
            `carrying on from #${seen}, which may be behind its log's end.`,
        );
        return seen;
      }

      rounds += 1;
      deps.verbose(`the Core sent ${delivered} event(s) up to #${seen}; asking for anything past it`);
      if (!client.subscribeEvents(seen)) {
        opts.onSendFailed?.();
        return null;
      }
      return null;
    },
  };
}
