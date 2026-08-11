// Whether this browser tab may type into a Session, and — when it may not —
// which of the two entirely different reasons it is (issue 147, ADR 0024 D3/D8).
//
// **Two names, because there are two things.** They are settled in different
// places, by different parties, and a bug report that confuses them is a bug
// report nobody can act on:
//
// **The Session lock** is Core-scoped and crosses the wire. One Core client
// holds it; the Panel is one Core client however many browser tabs it is
// serving, so the lock says whether *the Panel* may write. It is claimed,
// released and force-taken with core-link frames, published on every Session
// snapshot as `{ writable, state }`, and every change appends a
// `session:lockChanged` event (ADR 0024 D3–D8). The holder that is not us is
// "another client", and it is never named.
//
// **The Session drive** is Panel-scoped and crosses nothing. The Panel holds
// one Session lock for all its tabs, so which of them drives is the Panel's own
// business — settled between Panel sessions, inside the Panel, exactly as D3
// says. It has no frames on the core-link, appears in no event log, and no Core
// ever hears of it.
//
// So a tab writes when the Panel holds the write (the lock) *and* this tab is
// the one holding the keyboard (the drive). Losing either is read-only, and the
// two read as different sentences to the operator: a Session **held** by
// another client, or a Session **driven** in another tab.

import type { CoreLinkSessionLockState } from "@actana/shared/core-link-frames";

/**
 * The Session lock as it applies to this Panel, which is what its tabs are told.
 *
 * `state` and `writable` are the Core's own published answer, addressed to the
 * Panel's connection (ADR 0024 D8) — `writable` is carried rather than derived
 * because *which states are writable* is a Core-side rule, and `state` is what
 * an affordance is chosen from.
 *
 * `supported` is this Panel's addition, and it is not a third lock state. It
 * says whether the Core announced `multiConnection` at all. **A Core without
 * the capability is not locked and never renders read-only**: it evicts every
 * client but one, so the Panel is its only client and every mutation it makes
 * is served. Conflating `supported: false` with `writable: false` would show a
 * permanently locked Session to an operator who is that Core's only client —
 * the failure the core-link client's `claim` doc warns about, one layer up.
 */
export type PanelSessionLock = {
  /** Does this Core have a lock table at all — did it announce `multiConnection`? */
  supported: boolean;
  /** May the Panel mutate this Session right now? True when unsupported. */
  writable: boolean;
  /** Which of the three states, from the Panel's side. `unlocked` when unsupported. */
  state: CoreLinkSessionLockState;
};

/** What a Core with no lock table reads as: writable, unlocked, no affordances. */
export const UNSUPPORTED_SESSION_LOCK: PanelSessionLock = {
  supported: false,
  writable: true,
  state: "unlocked",
};

/**
 * Where this tab stands in the Panel's own arbitration for one Session.
 *
 * `driving` — this tab holds the keyboard. `following` — another tab of this
 * same Panel does. `none` — nobody in this Panel has asked to drive this
 * Session, which is what every tab reads on a Core with no `multiConnection`
 * capability, and is writable: there is no arbitration to lose.
 */
export type SessionDriveState = "driving" | "following" | "none";

/**
 * May this tab type into this Session, and if not, why not.
 *
 * `read-only` reasons are deliberately exhaustive and deliberately separate.
 * `held-by-another-client` is the Session lock: another Core client — a CLI, an
 * automation, another Panel — holds this Session, and getting past it is a
 * force takeover over the wire. `driven-in-another-tab` is the drive: this
 * Panel may well hold the lock, and the keyboard is simply in another tab of
 * it, which is a Panel-local handover that no Core hears about.
 */
export type SessionReadOnlyReason = "held-by-another-client" | "driven-in-another-tab";

export type SessionWriteAccess =
  | { writable: true }
  | { writable: false; reason: SessionReadOnlyReason };

/**
 * The one place the two are combined, so no call site invents its own order.
 *
 * The lock is answered first and it is the stronger answer: a tab that neither
 * holds the drive nor may write at all is told about the client that has the
 * Session, because that is the fact it would have to act on — taking the drive
 * from its own other tab would leave it exactly as read-only as it is now.
 */
export function sessionWriteAccess(opts: {
  lock: PanelSessionLock;
  drive: SessionDriveState;
}): SessionWriteAccess {
  if (!opts.lock.writable) return { writable: false, reason: "held-by-another-client" };
  if (opts.drive === "following") return { writable: false, reason: "driven-in-another-tab" };
  return { writable: true };
}

/**
 * The label a read-only terminal wears, before anybody types into it.
 *
 * Short enough for a header chip, and it names *which* of the two it is —
 * "held" for the cross-client lock, "driven" for the intra-Panel drive. The
 * words are not interchangeable and are not meant to read as synonyms.
 */
