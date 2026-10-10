import { describe, expect, it, vi } from "vitest";
import { HarnessAvailabilityStore } from "../harness-availability-store";
import { HARNESSES_AVAILABILITY_EVENT_KIND } from "@actana/sdk/core";
import { HARNESS_REGISTRY, UI_HARNESSES } from "@actana/shared/harnesses";
import { offerableHarnessIds } from "@actana/shared/actana-harnesses";
import type { Harness } from "@actana/shared/domain";

type AppendEventFn = (
  kind: string,
  payload: string,
  opts?: { ptyId?: string | null; sessionId?: string | null },
) => number;

// Issue 11: the Core-side probe publishes CLI availability as (a) a live
// snapshot readable via `agentsAvailabilityList` and (b) an
// `agents:availabilityChanged` event on the monotonic event log. The store's
// contract: emit exactly one event when the probe result changes, none when it
// doesn't. Reconnecting Panels then catch up through the standard event-log
// replay path — the payload is self-contained so a Panel that misses N
// intermediate ticks lands on the latest state without stitching.

describe("HarnessAvailabilityStore", () => {
  it("emits one agents:availabilityChanged event on the first probe", () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const store = new HarnessAvailabilityStore({
      appendEvent,
      tickMs: 60_000,
      probe: (agent) => ({
        status: "available",
        path: `/usr/bin/${agent}`,
        version: "1.0.0",
      }),
    });
    store.runProbe();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    const [kind, payload, opts] = appendEvent.mock.calls[0];
    expect(kind).toBe(HARNESSES_AVAILABILITY_EVENT_KIND);
    expect(opts).toEqual({ ptyId: null, sessionId: null });
    const parsed = JSON.parse(payload as string) as {
      availability: Record<string, { status: string; version?: string }>;
    };
    for (const agent of UI_HARNESSES) {
      expect(parsed.availability[agent]).toEqual({
        status: "available",
        path: `/usr/bin/${agent}`,
        version: "1.0.0",
      });
    }
  });

  it("does not re-emit when the probe returns an equal map", () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const store = new HarnessAvailabilityStore({
      appendEvent,
      tickMs: 60_000,
      probe: () => ({ status: "available", path: "/x" }),
    });
    store.runProbe();
    store.runProbe();
    store.runProbe();
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  it("re-emits when one agent's availability changes between ticks", () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const first: Record<Harness, ReturnType<typeof mkEntry>> = Object.fromEntries(
      UI_HARNESSES.map((a) => [a, mkEntry("available", "/x")]),
    ) as Record<Harness, ReturnType<typeof mkEntry>>;
    const second = { ...first, [UI_HARNESSES[0]]: mkEntry("missing") };
    let round = 0;
    const store = new HarnessAvailabilityStore({
      appendEvent,
      tickMs: 60_000,
      probe: (agent) => (round === 0 ? first[agent] : second[agent]),
    });
    store.runProbe();
    round = 1;
    store.runProbe();
    expect(appendEvent).toHaveBeenCalledTimes(2);
    const second_payload = JSON.parse(appendEvent.mock.calls[1][1] as string) as {
      availability: Record<string, { status: string }>;
    };
    expect(second_payload.availability[UI_HARNESSES[0]].status).toBe("missing");
  });

  it("snapshot() returns the current map for the fresh-Panel hydration path", () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const store = new HarnessAvailabilityStore({
      appendEvent,
      tickMs: 60_000,
      probe: () => ({ status: "available", path: "/x", version: "2.0.0" }),
    });
    // Before any probe: every agent seeded as "checking" so the Panel has a
    // stable initial render.
    for (const agent of UI_HARNESSES) {
      expect(store.snapshot()[agent]).toEqual({ status: "checking" });
    }
    store.runProbe();
    for (const agent of UI_HARNESSES) {
      expect(store.snapshot()[agent]).toEqual({
        status: "available",
        path: "/x",
        version: "2.0.0",
      });
    }
  });

  it("surfaces a probe exception as a `missing` entry without crashing the tick", () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const store = new HarnessAvailabilityStore({
      appendEvent,
      tickMs: 60_000,
      probe: (agent) => {
        if (agent === UI_HARNESSES[0]) throw new Error("boom");
        return { status: "available", path: "/x" };
      },
    });
    store.runProbe();
    expect(store.snapshot()[UI_HARNESSES[0]]).toEqual({
      status: "missing",
      reason: "boom",
    });
    expect(store.snapshot()[UI_HARNESSES[1]]?.status).toBe("available");
  });

  // Moved here from `actana-harnesses.test.ts` when the offer round became
  // `@actana/shared`'s (#288 D1): the assertion is about this store's probe
  // covering the offer set, and this is the only package that has both.
  it("probes every Harness the offer round can install", () => {
    // The offer round reads an availability map and skips anything with no
    // entry in it. If the two sets ever drift, an agent becomes silently
    // uninstallable — no offer, no message, no way to ask for it.
    const store = new HarnessAvailabilityStore({ appendEvent: () => 0 });
    store.runProbe();
    const probed = store.snapshot();
    for (const agent of offerableHarnessIds()) {
      expect(probed).toHaveProperty(agent);
    }
  });
});

