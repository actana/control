import { afterEach, describe, expect, it, vi } from "vitest";
import { newClientId, isClientDomainId } from "../client-id";
import { randomHex } from "../random-hex";
import { shortId } from "../short-id";

// Ids that name a Session are built from the platform's CSPRNG, never Math.random
// (CodeQL js/insecure-randomness flagged the renamed `sessionId` flows). Asserted by
// making Math.random throw: a regression to it fails here rather than in a scan.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ids that name a Session", () => {
  it("randomHex is lowercase hex of the asked length", () => {
    expect(randomHex(3)).toMatch(/^[0-9a-f]{6}$/);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not repeat across a thousand draws", () => {
    expect(new Set(Array.from({ length: 1000 }, () => randomHex(8))).size).toBe(1000);
  });

  it("newClientId and shortId never touch Math.random", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random used for an id");
    });
    expect(isClientDomainId(newClientId("t"))).toBe(true);
    expect(shortId("s")).toMatch(/^s-[a-z0-9]+-[0-9a-f]{10}$/);
  });
});
