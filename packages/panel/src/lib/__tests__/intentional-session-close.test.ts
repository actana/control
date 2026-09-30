import { describe, expect, it, beforeEach } from "vitest";
import {
  clearIntentionalSessionCloses,
  consumeIntentionalSessionClose,
  markIntentionalSessionClose,
} from "~/lib/intentional-session-close";

describe("intentional-session-close", () => {
  beforeEach(() => {
    clearIntentionalSessionCloses();
  });

  it("consumes a marked close once", () => {
    markIntentionalSessionClose("session-1");
    expect(consumeIntentionalSessionClose("session-1")).toBe(true);
    expect(consumeIntentionalSessionClose("session-1")).toBe(false);
  });

  it("returns false for unmarked session ids", () => {
    expect(consumeIntentionalSessionClose("session-2")).toBe(false);
  });
});
