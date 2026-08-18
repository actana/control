import { describe, expect, it, vi } from "vitest";
import { disposePty, planLaunchPortKillTargets, sanitizeInitialInput } from "../pty-manager";

describe("planLaunchPortKillTargets", () => {
  it("marks Mission Control runtime ports as protected", () => {
    expect(planLaunchPortKillTargets([5173, 3000], [5173])).toEqual([
      { port: 5173, protected: true },
      { port: 3000, protected: false },
    ]);
  });

  it("dedupes ports and ignores invalid values", () => {
    expect(planLaunchPortKillTargets([5173, 5173, 0, 70000, -1], [3000])).toEqual([
      { port: 5173, protected: false },
    ]);
  });
});

describe("disposePty", () => {
  // Regression guard for the PTY master leak: node-pty's kill() only SIGHUPs the
  // child and leaves the master /dev/ptmx fd open if the child survives the
  // signal. Teardown MUST close the master via destroy(), or a long-lived window
  // exhausts macOS's kern.tty.ptmx_max and every pty spawn on the machine fails.
  it("closes the master fd via destroy() instead of only signalling with kill()", () => {
    const destroy = vi.fn();
    const kill = vi.fn();
    disposePty({ pid: 4242, destroy, kill } as never);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to kill() only when destroy() is unavailable", () => {
    const kill = vi.fn();
    disposePty({ pid: 4242, kill } as never);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a missing proc and swallows teardown errors", () => {
    expect(() => disposePty(null)).not.toThrow();
    expect(() =>
      disposePty({
        pid: 1,
        destroy: () => {
          throw new Error("already gone");
        },
      } as never),
    ).not.toThrow();
  });
});

describe("sanitizeInitialInput", () => {
  // Issue #193: a line break is a C0 byte, so it failed the `code >= 32` test
  // and was dropped like any other control byte — and `.join("")` left nothing
  // in its place, welding the word before the break onto the word after it
  // ("the diff" + "then open" => "diffthen"). Every programmatic starting
  // prompt (Ship / Sync / Create-PR) is sanitised here, so these cases pin the
  // separator semantics rather than leaving them to the next reader.
  it("keeps a separator where a line break was", () => {
    expect(sanitizeInitialInput("review the diff\nthen open a PR")).toBe(
      "review the diff then open a PR",
    );
  });

  it("drops a leading or trailing line break without leaving stray whitespace", () => {
    expect(sanitizeInitialInput("review the diff\n")).toBe("review the diff");
    expect(sanitizeInitialInput("\nreview the diff")).toBe("review the diff");
    expect(sanitizeInitialInput("\nreview the diff\n")).toBe("review the diff");
  });

  it("collapses a run of line breaks to a single separator", () => {
    expect(sanitizeInitialInput("first paragraph\n\n\nsecond paragraph")).toBe(
      "first paragraph second paragraph",
    );
  });

  it("treats carriage returns like line feeds, CRLF included", () => {
    expect(sanitizeInitialInput("review the diff\r\nthen open a PR")).toBe(
      "review the diff then open a PR",
    );
    expect(sanitizeInitialInput("review the diff\rthen open a PR")).toBe(
      "review the diff then open a PR",
    );
    expect(sanitizeInitialInput("review the diff\n\rthen open a PR")).toBe(
      "review the diff then open a PR",
    );
  });

  it("returns undefined for a prompt that is only line breaks", () => {
    expect(sanitizeInitialInput("\n")).toBeUndefined();
    expect(sanitizeInitialInput("\n\n\n")).toBeUndefined();
    expect(sanitizeInitialInput("\r\n\r\n")).toBeUndefined();
  });

  it("returns undefined when there is nothing to send", () => {
    expect(sanitizeInitialInput(undefined)).toBeUndefined();
    expect(sanitizeInitialInput("")).toBeUndefined();
    expect(sanitizeInitialInput("   ")).toBeUndefined();
  });

  it("still refuses to pass keybinding control bytes through to the TUI", () => {
    // The filter's original purpose stands: a caller must not be able to drive
    // the harness TUI from a starting prompt. A non-whitespace C0/DEL byte was
    // never text, so it is removed with no separator in its place.
    expect(sanitizeInitialInput("esc\x1b[Ainjected")).toBe("esc[Ainjected");
    expect(sanitizeInitialInput("ctrl\x03c")).toBe("ctrlc");
    expect(sanitizeInitialInput("del\x7fbyte")).toBe("delbyte");
  });

  it("separates words joined by a tab or a form feed", () => {
    expect(sanitizeInitialInput("review the diff\tthen open a PR")).toBe(
      "review the diff then open a PR",
    );
    expect(sanitizeInitialInput("review the diff\vthen open a PR")).toBe(
      "review the diff then open a PR",
    );
    expect(sanitizeInitialInput("review the diff\fthen open a PR")).toBe(
      "review the diff then open a PR",
    );
  });

  it("leaves ordinary text, its spacing and its non-ASCII alone", () => {
    expect(sanitizeInitialInput("  ship it — please  ")).toBe("ship it — please");
    expect(sanitizeInitialInput("two  spaces stay")).toBe("two  spaces stay");
  });
});
