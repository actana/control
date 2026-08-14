// @vitest-environment jsdom
//
// Hold-to-open, and the two ways it is usually got wrong (#228).
//
// The first is the timer restarted on every `dragover`: correct-looking code
// that never opens anything, because the event fires again long before a second
// is up. The second is the cancel that fires on the *wrong* row — moving from
// one folder to the next delivers the new row's enter before the old row's
// leave, so a `leave` that cancels unconditionally cancels the timer that was
// just armed. Both are asserted below, because neither is visible in a
// screenshot and both make the feature simply not happen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SPRING_LOADED_MS, useSpringLoad } from "~/lib/spring-loaded";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a drag held over a folder", () => {
  it("opens it after about a second, once", () => {
    const opened: string[] = [];
    const { result } = renderHook(() => useSpringLoad((path) => opened.push(path)));

    act(() => result.current.hover("incoming"));
    act(() => void vi.advanceTimersByTime(SPRING_LOADED_MS - 1));
    expect(opened).toEqual([]);

    act(() => void vi.advanceTimersByTime(1));
    expect(opened).toEqual(["incoming"]);

    // The clock does not re-arm itself: one hold, one open.
    act(() => void vi.advanceTimersByTime(SPRING_LOADED_MS * 3));
    expect(opened).toEqual(["incoming"]);
  });

  it("keeps counting while `dragover` keeps firing", () => {
    // The whole point. A drag resting on a row fires this handler tens of times
    // a second; an implementation that restarted the timer would never open.
    const opened: string[] = [];
    const { result } = renderHook(() => useSpringLoad((path) => opened.push(path)));

    for (let elapsed = 0; elapsed < SPRING_LOADED_MS; elapsed += 50) {
      act(() => result.current.hover("incoming"));
      act(() => void vi.advanceTimersByTime(50));
    }

    expect(opened).toEqual(["incoming"]);
  });

  it("opens nothing when the drag moves on before the second is up", () => {
    const opened: string[] = [];
    const { result } = renderHook(() => useSpringLoad((path) => opened.push(path)));

    act(() => result.current.hover("incoming"));
    act(() => void vi.advanceTimersByTime(400));
    act(() => result.current.leave("incoming"));
    act(() => void vi.advanceTimersByTime(SPRING_LOADED_MS));

    expect(opened).toEqual([]);
  });

  it("times the row the drag is on now, not the one it came from", () => {
    const opened: string[] = [];
    const { result } = renderHook(() => useSpringLoad((path) => opened.push(path)));

    act(() => result.current.hover("incoming"));
    act(() => void vi.advanceTimersByTime(400));
    // The order a browser delivers: the new row's hover, then the old row's
    // leave. A `leave` that did not check the path would cancel `src` here.
    act(() => result.current.hover("src"));
    act(() => result.current.leave("incoming"));
    act(() => void vi.advanceTimersByTime(SPRING_LOADED_MS));

    // Only the row it rested on — not a trail of folders sprung open behind a
    // pointer that was merely crossing the list.
    expect(opened).toEqual(["src"]);
  });

  it("stops on a drop, and on an unmount", () => {
    const opened: string[] = [];
    const { result, unmount } = renderHook(() => useSpringLoad((path) => opened.push(path)));

    act(() => result.current.hover("incoming"));
    act(() => result.current.cancel());
    act(() => void vi.advanceTimersByTime(SPRING_LOADED_MS));
    expect(opened).toEqual([]);

    act(() => result.current.hover("incoming"));
    unmount();
    act(() => void vi.advanceTimersByTime(SPRING_LOADED_MS));
    expect(opened).toEqual([]);
  });
});
