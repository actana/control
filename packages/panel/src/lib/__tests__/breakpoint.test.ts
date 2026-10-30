// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useBreakpoint,
  useIsCompact,
  useIsPhone,
} from "~/lib/breakpoint";

// jsdom has no matchMedia: a fake MediaQueryList that knows the window width
// and reports "(max-width: Npx)" queries, with change listeners.
function stubMatchMedia(initialWidth: number) {
  let width = initialWidth;
  const lists: { listeners: Set<() => void> }[] = [];
  const matchesFor = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return max ? width <= Number(max[1]) : false;
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    const list = { listeners: new Set<() => void>() };
    lists.push(list);
    return {
      media: query,
      get matches() {
        return matchesFor(query);
      },
      addEventListener: (_: string, fn: () => void) => list.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) =>
        list.listeners.delete(fn),
    };
  });
  return {
    setWidth(next: number) {
      width = next;
      for (const list of lists) for (const fn of [...list.listeners]) fn();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("breakpoint", () => {
  it("useBreakpoint returns desktop when matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe("desktop");
  });

  it("useBreakpoint follows a media change from desktop to phone and back", () => {
    const media = stubMatchMedia(1280);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe("desktop");
    act(() => media.setWidth(390));
    expect(result.current).toBe("phone");
    act(() => media.setWidth(800));
    expect(result.current).toBe("tablet");
    act(() => media.setWidth(1280));
    expect(result.current).toBe("desktop");
  });

  it("useIsCompact is true for phone and tablet, false for desktop", () => {
    const media = stubMatchMedia(390);
    const { result } = renderHook(() => ({
      compact: useIsCompact(),
      phone: useIsPhone(),
    }));
    expect(result.current).toEqual({ compact: true, phone: true });
    act(() => media.setWidth(800));
    expect(result.current).toEqual({ compact: true, phone: false });
    act(() => media.setWidth(1280));
    expect(result.current).toEqual({ compact: false, phone: false });
  });

  it("styles.css imports both mobile stylesheets and has no 760px rule", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../../styles.css"),
      "utf8",
    );
    expect(css).toContain('@import "./styles/mobile-shell.css";');
    expect(css).toContain('@import "./styles/mobile-sheet.css";');
    expect(css).not.toContain("760px");
    expect(css).toContain("@media (max-width: 767px)");
  });
});
