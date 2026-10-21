// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import { DROP_REASONS } from "~/lib/task-board-drop";
import type { CoreWithDial } from "~/shared/cores";
import type { AgentDto, TaskDto } from "~/shared/task-wire";

// Moving a Task by dragging it to another column of the Tasks board (#827):
// by mouse, by a long press on touch and from the keyboard. What is asserted
// is the one call the move makes (the same `setTaskStatus` the Assign and
// Back to draft buttons make), what a refused drop says, and that the card
// shows where it is going before the server answers and goes back if it says no.

function core(id: string, label: string): CoreWithDial {
  return { id, endpoint: "wss://x", label, lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: id, state: "connected", lastSeenAt: 1 } };
}
const cores = [core("c1", "workstation-berlin"), core("c2", "build-box-01")];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const task = (id: string, title: string, status: TaskDto["status"], coreId: string | null, extra: Partial<TaskDto> = {}): TaskDto => ({
  id, title, description: "", status, coreId, agent: coreId ? `ag-${coreId}` : null, attemptCount: 0, dispatchedAt: null, lastError: null, timeoutMinutes: 60, createdAt: 1, updatedAt: 1, ...extra,
});
const agentsByCore: Record<string, AgentDto[]> = {
  c1: [{ id: "ag-c1", coreId: "c1", name: "claude-code", harness: "claude-code", model: null, isDefault: true }],
  c2: [{ id: "ag-c2", coreId: "c2", name: "opencode", harness: "opencode", model: null, isDefault: true }],
};

let tasks: TaskDto[] = [];
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasks: vi.fn(async () => ({ tasks })),
  getTask: vi.fn(async (id: string) => ({ task: tasks.find((t) => t.id === id)!, comments: [] })),
  listCoreAgents: vi.fn(async (coreId: string) => ({ agents: agentsByCore[coreId] ?? [] })),
  createTask: vi.fn(async () => ({})),
  commentOnTask: vi.fn(async () => ({})),
  // The server moves it; the refetch after the move then lists it where it went.
  setTaskStatus: vi.fn(async (id: string, status: TaskDto["status"]) => {
    tasks = tasks.map((t) => (t.id === id ? { ...t, status } : t));
    return {};
  }),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TasksBoard } = await import("../TasksBoard");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TasksBoard />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

type Col = "draft" | "assigned" | "in_progress" | "finished";
const ORDER: Col[] = ["draft", "assigned", "in_progress", "finished"];
// jsdom lays nothing out, so each column owns a 100 px band of x and anything
// past them is outside the board.
const X: Record<Col | "outside", number> = { draft: 50, assigned: 150, in_progress: 250, finished: 350, outside: 900 };
const column = (id: Col) => document.querySelector(`[data-board-column="${id}"]`) as HTMLElement;
const card = (id: string) => document.querySelector(`[data-task-card="${id}"]`) as HTMLElement;
const columnOfCard = (id: string) => card(id)?.closest("[data-board-column]")?.getAttribute("data-board-column");
const detailOpen = () => screen.queryByRole("dialog", { name: "Task detail" }) !== null;
const dropStates = () => [...document.querySelectorAll("[data-drop-state]")].map((el) => el.getAttribute("data-drop-state"));

const elementFromPoint = (x: number) => (x < 400 ? column(ORDER[Math.floor(x / 100)]!) : document.body);

function pointerDown(el: HTMLElement, at: Col, pointerType = "mouse") {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, pointerType, isPrimary: true, clientX: X[at], clientY: 20 });
}
const pointerMove = (to: Col | "outside", dy = 0) => fireEvent.pointerMove(window, { pointerId: 1, clientX: X[to], clientY: 20 + dy });
const pointerUp = (to: Col | "outside") => fireEvent.pointerUp(window, { pointerId: 1, clientX: X[to], clientY: 20 });

/** A mouse drag from the card's column to `to` (down a little, so past the threshold even in its own column), ending in the click a browser sends after it. */
function drag(id: string, to: Col | "outside") {
  const from = columnOfCard(id) as Col;
  const el = card(id);
  pointerDown(el, from);
  pointerMove(to, 30);
  pointerUp(to);
  fireEvent.click(el);
}

