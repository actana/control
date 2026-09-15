// @vitest-environment jsdom
//
// The SSE channel after a gap (issue 484, symptom W2 — suspect 2).
//
// `/api/events` is fire-and-forget: the server keeps no event log, sends no
// `id:` lines, and the client sends no `Last-Event-ID`. So a `task:updated`
// emitted while the socket is down is not delayed, it is gone — a backgrounded
// tab whose connection a browser or proxy reaped comes back believing whatever
// it last heard, which for a Session that finished in the gap is `running`.
//
// The channel cannot replay. What it can do is say that a gap happened, so the
// queries it feeds are re-read instead of trusted — the same bargain
// `useCoreLiveQueries` already makes for a dropped core-link. That is what
// these tests pin: the announcement, its once-per-gap shape, and the
// invalidation it drives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const SSE_RECONNECT_DELAY_MS = 1500;

/** Every EventSource the module has opened, oldest first. */
const opened: FakeEventSource[] = [];

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** The stream drops, the way a reaped connection does. */
  drop(): void {
    this.onerror?.();
  }
}

const {
  __resetServerEventsForTests,
  useServerEvents,
  useServerEventsReconnect,
} = await import("~/lib/use-events");
const { useEventStreamReconcile } = await import("~/lib/use-event-stream-reconcile");

/** Stable identities: `useServerEvents` re-subscribes when its handler changes,
 *  and a fresh closure per render would tear the shared socket down and back up
 *  between renders, which is not the thing under test. */
function noop(): void {}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** Drive the module's own backoff to the next connection attempt. */
async function waitOutBackoff(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SSE_RECONNECT_DELAY_MS);
    await Promise.resolve();
  });
}

describe("a reconnected SSE stream reconciles the gap it left (issue 484)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    opened.length = 0;
    __resetServerEventsForTests();
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    __resetServerEventsForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("says nothing on the first connection — that is not a gap", async () => {
    const reconnected = vi.fn();
    renderHook(() => {
      useServerEvents(noop);
      useServerEventsReconnect(reconnected);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(opened).toHaveLength(1);
    opened[0]!.onopen?.();
    expect(reconnected).not.toHaveBeenCalled();
  });

  it("announces the reconnection that follows a drop, once", async () => {
    const reconnected = vi.fn();
    renderHook(() => {
      useServerEvents(noop);
      useServerEventsReconnect(reconnected);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const first = opened[0]!;
    first.onopen?.();

    first.drop();
    expect(first.closed).toBe(true);
    await waitOutBackoff();

    expect(opened).toHaveLength(2);
    const second = opened[1]!;
    act(() => second.onopen?.());
    expect(reconnected).toHaveBeenCalledTimes(1);

    // The events that follow are ordinary traffic, not further gaps.
    act(() => second.onmessage?.({ data: JSON.stringify({ type: "task:updated" }) }));
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it("announces on the first frame when the implementation fires no onopen", async () => {
    const reconnected = vi.fn();
    renderHook(() => {
      useServerEvents(noop);
      useServerEventsReconnect(reconnected);
    });
    await act(async () => {
      await Promise.resolve();
    });
    opened[0]!.onmessage?.({ data: JSON.stringify({ type: "hello", at: 1 }) });
    opened[0]!.drop();
    await waitOutBackoff();

    act(() => opened[1]!.onmessage?.({ data: JSON.stringify({ type: "hello", at: 2 }) }));
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it("re-reads the projects, groups and archived buckets on the way back", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    renderHook(
      () => {
        useServerEvents(noop);
        useEventStreamReconcile();
      },
      { wrapper: wrapperFor(client) },
    );
    await act(async () => {
      await Promise.resolve();
    });
    opened[0]!.onopen?.();
    expect(invalidate).not.toHaveBeenCalled();

    opened[0]!.drop();
    await waitOutBackoff();
    act(() => opened[1]!.onopen?.());

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    // `["projects"]` is a prefix: it reaches the list, every project row and
    // every task bucket beneath them. The archived buckets sit outside that
    // tree by design (ADR 0019), so they are named separately.
    expect(keys).toContainEqual(["projects"]);
    expect(keys).toContainEqual(["groups"]);
    expect(keys).toContainEqual(["core-archived-tasks"]);
  });

  it("tells a subscriber nothing once it has unsubscribed", async () => {
    const reconnected = vi.fn();
    const view = renderHook(
      ({ subscribed }: { subscribed: boolean }) => {
        useServerEvents(noop);
        useServerEventsReconnect(subscribed ? reconnected : noop);
      },
      { initialProps: { subscribed: true } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    opened[0]!.onopen?.();
    view.rerender({ subscribed: false });

    opened[0]!.drop();
    await waitOutBackoff();
    act(() => opened[1]!.onopen?.());
    expect(reconnected).not.toHaveBeenCalled();
  });
});
