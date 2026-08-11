import { describe, expect, it } from "vitest";
import {
  UNSUPPORTED_SESSION_LOCK,
  driveMovedToast,
  forceTakeoverConfirmation,
  lockClaimedElsewhereToast,
  readOnlyDetail,
  readOnlyLabel,
  sessionWriteAccess,
  takenOverToast,
  type PanelSessionLock,
  type SessionDriveState,
} from "../session-write-access";

// The two names, and what the operator is told about each. Most of issue 147's
// traps are copy decisions, and copy that drifts is exactly how "read-only"
// becomes a word nobody can act on in a bug report.

function lock(
  state: PanelSessionLock["state"],
  opts: { supported?: boolean } = {},
): PanelSessionLock {
  return {
    supported: opts.supported !== false,
    writable: state !== "held-by-another",
    state,
  };
}

function access(state: PanelSessionLock["state"], drive: SessionDriveState) {
  return sessionWriteAccess({ lock: lock(state), drive });
}

describe("who may write", () => {
  it("lets the driving tab write an unlocked Session — today's behaviour, kept", () => {
    // ADR 0024 D11: a Session nobody claimed is writable by anybody, and that
    // is the promise that keeps every client predating the lock working.
    expect(access("unlocked", "driving")).toEqual({ writable: true });
    expect(access("unlocked", "none")).toEqual({ writable: true });
  });

  it("lets the driving tab write a Session this Panel holds", () => {
    expect(access("held-by-you", "driving")).toEqual({ writable: true });
  });

  it("makes a Session another Core client holds read-only, and says which reason", () => {
    expect(access("held-by-another", "driving")).toEqual({
      writable: false,
      reason: "held-by-another-client",
    });
  });

  it("makes a following tab read-only for the other reason entirely", () => {
    expect(access("held-by-you", "following")).toEqual({
      writable: false,
      reason: "driven-in-another-tab",
    });
  });

  it("reports the lock first when both are true — it is the fact to act on", () => {
    // Taking the drive from this Panel's own other tab would leave this one
    // exactly as read-only as it is, so the lock is what the operator is told.
    expect(access("held-by-another", "following")).toEqual({
      writable: false,
      reason: "held-by-another-client",
    });
  });

  it("never renders read-only on a Core with no lock table", () => {
    // `supported: false` is the opposite of `granted: false`. Conflating them
    // shows a permanently locked Session to the operator who is that Core's
    // only client.
    expect(UNSUPPORTED_SESSION_LOCK.writable).toBe(true);
    expect(sessionWriteAccess({ lock: UNSUPPORTED_SESSION_LOCK, drive: "none" })).toEqual({
      writable: true,
    });
  });
});

describe("what the operator reads", () => {
  it("names which of the two it is, in words that are not synonyms", () => {
    expect(readOnlyLabel("held-by-another-client")).toMatch(/held/i);
    expect(readOnlyLabel("driven-in-another-tab")).toMatch(/driven/i);
    expect(readOnlyLabel("held-by-another-client")).not.toBe(
      readOnlyLabel("driven-in-another-tab"),
    );
  });

  it("offers a different remedy for each, because they are different gestures", () => {
    expect(readOnlyDetail("held-by-another-client")).not.toBe(
      readOnlyDetail("driven-in-another-tab"),
    );
    expect(readOnlyDetail("held-by-another-client")).toMatch(/another Core client/i);
    expect(readOnlyDetail("driven-in-another-tab")).toMatch(/another tab/i);
  });

  it("keeps the two losers' notices apart", () => {
    const handover = driveMovedToast("Ship the thing");
    const takeover = takenOverToast("Ship the thing");
    expect(handover.title).not.toBe(takeover.title);
    expect(handover.detail).not.toBe(takeover.detail);
    // The intra-Panel one says nothing was taken and nothing was lost, because
    // nothing was: the operator moved their own keyboard between their own tabs.
    expect(handover.detail).toMatch(/another tab of this Panel/i);
    expect(handover.detail).not.toMatch(/gone|lost|took over/i);
    // The cross-client one says what it cost, because a takeover is
    // unrecoverable by design (ADR 0024 D7).
    expect(takeover.detail).toMatch(/gone/i);
  });

  it("does not call another client's claim a takeover", () => {
    // The wire draws this distinction itself (`claimed` vs `taken-over`) so no
    // client reports an eviction that did not happen.
    const claimed = lockClaimedElsewhereToast("Ship the thing");
    expect(claimed.title).not.toBe(takenOverToast("Ship the thing").title);
    expect(claimed.detail).not.toMatch(/took over|gone/i);
  });

  it("names both losers' Sessions, so a grid of panes is not ambiguous", () => {
    expect(driveMovedToast("Ship the thing").title).toContain("Ship the thing");
    expect(takenOverToast("Ship the thing").title).toContain("Ship the thing");
  });
});

describe("the force takeover's confirmation", () => {
  const confirmation = forceTakeoverConfirmation("Ship the thing");

  it("names what is being taken", () => {
    expect(confirmation.title).toContain("Ship the thing");
    expect(confirmation.body).toContain("Ship the thing");
  });

  it("names the consequence, and that it cannot be undone", () => {
    expect(confirmation.body).toMatch(/lost/i);
    expect(confirmation.body).toMatch(/cannot be undone/i);
  });

  it("does not name the holder — the wire never says who that is", () => {
    // ADR 0024 D8/D10: `held-by-another` is the whole of what a watcher learns
    // about a holder that is not itself. A name invented here would be the
    // identity leak the published lock is written to avoid.
    expect(confirmation.body).toMatch(/another Core client/i);
    expect(confirmation.title + confirmation.body).not.toMatch(/\bpanel\b.*\bholds\b/i);
  });
});
