// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { TerminalKeyRow, useStickyCtrl } from "../TerminalKeyRow";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function Harness({
  onSend,
  onPaste = () => {},
  onPasteError,
}: {
  onSend: (d: string) => void;
  onPaste?: (t: string) => void;
  onPasteError?: (e: unknown) => void;
}) {
  const ctrl = useStickyCtrl();
  return (
    <>
      <TerminalKeyRow onSend={onSend} onPaste={onPaste} ctrl={ctrl} onPasteError={onPasteError} />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("TerminalKeyRow", () => {
  it("key row sends Esc/Tab/arrow sequences", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    for (const n of ["Esc", "Tab", "Up", "Down", "Right", "Left"]) press(n);
    expect(onSend.mock.calls.map((c) => c[0])).toEqual([
      "\x1b", "\t", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D",
    ]);
  });

  it("Ctrl is sticky for one key then releases", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    press("Ctrl");
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    press("Tab");
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    expect(onSend).toHaveBeenLastCalledWith("\t");
  });

  it("Ctrl applies to the next key typed on the keyboard via consume()", () => {
    const { result } = renderHook(() => useStickyCtrl());
    expect(result.current.consume("c")).toBe("c");
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    let out = "";
    act(() => {
      out = result.current.consume("c");
    });
    expect(out).toBe("\x03");
    expect(result.current.armed).toBe(false);
    expect(result.current.consume("c")).toBe("c");
  });

  it("Paste hands the clipboard text to onPaste, not onSend (bracketed paste)", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockResolvedValue("hello") } });
    const onSend = vi.fn();
    const onPaste = vi.fn();
    render(<Harness onSend={onSend} onPaste={onPaste} />);
    await act(async () => press("Paste"));
    expect(onPaste).toHaveBeenCalledWith("hello");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Paste with no clipboard access does not throw", async () => {
    vi.stubGlobal("navigator", {});
    const onSend = vi.fn();
    const onPasteError = vi.fn();
    render(<Harness onSend={onSend} onPasteError={onPasteError} />);
    await act(async () => press("Paste"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onPasteError).toHaveBeenCalledTimes(1);
  });

  it("Paste rejected by the browser does not throw", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const onPasteError = vi.fn();
    render(<Harness onSend={vi.fn()} onPasteError={onPasteError} />);
    await act(async () => press("Paste"));
    expect(onPasteError).toHaveBeenCalledTimes(1);
  });

  it("pressing a key does not move focus (mousedown default prevented)", () => {
    render(<Harness onSend={vi.fn()} />);
    for (const n of ["Esc", "Ctrl", "Paste"]) {
      const btn = screen.getByRole("button", { name: n });
      expect(fireEvent.mouseDown(btn)).toBe(false);
      expect(fireEvent.pointerDown(btn)).toBe(false);
    }
  });

  it("every key is a button at least 44 px tall", () => {
    render(<Harness onSend={vi.fn()} />);
    const names = ["Esc", "Tab", "Ctrl", "Up", "Down", "Left", "Right", "Paste"];
    for (const n of names) {
      const btn = screen.getByRole("button", { name: n });
      expect(btn.getAttribute("type")).toBe("button");
      expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    }
  });
});
