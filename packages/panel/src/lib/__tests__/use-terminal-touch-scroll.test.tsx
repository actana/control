// @vitest-environment jsdom
//
// #897: xterm 6 has no touch handling, so on a phone a swipe over the terminal
// scrolled the page. The hook turns a drag into lines: `scrollLines` on the
// normal screen, wheel bytes to the PTY on the alternate screen / with mouse
// tracking. Touch events are faked; the terminal edge is a spy target.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTerminalTouchScroll, type TouchScrollTarget } from "../use-terminal-touch-scroll";

const CELL = 20;

function makeTarget(mode: TouchScrollTarget["mode"] extends () => infer M ? M : never = "scroll") {
  const state = { mode, appCursor: false };
  const target = {
    scrollLines: vi.fn(),
    cellHeight: () => CELL,
    mode: () => state.mode,
    size: () => ({ cols: 80, rows: 24 }),
    applicationCursorKeys: () => state.appCursor,
    write: vi.fn(),
  } satisfies TouchScrollTarget;
  return { target, state };
}

function touch(el: Element, type: string, y: number, x = 40) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y, identifier: 1 };
  Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(ev, "changedTouches", { value: [point] });
  el.dispatchEvent(ev);
  return ev;
}

function setup(target: TouchScrollTarget | null, enabled = true) {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  pane.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480, x: 0, y: 0 }) as DOMRect;
  const paneRef = { current: pane };
  const hook = renderHook(
    ({ on }) => useTerminalTouchScroll(paneRef, () => target, on),
    { initialProps: { on: enabled } },
  );
  return { pane, hook };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useTerminalTouchScroll", () => {
  it("dragging the finger down scrolls back through history (negative lines)", () => {
    const { target } = makeTarget();
    const { pane } = setup(target);
    touch(pane, "touchstart", 100);
    touch(pane, "touchmove", 150); // 50px down = 2 cells + 10px remainder
    expect(target.scrollLines).toHaveBeenCalledWith(-2);
  });

  it("dragging up scrolls forward (positive lines) and keeps the sub-cell remainder", () => {
    const { target } = makeTarget();
    const { pane } = setup(target);
    touch(pane, "touchstart", 200);
    touch(pane, "touchmove", 190); // 10px: under one cell
    expect(target.scrollLines).not.toHaveBeenCalled();
    touch(pane, "touchmove", 175); // 15px more: 25px total -> 1 line
    expect(target.scrollLines).toHaveBeenCalledTimes(1);
    expect(target.scrollLines).toHaveBeenCalledWith(1);
  });

  it("calls preventDefault on touchmove so the page does not scroll", () => {
    const { target } = makeTarget();
    const { pane } = setup(target);
    touch(pane, "touchstart", 100);
    expect(touch(pane, "touchmove", 105).defaultPrevented).toBe(true);
  });

  it("on the alternate screen, writes arrow-key bytes instead of scrolling", () => {
    const { target } = makeTarget("alternate");
    const { pane } = setup(target);
    touch(pane, "touchstart", 100);
    touch(pane, "touchmove", 140); // 2 lines back = wheel up = Up arrow
    expect(target.scrollLines).not.toHaveBeenCalled();
    expect(target.write).toHaveBeenCalledWith("\x1b[A\x1b[A");
  });

  it("with mouse tracking on, writes SGR wheel reports at the touched cell", () => {
    const { target } = makeTarget("mouse");
    const { pane } = setup(target);
    touch(pane, "touchstart", 100, 400);
    touch(pane, "touchmove", 140, 400); // finger down = wheel up (64)
    expect(target.scrollLines).not.toHaveBeenCalled();
    // x 400/800*80 -> col 41; y 140/480*24 -> row 8
    expect(target.write).toHaveBeenCalledWith("\x1b[<64;41;8M\x1b[<64;41;8M");
    touch(pane, "touchmove", 100, 400); // back up 40px = wheel down (65)
    expect(target.write).toHaveBeenLastCalledWith("\x1b[<65;41;6M\x1b[<65;41;6M");
  });

  it("a tap (no movement) is left alone so the terminal still focuses", () => {
    const { target } = makeTarget();
    const { pane } = setup(target);
    expect(touch(pane, "touchstart", 100).defaultPrevented).toBe(false);
    expect(touch(pane, "touchend", 100).defaultPrevented).toBe(false);
    expect(target.scrollLines).not.toHaveBeenCalled();
    expect(target.write).not.toHaveBeenCalled();
  });

  it("keeps scrolling briefly after a fast flick (inertia), then stops", () => {
    const { target } = makeTarget();
    const { pane } = setup(target);
    touch(pane, "touchstart", 100);
    vi.advanceTimersByTime(16);
    touch(pane, "touchmove", 160);
    const during = target.scrollLines.mock.calls.length;
    touch(pane, "touchend", 160);
    vi.advanceTimersByTime(2000);
    expect(target.scrollLines.mock.calls.length).toBeGreaterThan(during);
    const settled = target.scrollLines.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(target.scrollLines.mock.calls.length).toBe(settled);
  });

  it("is a no-op when disabled (desktop): no listeners, nothing prevented", () => {
    const { target } = makeTarget();
    const { pane } = setup(target, false);
    touch(pane, "touchstart", 100);
    expect(touch(pane, "touchmove", 200).defaultPrevented).toBe(false);
    expect(target.scrollLines).not.toHaveBeenCalled();
  });

  it("detaches on unmount", () => {
    const { target } = makeTarget();
    const { pane, hook } = setup(target);
    hook.unmount();
    touch(pane, "touchstart", 100);
    expect(touch(pane, "touchmove", 200).defaultPrevented).toBe(false);
    expect(target.scrollLines).not.toHaveBeenCalled();
  });

  it("tolerates a pane with no terminal yet", () => {
    const { pane } = setup(null);
    touch(pane, "touchstart", 100);
    expect(() => touch(pane, "touchmove", 200)).not.toThrow();
  });
});
