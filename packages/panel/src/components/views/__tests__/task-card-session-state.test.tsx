// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TaskCard } from "../TaskCard";
import type { TaskListDto } from "~/shared/task-wire";

// #954: the Session state badge on a Task card. Pure render, no edges to mock.
const task = (over: Partial<TaskListDto> = {}): TaskListDto => ({
  id: "t1", title: "Rotate keys", status: "in_progress", coreId: "c1", agent: "a1", attemptCount: 2, dispatchedAt: 1, lastError: null,
  timeoutMinutes: 60, sessionState: null, sessionStateAt: null, createdAt: 1, updatedAt: 1, ...over,
});
const mount = (t: TaskListDto, compact = false) =>
  render(<TaskCard task={t} coreLabel="berlin" agentLabel="claude-code" onOpen={() => {}} compact={compact} />);
const badge = () => document.querySelector("[data-session-state]");

afterEach(cleanup);

describe("TaskCard Session state badge (#954)", () => {
  it.each([
    ["needs-input", "Needs input"],
    ["interrupted", "Interrupted"],
    ["idle-no-result", "Idle without result"],
  ] as const)("shows %s as %s next to the attempt", (sessionState, label) => {
    mount(task({ sessionState, sessionStateAt: 5 }));
    expect(badge()?.textContent).toBe(label);
    expect(badge()?.getAttribute("data-session-state")).toBe(sessionState);
  });

  it.each(["working", "exited", null] as const)("shows nothing for %s", (sessionState) => {
    mount(task({ sessionState }));
    expect(badge()).toBeNull();
  });

  it("keeps the attempt text in the detail line", () => {
    mount(task({ sessionState: "needs-input" }));
    expect(document.body.textContent).toContain("attempt 2");
  });

  it.each([false, true])("changes the layout only by the badge (compact=%s)", (compact) => {
    const plain = mount(task(), compact);
    const before = plain.container.innerHTML;
    cleanup();
    const flagged = mount(task({ sessionState: "needs-input" }), compact);
    flagged.container.querySelector("[data-session-state]")!.remove();
    expect(flagged.container.innerHTML).toBe(before);
  });
});
