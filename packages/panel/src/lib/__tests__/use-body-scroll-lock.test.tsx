// @vitest-environment jsdom
//
// #897: while a phone terminal screen is mounted the page behind it must not
// scroll. Several screens can be mounted at once (Session + user terminal), so
// the lock is counted and the original value comes back only after the last one.
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBodyScrollLock } from "../use-body-scroll-lock";

afterEach(() => {
  document.body.style.overflow = "";
});

describe("useBodyScrollLock", () => {
  it("hides body overflow while mounted and restores the previous value", () => {
    document.body.style.overflow = "auto";
    const a = renderHook(() => useBodyScrollLock());
    expect(document.body.style.overflow).toBe("hidden");
    a.unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("nested locks release only when the last one unmounts, in any order", () => {
    document.body.style.overflow = "scroll";
    const a = renderHook(() => useBodyScrollLock());
    const b = renderHook(() => useBodyScrollLock());
    a.unmount();
    expect(document.body.style.overflow).toBe("hidden");
    b.unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("does nothing when disabled", () => {
    renderHook(() => useBodyScrollLock(false));
    expect(document.body.style.overflow).toBe("");
  });
});
