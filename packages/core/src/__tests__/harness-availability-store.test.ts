import { describe, expect, it, vi } from "vitest";
import { HarnessAvailabilityStore } from "../harness-availability-store";
import { HARNESSES_AVAILABILITY_EVENT_KIND } from "@actana/shared/core-link-frames";
import { UI_HARNESSES } from "@actana/shared/harnesses";
import type { Harness } from "@actana/shared/domain";

type AppendEventFn = (
  kind: string,
  payload: string,
  opts?: { ptyId?: string | null; taskId?: string | null },
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
    expect(opts).toEqual({ ptyId: null, taskId: null });
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
});

function mkEntry(status: "available" | "missing", path?: string) {
  return path ? { status, path } : { status };
}
