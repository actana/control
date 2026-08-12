// The id the Panel presents on every core link it opens (ADR 0024 D9, #156).
//
// One string, and the two properties that make it worth having. It survived the
// move onto `@actana/sdk`'s durable Core client deliberately: that package mints
// `sdk-…`, which is the honest name for a client it knows nothing else about,
// and the Panel is a client the Core has always been able to name. Once the
// `actana` CLI ships on the same package the prefix is the only thing telling
// the two apart on a Core serving both.

import { describe, it, expect } from "vitest";
import { mintPanelCoreClientId } from "../core-link-manager";

describe("the Panel's Core client id", () => {
  it("names the Panel, so a reclaim on the Core is not an opaque token", () => {
    expect(mintPanelCoreClientId()).toMatch(/^panel-/);
  });

  it("is different every time, because two links must never collide", () => {
    // And random rather than derived: every input that would make it stable
    // across processes — the endpoint, the coreId, the bearer — is shared by
    // every client dialing that machine, which is the one shape D9 forbids.
    const ids = new Set(Array.from({ length: 50 }, () => mintPanelCoreClientId()));

    expect(ids.size).toBe(50);
  });
});
