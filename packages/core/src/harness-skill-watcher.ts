// A Harness that arrives after the Core did still gets the product's skill.
//
// ADR 0031 D7. This is a *subscriber* and nothing else — the probe, the 60s
// tick and the event payload are `harness-availability-store.ts`'s and are
// untouched. Two properties of that event make this less trivial than it looks,
// and both are load-bearing here:
//
//  - **The payload is the full map, not a delta.** The store's own header says
//    so: "The event's payload IS the full map (not a diff) so a Panel replaying
//    only the tail lands on the latest state without stitching." So "a Harness
//    that was missing became available" is not on the wire, and this holds its
//    own last-seen map to compute it.
//  - **The log replays by cursor.** A subscriber that re-reads history must not
//    read a replayed transition as a fresh one. Two guards, either of which
//    would do, kept together because they fail differently: an event id at or
//    below the highest already processed is ignored outright, and a map equal to
//    the last-seen one produces no transitions even if it arrives out of order.
//
// The first map this ever sees is not a transition. A Core that boots with
// Claude Code already installed has not just gained it, and the boot-time
// ensure has already run — treating the first observation as an arrival would
// mean every Core wrote the skill twice on every start.

import log from "@actana/shared/log";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core-link-frames";
import { HARNESSES_AVAILABILITY_EVENT_KIND } from "@actana/sdk/core-link-frames";

export type HarnessSkillWatcherOptions = {
  /** Write or repair the copies. Called with no arguments; the Core supplies home. */
  ensure: () => void;
  /**
   * Seed the last-seen map, so the first live event is compared against the
   * state at boot rather than against nothing.
   *
   * Optional because a Core with no availability store yet is a Core whose first
   * event is genuinely its first news.
   */
  initial?: CoreLinkHarnessAvailabilityMap;
};

/** The shape the store serialises: `{availability: {harness: {status, …}}}`. */
type AvailabilityEnvelope = { availability?: CoreLinkHarnessAvailabilityMap };

export class HarnessSkillWatcher {
  private readonly ensure: () => void;
  private lastSeen: CoreLinkHarnessAvailabilityMap | null;
  private highestEventId = 0;

  constructor(options: HarnessSkillWatcherOptions) {
    this.ensure = options.ensure;
    this.lastSeen = options.initial ?? null;
  }

  /**
   * Offer one event. Returns the harnesses that newly became available, which
   * is what the tests assert on and what the log line names.
   *
   * Everything that is not this event kind, not parseable, not past the highest
   * id already seen, or not a change is a no-op — in that order, because the
   * cheapest rejection should come first on a path that sees every event the
   * Core appends.
   */
  observe(kind: string, payload: string, eventId: number): string[] {
    if (kind !== HARNESSES_AVAILABILITY_EVENT_KIND) return [];
    if (eventId <= this.highestEventId) return [];

    const next = parseAvailability(payload);
    // A payload this build cannot read is a Core saying something in a shape
    // this one does not know. Advancing past it would be treating "I did not
    // understand" as "nothing changed", so the id is left alone.
    if (next === null) return [];
    this.highestEventId = eventId;

    const previous = this.lastSeen;
    this.lastSeen = next;
    // First observation: the state at boot, not an arrival. See the header.
    if (previous === null) return [];

    const arrived = Object.keys(next).filter(
      (harness) =>
        next[harness]?.status === "available" && previous[harness]?.status !== "available",
    );
    if (arrived.length === 0) return [];

    log.info("core-skill.harness-arrived", { harnesses: arrived.join(",") });
    this.ensure();
    return arrived;
  }
}

function parseAvailability(payload: string): CoreLinkHarnessAvailabilityMap | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;
    const map = (parsed as AvailabilityEnvelope).availability;
    return map && typeof map === "object" ? map : null;
  } catch {
    return null;
  }
}
