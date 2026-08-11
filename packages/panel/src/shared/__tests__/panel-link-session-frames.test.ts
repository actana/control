import { describe, expect, it } from "vitest";
import {
  PANEL_LINK_PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  encodePanelLinkFrame,
} from "../panel-link";

// The two frames issue 147 adds to the panel link, and the promise that adding
// them keeps: a tab built before them behaves exactly as it does today.

describe("the drive frame (browser → Panel)", () => {
  it("survives a round trip", () => {
    const frame = { t: "drive", coreId: "core_a", taskId: "t1", want: "take" } as const;
    expect(decodeClientFrame(encodePanelLinkFrame(frame))).toEqual(frame);
  });

  it("refuses a want it does not know, rather than guessing at one", () => {
    // A frame the service cannot read is ignored and the socket kept — a tab
    // with a bug is not an attacker, and dropping its link would take its
    // terminals with it.
    expect(
      decodeClientFrame(
        JSON.stringify({ t: "drive", coreId: "core_a", taskId: "t1", want: "steal" }),
      ),
    ).toBeNull();
    expect(
      decodeClientFrame(JSON.stringify({ t: "drive", coreId: "core_a", want: "watch" })),
    ).toBeNull();
  });

  it("leaves the core frame path exactly as it was", () => {
    const frame = {
      t: "core",
      coreId: "core_a",
      frame: { type: "tasksList", reqId: "q1" },
    } as const;
    expect(decodeClientFrame(encodePanelLinkFrame(frame))).toEqual(frame);
  });
});

describe("the lock frame (Panel → browser)", () => {
  it("survives a round trip", () => {
    const frame = {
      t: "lock",
      coreId: "core_a",
      taskId: "t1",
      lock: { supported: true, writable: false, state: "held-by-another" },
    } as const;
    expect(decodeServerFrame(encodePanelLinkFrame(frame))).toEqual(frame);
  });

  it("never turns a Session nobody holds into a read-only one", () => {
    // `writable` is carried rather than derived, because which states are
    // writable is a Core-side rule. A frame that arrived without it still must
    // not invent a lock: that is the single worst thing this field can be wrong
    // about, and it is the failure the vocabulary is written against.
    const decoded = decodeServerFrame(
      JSON.stringify({ t: "lock", coreId: "core_a", taskId: "t1", lock: { state: "unlocked" } }),
    );
    expect(decoded).toMatchObject({ lock: { writable: true, state: "unlocked" } });
  });

  it("refuses a state it does not know rather than rendering one", () => {
    expect(
      decodeServerFrame(
        JSON.stringify({ t: "lock", coreId: "core_a", taskId: "t1", lock: { state: "maybe" } }),
      ),
    ).toBeNull();
  });
});

describe("the drive frame (Panel → browser)", () => {
  it("survives a round trip, reason and all", () => {
    const frame = {
      t: "drive",
      coreId: "core_a",
      taskId: "t1",
      driving: false,
      reason: "handover",
    } as const;
    expect(decodeServerFrame(encodePanelLinkFrame(frame))).toEqual(frame);
  });

  it("falls back to the plain reason for anything it does not recognise", () => {
    // `handover` is the one that gets a sentence in front of the operator, so
    // an unfamiliar reason must never be read as one.
    const decoded = decodeServerFrame(
      JSON.stringify({ t: "drive", coreId: "core_a", taskId: "t1", driving: false, reason: "?" }),
    );
    expect(decoded).toMatchObject({ reason: "watch" });
  });
});

describe("the protocol version", () => {
  it("does not move for either frame", () => {
    // Purely additive, on the same test the core-link's capability rule uses:
    // a tab left open across a Panel upgrade sends no `drive` frame, so it is
    // never arbitrated against, and it drops a `lock` frame it cannot read.
    expect(PANEL_LINK_PROTOCOL_VERSION).toBe(1);
  });

  it("leaves an unknown frame unread rather than half-read", () => {
    expect(decodeServerFrame(JSON.stringify({ t: "something-new", coreId: "core_a" }))).toBeNull();
  });
});
