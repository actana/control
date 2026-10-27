// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AskUserQuestionOverlay } from "../AskUserQuestionOverlay";
import type { PendingQuestion } from "~/shared/harness-questions";

const pending: PendingQuestion = {
  id: "q1",
  sessionId: "s1",
  createdAt: 0,
  questions: [
    {
      question: "Drop the legacy sessions_v1 table after copy?",
      header: "Migration",
      multiSelect: false,
      options: [{ label: "Yes, drop it" }, { label: "No, keep it for now" }],
    },
  ],
};

function renderOverlay(sheet?: boolean) {
  const onSubmitAnswers = vi.fn(async () => true);
  render(
    <AskUserQuestionOverlay
      pending={pending}
      desynced={false}
      narrow={false}
      sheet={sheet}
      terminalOwnedFocus={() => false}
      onSubmitAnswers={onSubmitAnswers}
      onDismiss={vi.fn()}
      onFocusTerminal={vi.fn()}
      restoreTerminalFocus={vi.fn()}
    />,
  );
  return { onSubmitAnswers };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe("AskUserQuestionOverlay", () => {
  it("phone: shows the question then numbered full-width options, first highlighted", () => {
    renderOverlay(true);
    expect(screen.getByText("Drop the legacy sessions_v1 table after copy?")).toBeTruthy();
    const first = screen.getByRole("option", { name: "1. Yes, drop it" });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.className).toContain("mc-aq-sheet-option");
    expect(screen.getByRole("option", { name: "2. No, keep it for now" }).getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector("[data-question-overlay]")!.className).toContain("mc-aq-sheet");
  });

  it("phone: a tap submits that answer through the existing answer path", async () => {
    const { onSubmitAnswers } = renderOverlay(true);
    fireEvent.click(screen.getByRole("option", { name: "2. No, keep it for now" }));
    await waitFor(() =>
      expect(onSubmitAnswers).toHaveBeenCalledWith([
        { kind: "options", optionIndexes: [1], multiSelect: false },
      ]),
    );
  });

  it("desktop: the overlay is unchanged (floating panel, digit chips, key hints)", () => {
    renderOverlay();
    const panel = document.querySelector("[data-question-overlay]") as HTMLElement;
    expect(panel.className).not.toContain("mc-aq-sheet");
    expect(panel.style.left).toBe("8px");
    expect(screen.getByText("navigate")).toBeTruthy();
    expect(screen.queryByRole("option", { name: "1. Yes, drop it" })).toBeNull();
  });
});
