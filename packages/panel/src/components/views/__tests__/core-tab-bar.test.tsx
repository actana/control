// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CoreTabBar } from "../CoreTabBar";

afterEach(cleanup);

describe("CoreTabBar", () => {
  it("renders Sessions · Files · Tasks with the active one aria-current", () => {
    render(<CoreTabBar tab="files" onTab={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Core sections" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Sessions", "Files", "Tasks"]);
    expect(buttons.map((b) => b.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it('tapping Files calls onTab("files")', () => {
    const onTab = vi.fn();
    render(<CoreTabBar tab="sessions" onTab={onTab} />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onTab).toHaveBeenCalledWith("files");
  });

  it("each tab is at least 44px (style/min-height)", () => {
    render(<CoreTabBar tab="sessions" onTab={() => {}} />);
    for (const button of screen.getAllByRole("button")) {
      expect(parseInt(button.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    }
  });
});