export function readOnlyLabel(reason: SessionReadOnlyReason): string {
  return reason === "held-by-another-client"
    ? "Read-only · held by another client"
    : "Read-only · driven in another tab";
}

/**
 * The sentence under the label, saying what would change it.
 *
 * Two reasons, two remedies, and they are not the same gesture: one is a force
 * takeover across the wire that costs another client its Session, the other is
 * this Panel handing its own keyboard from one tab to another.
 */
export function readOnlyDetail(reason: SessionReadOnlyReason): string {
  return reason === "held-by-another-client"
    ? "Another Core client holds this Session's write lock. You are seeing every byte and sending none."
    : "Another tab of this Panel is driving this Session. Take the keyboard here to type.";
}

/**
 * What the loser of an intra-Panel handover is told.
 *
 * A different event from {@link takenOverToast} with different copy, and they
 * must not be collapsed: nothing was taken from the operator here — they moved
 * their own keyboard, in their own Panel, and this tab is telling them where it
 * went. Nothing was lost and nothing crossed the wire.
 */
export function driveMovedToast(sessionTitle: string): { title: string; detail: string } {
  return {
    title: `Now following “${sessionTitle}”`,
    detail: "You took the keyboard for this Session in another tab of this Panel.",
  };
}

/**
 * What the loser of a cross-client force takeover is told.
 *
 * The other event. Another Core client took this Session's lock, this Panel did
 * not agree to it, and it is unrecoverable by design — the in-flight keystrokes
 * are gone (ADR 0024 D7, known risks). The copy says so, and names no holder,
 * because the wire does not carry one (D8, D10).
 */
export function takenOverToast(sessionTitle: string): { title: string; detail: string } {
  return {
    title: `“${sessionTitle}” was taken over`,
    detail: "Another Core client took this Session's write lock. Anything you had not sent is gone.",
  };
}

/**
 * The third notice, and the mildest: another Core client claimed a Session this
 * Panel had open but was not holding.
 *
 * Distinct from {@link takenOverToast} for the same reason the wire draws the
 * distinction (`claimed` vs `taken-over`): nothing was taken, because this
 * Panel held nothing. An unlocked Session is writable by anybody, so the
 * operator may well have been typing into it a second ago — which is why they
 * are told at all — but reporting it as a takeover would say somebody overrode
 * them when somebody simply arrived first.
 */
export function lockClaimedElsewhereToast(sessionTitle: string): {
  title: string;
  detail: string;
} {
  return {
    title: `“${sessionTitle}” is now read-only`,
    detail: "Another Core client claimed this Session's write lock. You are still seeing every byte.",
  };
}

/**
 * Which cross-client notice a lock answer earns, if any.
 *
 * `before` is the last **settled** answer this pane had for the Session — a
 * state the Core actually published — and `null` means it has never had one.
 * That distinction is the whole function. A pane opened on a Session another
 * client has been holding all along has *learned* a lock, not *lost* one, and
 * the state it was seeded with is a default, not evidence the Session was ever
 * free. Announcing a takeover off it would report an event that did not happen
 * — on every such open, and again on every core-link flap, since a new link
 * empties the register and re-seeds it from the first snapshot.
 *
 * Which of the two lines a real change gets turns on whether this Panel was
 * holding the lock, because reporting an eviction that did not happen is the
 * thing the wire's own `takenFrom` exists to prevent.
 */
export function crossClientLockNotice(opts: {
  before: CoreLinkSessionLockState | null;
  now: CoreLinkSessionLockState;
  sessionTitle: string;
}): { title: string; detail: string } | null {
  if (opts.now !== "held-by-another") return null;
  if (opts.before === null || opts.before === "held-by-another") return null;
  return opts.before === "held-by-you"
    ? takenOverToast(opts.sessionTitle)
    : lockClaimedElsewhereToast(opts.sessionTitle);
}

/**
 * The confirmation a force takeover is put behind, naming what is being taken.
 *
 * It names the Session, because "are you sure?" over an unnamed thing is a
 * dialog operators learn to dismiss — and with a grid of panes on screen there
 * is genuinely more than one thing it could be about. It does not name the
 * holder: the wire never says who that is (D8/D10), and inventing a name here
 * would be the identity leak the published lock exists to avoid.
 */
export function forceTakeoverConfirmation(sessionTitle: string): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: `Take over “${sessionTitle}”?`,
    body:
      `Another Core client is holding “${sessionTitle}”. Taking it over ends their hold immediately: ` +
      "anything they had typed and not sent is lost, and their next keystroke is refused. This cannot be undone.",
    confirmLabel: "Take over",
  };
}