const liveRegion = () => screen.getByRole("status");

beforeEach(() => {
  tasks = [
    task("t1", "Rotate keys", "draft", "c1"),
    task("t2", "Bump SeaweedFS", "assigned", "c2"),
    task("t3", "Remove sudo", "in_progress", "c1", { attemptCount: 2 }),
    task("t4", "Review PR", "failed", "c2", { attemptCount: 1 }),
    task("t5", "Loose draft", "draft", null),
    task("t6", "No agent draft", "draft", "c1", { agent: null }),
  ];
  for (const fn of Object.values(api)) fn.mockClear();
  toast.error.mockClear();
  document.elementFromPoint = ((x: number) => elementFromPoint(x)) as typeof document.elementFromPoint;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function board() {
  const view = mount();
  await screen.findByText("Rotate keys");
  return view;
}

describe("dragging a card to a column it may go to", () => {
  it("assigns a draft, showing it in Assigned before the server answers", async () => {
    await board();
    let answer!: () => void;
    api.setTaskStatus.mockImplementationOnce(
      (id: string, status: TaskDto["status"]) =>
        new Promise((resolve) => {
          answer = () => {
            tasks = tasks.map((t) => (t.id === id ? { ...t, status } : t));
            resolve({});
          };
        }),
    );
    drag("t1", "assigned");
    await waitFor(() => expect(columnOfCard("t1")).toBe("assigned"));
    expect(api.setTaskStatus).toHaveBeenCalledTimes(1);
    expect(api.setTaskStatus).toHaveBeenCalledWith("t1", "assigned");
    answer();
    await waitFor(() => expect(api.listTasks.mock.calls.length).toBeGreaterThan(1));
    expect(columnOfCard("t1")).toBe("assigned");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("sends an assigned Task back to draft", async () => {
    await board();
    drag("t2", "draft");
    await waitFor(() => expect(columnOfCard("t2")).toBe("draft"));
    expect(api.setTaskStatus).toHaveBeenCalledWith("t2", "draft");
  });

  it("re-assigns a finished Task with the status call, not a comment", async () => {
    await board();
    drag("t4", "assigned");
    await waitFor(() => expect(columnOfCard("t4")).toBe("assigned"));
    expect(api.setTaskStatus).toHaveBeenCalledWith("t4", "assigned");
    expect(api.commentOnTask).not.toHaveBeenCalled();
  });

  it("does not also open the Task it dragged", async () => {
    await board();
    drag("t1", "assigned");
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalled());
    expect(detailOpen()).toBe(false);
  });

  it("swallows the click a drag ends with even if it comes late, and the next press clicks again", async () => {
    await board();
    const el = card("t1");
    pointerDown(el, "draft");
    pointerMove("draft", 30);
    pointerUp("draft");
    // The click after the drag, a task later than the pointerup.
    await new Promise((r) => setTimeout(r, 10));
    fireEvent.click(el);
    expect(detailOpen()).toBe(false);
    // A plain press and click afterwards opens the Task.
    pointerDown(el, "draft");
    pointerUp("draft");
    fireEvent.click(el);
    expect(detailOpen()).toBe(true);
  });

  it("puts the card back and shows the server's message when the move is refused there", async () => {
    await board();
    api.setTaskStatus.mockRejectedValueOnce(new Error("a Task cannot move from draft to assigned"));
    drag("t1", "assigned");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("a Task cannot move from draft to assigned"));
    await waitFor(() => expect(columnOfCard("t1")).toBe("draft"));
  });
});

describe("dropping a card where it may not go", () => {
  const refused = async (id: string, to: Col, reason: string) => {
    drag(id, to);
    expect(toast.error).toHaveBeenLastCalledWith(reason);
  };

  it("will not assign a draft without both a Core and an Agent", async () => {
    await board();
    await refused("t5", "assigned", DROP_REASONS.needsCoreAndAgent);
    await refused("t6", "assigned", DROP_REASONS.needsCoreAndAgent);
    expect(columnOfCard("t5")).toBe("draft");
    expect(columnOfCard("t6")).toBe("draft");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });

  it("will not put anything in In progress: only the Panel starts a Task", async () => {
    await board();
    await refused("t1", "in_progress", DROP_REASONS.onlyPanelStarts);
    await refused("t2", "in_progress", DROP_REASONS.onlyPanelStarts);
    await refused("t4", "in_progress", DROP_REASONS.onlyPanelStarts);
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });

  it("will not finish a running Task: its result files decide", async () => {
    await board();
    await refused("t3", "finished", DROP_REASONS.resultFilesDecide);
    expect(columnOfCard("t3")).toBe("in_progress");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });

  it("will not send a finished Task to draft, nor finish a draft", async () => {
    await board();
    await refused("t4", "draft", DROP_REASONS.finishedNotDraft);
    await refused("t1", "finished", DROP_REASONS.draftNotRun);
    expect(columnOfCard("t4")).toBe("finished");
    expect(columnOfCard("t1")).toBe("draft");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
    expect(detailOpen()).toBe(false);
  });

  it("does nothing, and says nothing, when dropped on its own column or outside the board", async () => {
    await board();
    drag("t1", "draft");
    drag("t1", "outside");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(columnOfCard("t1")).toBe("draft");
    expect(detailOpen()).toBe(false);
  });

  it("snaps back silently on pointercancel and on Escape", async () => {
    await board();
    pointerDown(card("t1"), "draft");
    pointerMove("assigned");
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(dropStates()).toEqual([]);
    pointerUp("assigned");

    pointerDown(card("t1"), "draft");
    pointerMove("assigned");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dropStates()).toEqual([]);
    pointerUp("assigned");

    expect(api.setTaskStatus).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(columnOfCard("t1")).toBe("draft");
  });
});

describe("while a card is dragged", () => {
  it("marks its own column, the columns that take it and the ones that do not, and clears them after", async () => {
    await board();
    expect(dropStates()).toEqual([]);
    pointerDown(card("t1"), "draft");
    pointerMove("assigned");
    expect(column("draft").getAttribute("data-drop-state")).toBe("origin");
    expect(column("assigned").getAttribute("data-drop-state")).toBe("allowed");
    expect(column("in_progress").getAttribute("data-drop-state")).toBe("refused");
    expect(column("finished").getAttribute("data-drop-state")).toBe("refused");
    expect(column("assigned").getAttribute("data-drop-over")).toBe("true");
    expect(column("draft").hasAttribute("data-drop-over")).toBe(false);
    expect(within(column("in_progress")).getByText("Not allowed")).toBeTruthy();
    expect(within(column("assigned")).queryByText("Not allowed")).toBeNull();
    // The refused column under the pointer says why.
    expect(within(column("in_progress")).queryByText(DROP_REASONS.onlyPanelStarts)).toBeNull();
    pointerMove("in_progress");
    expect(column("in_progress").getAttribute("data-drop-over")).toBe("true");
    expect(within(column("in_progress")).getByText(DROP_REASONS.onlyPanelStarts)).toBeTruthy();
    pointerMove("outside");
    pointerUp("outside");
    expect(dropStates()).toEqual([]);
    expect(document.querySelectorAll("[data-drop-over]").length).toBe(0);
    expect(screen.queryByText("Not allowed")).toBeNull();
  });

  it("does not start from the Reply button", async () => {
    await board();
    const reply = screen.getByRole("button", { name: "Reply to Review PR" });
    pointerDown(reply, "finished");
    pointerMove("assigned");
    expect(dropStates()).toEqual([]);
    pointerUp("assigned");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });
});

describe("moving a card from the keyboard", () => {
  it("Space picks it up, arrows choose the column, Enter drops it there and focus stays on the card", async () => {
    await board();
    const el = card("t1");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    expect(liveRegion().textContent).toContain("Picked up Rotate keys");
    expect(detailOpen()).toBe(false);
    expect(column("draft").getAttribute("data-drop-state")).toBe("origin");
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(liveRegion().textContent).toBe("Assigned: allowed.");
    expect(column("assigned").getAttribute("data-drop-over")).toBe("true");
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t1", "assigned"));
    expect(detailOpen()).toBe(false);
    await waitFor(() => expect(columnOfCard("t1")).toBe("assigned"));
    expect(liveRegion().textContent).toBe("Moved to Assigned.");
    await waitFor(() => expect(document.activeElement).toBe(card("t1")));
    expect(dropStates()).toEqual([]);
  });

  it("says why a column is refused, stops at the ends, and Escape or leaving the card cancels", async () => {
    await board();
    const el = card("t1");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(liveRegion().textContent).toBe(`In progress: not allowed. ${DROP_REASONS.onlyPanelStarts}`);
    fireEvent.keyDown(el, { key: "ArrowRight" });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(column("finished").getAttribute("data-drop-over")).toBe("true");
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    fireEvent.keyDown(el, { key: "ArrowUp" });
    fireEvent.keyDown(el, { key: "ArrowUp" });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(column("draft").getAttribute("data-drop-over")).toBe("true");
    fireEvent.keyDown(el, { key: "Escape" });
    expect(liveRegion().textContent).toBe("Cancelled.");
    expect(dropStates()).toEqual([]);

    // A refused drop is a toast and the card stays.
    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    fireEvent.keyDown(el, { key: " " });
    expect(toast.error).toHaveBeenCalledWith(DROP_REASONS.onlyPanelStarts);
    expect(dropStates()).toEqual([]);

    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    fireEvent.blur(el);
    expect(liveRegion().textContent).toBe("Cancelled.");
    expect(dropStates()).toEqual([]);
    expect(api.setTaskStatus).not.toHaveBeenCalled();
    expect(columnOfCard("t1")).toBe("draft");
  });

  it("puts focus back on the card and says so when the server refuses the move", async () => {
    await board();
    // Refused only once the card shows in Assigned (and focus has followed it there).
    let refuse!: () => void;
    api.setTaskStatus.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new Error("nope"));
        }),
    );
    const el = card("t1");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(columnOfCard("t1")).toBe("assigned"));
    await waitFor(() => expect(document.activeElement).toBe(card("t1")));
    refuse();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    await waitFor(() => expect(columnOfCard("t1")).toBe("draft"));
    await waitFor(() => expect(document.activeElement).toBe(card("t1")));
    expect(liveRegion().textContent).toBe("Not moved. nope");
  });

  it("sends an assigned Task back to draft", async () => {
    await board();
    const el = card("t2");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t2", "draft"));
    await waitFor(() => expect(columnOfCard("t2")).toBe("draft"));
  });

  it("re-assigns a finished Task with the status call, not a comment", async () => {
    await board();
    const el = card("t4");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(column("assigned").getAttribute("data-drop-over")).toBe("true");
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t4", "assigned"));
    await waitFor(() => expect(columnOfCard("t4")).toBe("assigned"));
    expect(api.commentOnTask).not.toHaveBeenCalled();
  });

  it("cancels the pick-up when the server moves the carried card meanwhile", async () => {
    const { client } = await board();
    const el = card("t2");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    expect(dropStates()).not.toEqual([]);
    tasks = tasks.map((t) => (t.id === "t2" ? { ...t, status: "in_progress" } : t));
    await act(() => client.invalidateQueries({ queryKey: ["tasks"] }));
    await waitFor(() => expect(columnOfCard("t2")).toBe("in_progress"));
    expect(dropStates()).toEqual([]);
    expect(liveRegion().textContent).toMatch(/^Cancelled/);
    await waitFor(() => expect(document.activeElement).toBe(card("t2")));
    expect(columnOfCard("t2")).toBe("in_progress");
    const moved = card("t2");
    fireEvent.keyDown(moved, { key: " " });
    fireEvent.keyDown(moved, { key: "Enter" });
    expect(api.setTaskStatus).not.toHaveBeenCalledWith("t2", "draft");
  });

  it("does not later steal focus for a moved card that never showed (filtered out by a chip)", async () => {
    const { client } = await board();
    fireEvent.click(screen.getByRole("button", { name: /^build-box-01/ }));
    const el = card("t2");
    el.focus();
    fireEvent.keyDown(el, { key: " " });
    // The poll moves it to In progress on another Core: it leaves the filtered board.
    tasks = tasks.map((t) => (t.id === "t2" ? { ...t, status: "in_progress", coreId: "c1" } : t));
    await act(() => client.invalidateQueries({ queryKey: ["tasks"] }));
    await waitFor(() => expect(card("t2")).toBeNull());
    expect(liveRegion().textContent).toMatch(/^Cancelled/);
    (document.activeElement as HTMLElement | null)?.blur();
    // Back on All Cores it shows again, long after the move: focus is not pulled to it.
    fireEvent.click(screen.getByRole("button", { name: /^All Cores/ }));
    await waitFor(() => expect(columnOfCard("t2")).toBe("in_progress"));
    // and the next poll brings something new.
    tasks = tasks.map((t) => (t.id === "t2" ? { ...t, updatedAt: 2 } : t));
    await act(() => client.invalidateQueries({ queryKey: ["tasks"] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).not.toBe(card("t2"));
  });

  it("Enter on a card still opens it", async () => {
    await board();
    const el = card("t1");
    el.focus();
    fireEvent.keyDown(el, { key: "Enter" });
    expect(detailOpen()).toBe(true);
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });

  it("describes how to move it to screen readers", async () => {
    await board();
    const el = card("t1");
    expect(el.getAttribute("aria-roledescription")).toBeTruthy();
    const hint = document.getElementById(el.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/Space/);
  });
});

