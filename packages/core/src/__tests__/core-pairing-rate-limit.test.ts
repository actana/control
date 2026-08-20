// The defence the per-session attempt cap cannot provide (#280, #282).
//
// A session dies after five wrong codes. That bounds guessing inside one
// session and nothing else: an attacker who can open the endpoint at will gets
// five fresh guesses for every session an operator ever opens, as fast as they
// can send them. These tests pin the two windows that close that gap, and the
// memory bound that keeps the closing of it from being its own attack.
import { describe, expect, it } from "vitest";
import { MAX_TRACKED_PEERS, PairingRateLimiter } from "../core-pairing-rate-limit";

function limiterAt(clock: { now: number }, opts: ConstructorParameters<typeof PairingRateLimiter>[0] = {}) {
  return new PairingRateLimiter({ ...opts, now: () => clock.now });
}

describe("the per-peer window", () => {
  it("allows up to the limit and refuses the next", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 3, windowMs: 60_000 } });

    const verdicts = [1, 2, 3, 4].map(() => limiter.check("10.0.0.1"));

    expect(verdicts.map((v) => v.ok)).toEqual([true, true, true, false]);
    expect(verdicts[3]).toMatchObject({ ok: false, scope: "peer" });
  });

  it("does not count a refusal against the caller a second time", () => {
    // Otherwise a caller who keeps knocking extends their own lockout, which is
    // how one office behind one NAT address locks itself out for an afternoon.
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 2, windowMs: 60_000 } });

    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    clock.now += 60_001;

    expect(limiter.check("10.0.0.1").ok).toBe(true);
  });

  it("keeps one peer's spending off another peer's budget", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 2, windowMs: 60_000 } });

    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");

    expect(limiter.check("10.0.0.1").ok).toBe(false);
    expect(limiter.check("10.0.0.2").ok).toBe(true);
  });

  it("lets the window slide off", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 1, windowMs: 60_000 } });

    expect(limiter.check("10.0.0.1").ok).toBe(true);
    expect(limiter.check("10.0.0.1").ok).toBe(false);
    clock.now += 60_001;
    expect(limiter.check("10.0.0.1").ok).toBe(true);
  });

  it("says how long to wait", () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, { peer: { limit: 1, windowMs: 60_000 } });

    limiter.check("10.0.0.1");
    clock.now += 10_000;
    const refused = limiter.check("10.0.0.1");

    expect(refused).toMatchObject({ ok: false, retryAfterMs: 50_000 });
  });
});

describe("the global window", () => {
  it("stops a spray spread across many addresses", () => {
    // The reason keying by address is not the whole answer: every one of these
    // callers is inside its own per-peer limit.
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, {
      peer: { limit: 10, windowMs: 60_000 },
      global: { limit: 5, windowMs: 60_000 },
    });

    const verdicts = Array.from({ length: 6 }, (_, i) => limiter.check(`10.0.0.${i}`));

    expect(verdicts.slice(0, 5).every((v) => v.ok)).toBe(true);
    expect(verdicts[5]).toMatchObject({ ok: false, scope: "global" });
  });

  it("names the peer limit rather than the global one when both would refuse", () => {
    // An operator who has mistyped a code eleven times should be told it was
    // them, not the Core.
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, {
      peer: { limit: 1, windowMs: 60_000 },
      global: { limit: 1, windowMs: 60_000 },
    });

    limiter.check("10.0.0.1");

    expect(limiter.check("10.0.0.1")).toMatchObject({ ok: false, scope: "peer" });
  });
});

describe("the memory bound", () => {
  it("forgets the quietest peers rather than growing without limit", () => {
    // The keys here are chosen by whoever is dialling, on a pre-auth surface.
    // An unbounded map would be an exhaustion attack costing one packet each.
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock, {
      peer: { limit: 1, windowMs: 1_000 },
      global: { limit: Number.MAX_SAFE_INTEGER, windowMs: 60_000 },
    });

    for (let i = 0; i < MAX_TRACKED_PEERS + 50; i += 1) {
      limiter.check(`10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`);
      // Age each caller out of its own window, so eviction has candidates —
      // the case a real Core meets, where the sprayer's earlier addresses have
      // gone quiet by the time the map fills.
      clock.now += 2_000;
    }

    expect(limiter.trackedPeers()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
  });
});