function mkEntry(status: "available" | "missing", path?: string) {
  return path ? { status, path } : { status };
}

// #559: in the container the daemon cannot look into core's home, so the probe is a
// question asked of another process, and therefore asynchronous.
describe("HarnessAvailabilityStore.refresh with an asynchronous probe", () => {
  it("publishes what the asynchronous probe found, once", async () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const probe = vi.fn(() => ({ status: "missing" as const, reason: "sync-probe-used" }));
    const store = new HarnessAvailabilityStore({
      appendEvent,
      probe,
      probeAsync: async (agent) => ({ status: "available", path: `/home/core/.local/bin/${agent}` }),
    });
    await store.refresh();
    await store.refresh();
    expect(probe).not.toHaveBeenCalled();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(store.snapshot()["claude-code"]).toEqual({
      status: "available",
      path: "/home/core/.local/bin/claude-code",
    });
  });

  // The race: a round that already looked must not answer a caller who changed the
  // machine after it looked (the install service, right after the installer wrote the CLI).
  it("answers a caller who arrives mid-round from a round that starts after the call", async () => {
    let installed = false;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => (release = resolve));
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probeAsync: async (agent) => {
        // Looks first, then waits: the answer is fixed before the gate opens.
        const found = installed && agent === "claude-code";
        await gate;
        return found ? { status: "available", path: "/home/core/.local/bin/claude" } : { status: "missing", reason: "not-found" };
      },
    });
    const tick = store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    installed = true;
    const install = store.refresh();
    const secondInstall = store.refresh();
    release();
    gate = Promise.resolve();
    await Promise.all([tick, install, secondInstall]);
    expect(store.snapshot()["claude-code"]).toEqual({ status: "available", path: "/home/core/.local/bin/claude" });
  });

  it("shares one trailing round between every caller that arrives mid-round", async () => {
    let calls = 0;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => (release = resolve));
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probeAsync: async () => {
        calls += 1;
        await gate;
        return { status: "missing", reason: "not-found" };
      },
    });
    const first = store.refresh();
    const late = [store.refresh(), store.refresh(), store.refresh()];
    release();
    gate = Promise.resolve();
    await Promise.all([first, ...late]);
    // The round in flight and one more, not four.
    expect(calls).toBe(2 * UI_HARNESSES.filter((agent) => !HARNESS_REGISTRY[agent].disabled).length);
  });

  it("records a probe that throws as missing, not as a rejection", async () => {
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probeRetryDelayMs: 0,
      probeAsync: async () => {
        throw new Error("helper did not finish");
      },
    });
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.snapshot()["claude-code"]).toEqual({ status: "missing", reason: "helper did not finish" });
  });

  it("falls back to the synchronous probe when there is no asynchronous one", async () => {
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probe: () => ({ status: "available", path: "/x" }),
    });
    await store.refresh();
    expect(store.snapshot()["claude-code"]).toEqual({ status: "available", path: "/x" });
  });
});

