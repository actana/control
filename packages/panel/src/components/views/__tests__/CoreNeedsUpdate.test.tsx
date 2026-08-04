// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoreNeedsUpdateNotice } from "../CoreNeedsUpdate";
import { CORE_UPDATE_COMMAND, type CoreDialStatus } from "~/shared/cores";

// What the operator is owed when a Core drifts: the fact, the two versions, and
// the one command that fixes it — copyable, because it is going to be pasted
// into a terminal on another machine.

function needsUpdate(overrides: Partial<CoreDialStatus> = {}): CoreDialStatus {
  return {
    coreId: "core_a",
    state: "needs-update",
    lastSeenAt: 1,
    coreVersion: "0.1.0",
    panelVersion: "0.8.0",
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => cleanup());

describe("CoreNeedsUpdateNotice", () => {
  it("names the state and both protocol versions", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(screen.getByText(/needs update/i)).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("0.1.0");
    expect(text).toContain("0.8.0");
  });

  it("shows the update command verbatim", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(screen.getByText(CORE_UPDATE_COMMAND)).toBeTruthy();
  });

  it("copies the command to the clipboard", async () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CORE_UPDATE_COMMAND);
  });

  it("names the Panel as the stale side when the Core is ahead, with no Core command", () => {
    render(
      <CoreNeedsUpdateNotice dial={needsUpdate({ coreVersion: "0.9.0", panelVersion: "0.8.0" })} />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/ahead of this Panel/i);
    expect(screen.queryByText(CORE_UPDATE_COMMAND)).toBeNull();
  });

  it("stays useful when the Core advertised no version at all", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate({ coreVersion: null })} />);
    expect(screen.getByText(CORE_UPDATE_COMMAND)).toBeTruthy();
    expect(document.body.textContent).toContain("unknown");
  });
});
