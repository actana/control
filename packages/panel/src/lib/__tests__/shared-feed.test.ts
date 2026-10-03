import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChange, createRefreshSchedule, createSharedFeed, EMPTY_FEED, parseSharedChanged, REFRESH_FOLLOW_UP_MS } from "../shared-feed";

const payload = (o: Record<string, unknown>) => JSON.stringify({ path: "a/b.md", size: 5, mtime: 2_000, deleted: false, ...o });

describe("a shared:changed payload", () => {
  it("is read as the Core writes it", () => {
    expect(parseSharedChanged(payload({}))).toEqual({ path: "a/b.md", size: 5, mtime: 2_000, deleted: false });
  });

  it("is refused when it is not JSON, has no path or no deleted flag, and a bad size or mtime reads as 0", () => {
    expect(parseSharedChanged("nope")).toBeNull();
    expect(parseSharedChanged("null")).toBeNull();
    expect(parseSharedChanged(payload({ path: "" }))).toBeNull();
    expect(parseSharedChanged(payload({ path: 4 }))).toBeNull();
    expect(parseSharedChanged(payload({ deleted: "no" }))).toBeNull();
    expect(parseSharedChanged(payload({ size: -1, mtime: "x" }))).toMatchObject({ size: 0, mtime: 0 });
  });
});

describe("folding events", () => {
  it("marks a file written after the last visit as new, and not one written before it", () => {
    const s1 = applyChange(EMPTY_FEED, { path: "new.md", size: 1, mtime: 5_000, deleted: false }, 4_000);
    const s2 = applyChange(s1, { path: "old.md", size: 1, mtime: 3_000, deleted: false }, 4_000);
    expect([...s2.newPaths]).toEqual(["new.md"]);
    expect(s2.changes.get("old.md")).toEqual({ size: 1, mtime: 3_000, deleted: false });
  });

  it("forgets a new file the Core deletes, and keeps what it said about the path", () => {
    const s1 = applyChange(EMPTY_FEED, { path: "x.md", size: 1, mtime: 5_000, deleted: false }, 4_000);
    const s2 = applyChange(s1, { path: "x.md", size: 0, mtime: 6_000, deleted: true }, 4_000);
    expect(s2.newPaths.size).toBe(0);
    expect(s2.changes.get("x.md")?.deleted).toBe(true);
  });

  it("does not change the state it was given", () => {
    applyChange(EMPTY_FEED, { path: "x.md", size: 1, mtime: 5_000, deleted: false }, 0);
    expect(EMPTY_FEED.changes.size).toBe(0);
    expect(EMPTY_FEED.newPaths.size).toBe(0);
  });
});

describe("the feed for one Core", () => {
  function bridge() {
    const events: Array<(m: { coreId: string; event: { kind: string; payload: string } }) => void> = [];
    const connection: Array<(connected: boolean) => void> = [];
    const released = vi.fn();
    return {
      events,
      connection,
      released,
      api: {
        watchCore: vi.fn(() => released),
        onEvent: (cb: (typeof events)[number]) => (events.push(cb), () => events.splice(events.indexOf(cb), 1)),
        onConnectionChange: (cb: (typeof connection)[number]) => (connection.push(cb), () => connection.splice(connection.indexOf(cb), 1)),
      },
    };
  }
  const event = (coreId: string, kind: string, p: string) => ({ coreId, event: { kind, payload: p } });

  it("watches the Core, folds only its shared:changed events, and asks for a refresh on each", () => {
    const b = bridge();
    const onChange = vi.fn();
    const feed = createSharedFeed("c1", 1_000, b.api as never, onChange);
    const stop = feed.connect();
    expect(b.api.watchCore).toHaveBeenCalledWith("c1");
    b.events[0]!(event("c1", "shared:changed", payload({ path: "r.md", mtime: 2_000 })));
    b.events[0]!(event("c2", "shared:changed", payload({ path: "other-core.md", mtime: 2_000 })));
    b.events[0]!(event("c1", "session:status", payload({ path: "not-a-file.md" })));
    b.events[0]!(event("c1", "shared:changed", "garbage"));
    expect([...feed.get().newPaths]).toEqual(["r.md"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(b.released).toHaveBeenCalled();
    expect(b.events).toHaveLength(0);
    expect(b.connection).toHaveLength(0);
  });

  it("tells subscribers when the state changes, and looks again when the link comes back", () => {
    const b = bridge();
    const onChange = vi.fn();
    const feed = createSharedFeed("c1", 0, b.api as never, onChange);
    const seen = vi.fn();
    feed.subscribe(seen);
    feed.connect();
    b.events[0]!(event("c1", "shared:changed", payload({})));
    expect(seen).toHaveBeenCalledTimes(1);
    b.connection[0]!(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    b.connection[0]!(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("looking at S3 again after the Core's sync pass", () => {
  afterEach(() => vi.useRealTimers());

  it("looks once after the debounce and again after one and two sync intervals, then stops", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    createRefreshSchedule(refresh).note();
    vi.advanceTimersByTime(399);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The Core uploads on its next pass, at most 15 s later: the follow-ups are just past one and two passes.
    expect(REFRESH_FOLLOW_UP_MS[0]).toBeGreaterThan(15_000);
    expect(REFRESH_FOLLOW_UP_MS[1]).toBeGreaterThan(30_000);
    vi.advanceTimersByTime(REFRESH_FOLLOW_UP_MS[0] - 400);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_FOLLOW_UP_MS[1] - REFRESH_FOLLOW_UP_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("restarts the sequence on a new event, so a long burst is looked at once it has stopped", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const schedule = createRefreshSchedule(refresh);
    schedule.note();
    vi.advanceTimersByTime(10_000);
    schedule.note();
    vi.advanceTimersByTime(10_000);
    // 20 s in: the first look (400 ms) and the second sequence's first look (10.4 s). The first sequence's 17 s follow-up
    // was cancelled by the second note, or this would be 3.
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_FOLLOW_UP_MS[1] + 1_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("cancels everything when stopped", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const schedule = createRefreshSchedule(refresh);
    schedule.note();
    schedule.stop();
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
