// #897: a refit that computes the same cols x rows must change nothing — no
// repaint, no viewport snap — so the phone's visualViewport churn (address bar,
// page scroll) cannot yank a scrolled-up terminal back to the bottom. A refit
// that does resize keeps the user where they were.
import { describe, expect, it, vi } from "vitest";
import { fitTerminalSurface } from "../terminal-options";

function makeTerm(opts: { viewportY: number; baseY: number; cols?: number; rows?: number }) {
  return {
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    refresh: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    buffer: { active: { viewportY: opts.viewportY, baseY: opts.baseY } },
  };
}

describe("fitTerminalSurface", () => {
  it("does nothing visible when the fitted size is unchanged", () => {
    const term = makeTerm({ viewportY: 100, baseY: 100 });
    const fit = { fit: vi.fn() };
    fitTerminalSurface(term, fit);
    expect(fit.fit).toHaveBeenCalled();
    expect(term.refresh).not.toHaveBeenCalled();
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  it("leaves a scrolled-up viewport alone on an unchanged refit", () => {
    const term = makeTerm({ viewportY: 40, baseY: 100 });
    fitTerminalSurface(term, { fit: vi.fn() });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  it("keeps a scrolled-up user in place when the size does change", () => {
    const term = makeTerm({ viewportY: 40, baseY: 100 });
    fitTerminalSurface(term, {
      fit: () => {
        term.rows = 20;
      },
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.scrollToLine).toHaveBeenCalledWith(40);
    expect(term.refresh).toHaveBeenCalledWith(0, 19);
  });

  it("follows the bottom when the user was at the bottom and the size changes", () => {
    const term = makeTerm({ viewportY: 100, baseY: 100 });
    fitTerminalSurface(term, {
      fit: () => {
        term.cols = 60;
      },
    });
    expect(term.scrollToBottom).toHaveBeenCalled();
  });
});