describe("on touch", () => {
  const isTouchMove = (c: unknown[]) => c[0] === "touchmove" && (c[2] as AddEventListenerOptions | undefined)?.passive === false;

  // iOS Safari and Chrome decide at touchstart whether a touchmove may be cancelled,
  // so the non-passive listener has to be there before any finger comes down.
  it("listens to touchmove, non-passive, on the board itself from the start, and stops on unmount", async () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    try {
      const { unmount } = mount();
      await screen.findByText("Rotate keys");
      const at = add.mock.calls.findIndex(isTouchMove);
      expect(at).toBeGreaterThanOrEqual(0);
      const target = add.mock.contexts[at] as Node;
      expect(target).not.toBe(window);
      expect((target as Node).contains(column("draft"))).toBe(true);
      const listener = add.mock.calls[at]![1];
      unmount();
      expect(remove.mock.calls.some((c, i) => c[0] === "touchmove" && c[1] === listener && remove.mock.contexts[i] === target)).toBe(true);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("a long press picks the card up and a drop moves it", async () => {
    await board();
    vi.useFakeTimers();
    const el = card("t1");
    pointerDown(el, "draft", "touch");
    expect(dropStates()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(column("draft").getAttribute("data-drop-state")).toBe("origin");
    vi.useRealTimers();
    // Once it is held, the finger moving does not scroll the page.
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    el.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    pointerMove("assigned");
    pointerUp("assigned");
    fireEvent.click(el);
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t1", "assigned"));
    expect(detailOpen()).toBe(false);
  });

  const longPressDrag = (id: string, to: Col) => {
    vi.useFakeTimers();
    const el = card(id);
    pointerDown(el, columnOfCard(id) as Col, "touch");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();
    pointerMove(to);
    pointerUp(to);
    fireEvent.click(el);
  };

  it("a long press sends an assigned Task back to draft", async () => {
    await board();
    longPressDrag("t2", "draft");
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t2", "draft"));
    await waitFor(() => expect(columnOfCard("t2")).toBe("draft"));
    expect(detailOpen()).toBe(false);
  });

  it("a long press re-assigns a finished Task with the status call, not a comment", async () => {
    await board();
    longPressDrag("t4", "assigned");
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith("t4", "assigned"));
    await waitFor(() => expect(columnOfCard("t4")).toBe("assigned"));
    expect(api.commentOnTask).not.toHaveBeenCalled();
    expect(detailOpen()).toBe(false);
  });

  it("a short tap opens the Task and moves nothing", async () => {
    await board();
    const el = card("t1");
    pointerDown(el, "draft", "touch");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: X.draft, clientY: 20 });
    fireEvent.click(el);
    expect(detailOpen()).toBe(true);
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });

  it("a finger that moves before the press is long scrolls instead of dragging", async () => {
    await board();
    vi.useFakeTimers();
    const el = card("t1");
    pointerDown(el, "draft", "touch");
    pointerMove("draft", 12);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(dropStates()).toEqual([]);
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    el.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    vi.useRealTimers();
    pointerMove("assigned");
    pointerUp("assigned");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
  });
});