// #685: the setup check sits in front of publishing, on every Core.
describe("HarnessAvailabilityStore afterProbe", () => {
  it("publishes the map afterProbe returns, with no probeAsync, and never the raw one", async () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const store = new HarnessAvailabilityStore({
      appendEvent,
      probe: () => ({ status: "available", path: "/bin/x" }),
      afterProbe: async (map) => ({ ...map, "claude-code": { status: "missing", reason: "needs-setup: folder-trust" } }),
    });
    await store.refresh();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(store.snapshot()["claude-code"]).toEqual({ status: "missing", reason: "needs-setup: folder-trust" });
  });

  it("publishes the probed map when afterProbe throws", async () => {
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probe: () => ({ status: "available", path: "/bin/x" }),
      afterProbe: async () => {
        throw new Error("boom");
      },
    });
    await store.refresh();
    expect(store.snapshot()["claude-code"]!.status).toBe("available");
  });
});

// #706: a `--version` that timed out at Core start is not an outdated CLI. A transient
// failure is re-probed, past the failure cache, before anything is published.
describe("HarnessAvailabilityStore probe retries", () => {
  const enabled = UI_HARNESSES.filter((agent) => !HARNESS_REGISTRY[agent].disabled);
  const slow = { status: "outdated" as const, reason: "version-check-failed" as const, path: "/bin/x" };
  const ok = { status: "available" as const, path: "/bin/x" };

  function publishedStatuses(appendEvent: ReturnType<typeof vi.fn<AppendEventFn>>): string[] {
    return appendEvent.mock.calls.map(
      ([, payload]) => (JSON.parse(payload as string) as { availability: Record<string, { status: string }> }).availability["claude-code"].status,
    );
  }

  it("retries a slow version check with fresh: true and never publishes outdated", async () => {
    const appendEvent: ReturnType<typeof vi.fn<AppendEventFn>> = vi.fn(() => 1);
    const seen: Array<{ fresh?: boolean } | undefined> = [];
    const store = new HarnessAvailabilityStore({
      appendEvent,
      probeRetryDelayMs: 0,
      probeAsync: async (agent, opts) => {
        if (agent !== "claude-code") return ok;
        seen.push(opts);
        return seen.length === 1 ? slow : ok;
      },
    });
    await store.refresh();
    expect(seen).toEqual([undefined, { fresh: true }]);
    expect(store.snapshot()["claude-code"]).toEqual(ok);
    expect(publishedStatuses(appendEvent)).toEqual(["available"]);
  });

  it("publishes outdated/version-check-failed after probeRetries + 1 probes", async () => {
    const probeAsync = vi.fn(async () => slow);
    const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync, probeRetryDelayMs: 0, probeRetries: 3 });
    await store.refresh();
    expect(probeAsync).toHaveBeenCalledTimes(enabled.length * 4);
    expect(store.snapshot()["claude-code"]).toEqual(slow);
  });

  it("retries twice by default", async () => {
    const probeAsync = vi.fn(async () => slow);
    const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync, probeRetryDelayMs: 0 });
    await store.refresh();
    expect(probeAsync).toHaveBeenCalledTimes(enabled.length * 3);
  });

  it("does not retry a real outdated or a version-unknown", async () => {
    const probeAsync = vi.fn(async (agent: Harness) =>
      agent === "claude-code"
        ? { status: "outdated" as const, reason: "outdated" as const, path: "/bin/x", version: "0.1.0" }
        : { status: "outdated" as const, reason: "version-unknown" as const, path: "/bin/x" },
    );
    const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync, probeRetryDelayMs: 0 });
    await store.refresh();
    expect(probeAsync).toHaveBeenCalledTimes(enabled.length);
    expect(store.snapshot()["claude-code"]).toMatchObject({ status: "outdated", reason: "outdated" });
  });

  it("retries only the entries that need it", async () => {
    const calls: string[] = [];
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probeRetryDelayMs: 0,
      probeAsync: async (agent) => {
        calls.push(agent);
        return agent === "claude-code" ? slow : ok;
      },
    });
    await store.refresh();
    expect(calls.filter((agent) => agent === "claude-code")).toHaveLength(3);
    expect(calls.filter((agent) => agent !== "claude-code")).toHaveLength(enabled.length - 1);
  });

  it("retries a probe that throws, and records missing if it keeps throwing", async () => {
    const probeAsync = vi.fn(async (): Promise<typeof ok> => {
      throw new Error("helper did not finish");
    });
    const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync, probeRetryDelayMs: 0 });
    await store.refresh();
    expect(probeAsync).toHaveBeenCalledTimes(enabled.length * 3);
    expect(store.snapshot()["claude-code"]).toEqual({ status: "missing", reason: "helper did not finish" });
  });

  it("takes the answer of a retry after a throw", async () => {
    let calls = 0;
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probeRetryDelayMs: 0,
      probeAsync: async (agent) => {
        if (agent !== "claude-code") return ok;
        calls += 1;
        if (calls === 1) throw new Error("helper did not finish");
        return ok;
      },
    });
    await store.refresh();
    expect(store.snapshot()["claude-code"]).toEqual(ok);
  });

  it("retries through the synchronous probe when afterProbe routes it through a round", async () => {
    const seen: Array<{ fresh?: boolean } | undefined> = [];
    const store = new HarnessAvailabilityStore({
      appendEvent: () => 1,
      probeRetryDelayMs: 0,
      probe: (agent, opts) => {
        if (agent !== "claude-code") return ok;
        seen.push(opts);
        return seen.length === 1 ? slow : ok;
      },
      afterProbe: async (map) => map,
    });
    await store.refresh();
    expect(seen).toEqual([undefined, { fresh: true }]);
    expect(store.snapshot()["claude-code"]).toEqual(ok);
  });

  it("waits probeRetryDelayMs between tries and runs afterProbe only once, on the settled map", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const afterProbe = vi.fn(async (map: Parameters<NonNullable<ConstructorParameters<typeof HarnessAvailabilityStore>[0]["afterProbe"]>>[0]) => map);
      const store = new HarnessAvailabilityStore({
        appendEvent: () => 1,
        probeRetryDelayMs: 2_000,
        afterProbe,
        probeAsync: async (agent) => {
          if (agent !== "claude-code") return ok;
          calls += 1;
          return calls === 1 ? slow : ok;
        },
      });
      const round = store.refresh();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toBe(1);
      expect(afterProbe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await round;
      expect(calls).toBe(2);
      expect(afterProbe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the retry wait at once when stopped, without waiting out a long delay", async () => {
    const probeAsync = vi.fn(async () => slow);
    const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync, probeRetryDelayMs: 60_000 });
    const round = store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = Date.now();
    store.stop();
    await round;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(probeAsync).toHaveBeenCalledTimes(enabled.length);
    expect(store.snapshot()["claude-code"]).toEqual(slow);
  });

  it("publishes what it has, without another probe, when stopped during the wait", async () => {
    vi.useFakeTimers();
    try {
      const probeAsync = vi.fn(async () => slow);
      const store = new HarnessAvailabilityStore({ appendEvent: () => 1, probeAsync, probeRetryDelayMs: 2_000 });
      const round = store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      store.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await round;
      expect(probeAsync).toHaveBeenCalledTimes(enabled.length);
      expect(store.snapshot()["claude-code"]).toEqual(slow);
    } finally {
      vi.useRealTimers();
    }
  });
});
