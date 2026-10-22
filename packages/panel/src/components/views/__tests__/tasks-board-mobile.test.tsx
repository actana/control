// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { AgentDto, TaskDto } from "~/shared/task-wire";

// The Tasks board on phone and tablet (#834, screens M40, M40 tablet, M40b, M41,
// M41b). matchMedia, api, sonner and the fleet are the edges.

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
  setTaskStatus: vi.fn(async (id: string, status: TaskDto["status"]) => {
    tasks = tasks.map((t) => (t.id === id ? { ...t, status } : t));
    return {};
  }),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { TasksBoard } = await import("../TasksBoard");

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { media: query, matches: max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false, addEventListener: () => {}, removeEventListener: () => {} };
  });
}

async function mount(props: { coreId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <TasksBoard {...props} />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  await screen.findAllByText(/Rotate keys|Bump SeaweedFS|Remove sudo|Review PR|Loose draft/);
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const columnsOnShow = () => [...document.querySelectorAll("section[aria-label]")].map((el) => el.getAttribute("aria-label"));
const card = (id: string) => document.querySelector(`[data-task-card="${id}"]`) as HTMLElement;

beforeEach(() => {
  tasks = [
    task("t1", "Rotate keys", "draft", "c1"),
    task("t2", "Bump SeaweedFS", "assigned", "c2"),
    task("t3", "Remove sudo", "in_progress", "c1", { attemptCount: 2 }),
    task("t4", "Review PR", "failed", "c2", { attemptCount: 1 }),
    task("t5", "Loose draft", "draft", null),
  ];
  for (const fn of Object.values(api)) fn.mockClear();
  toast.error.mockClear();
  stubWidth(390);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("phone: one column at a time", () => {
  it("shows the Draft column and a segmented control with the counts of the filtered Tasks", async () => {
    await mount();
    expect(columnsOnShow()).toEqual(["Draft"]);
    expect(screen.getByText("Rotate keys")).toBeTruthy();
    expect(screen.queryByText("Bump SeaweedFS")).toBeNull();
    expect(within(tab("Draft")).getByText("2")).toBeTruthy();
    expect(within(tab("Assigned")).getByText("1")).toBeTruthy();
    expect(within(tab("In progress")).getByText("1")).toBeTruthy();
    expect(within(tab("Finished")).getByText("1")).toBeTruthy();
    expect(screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(tab("Draft").getAttribute("aria-selected")).toBe("true");
  });

  it("counts follow the Core chip", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /workstation-berlin/ }));
    expect(within(tab("Draft")).getByText("1")).toBeTruthy();
    expect(within(tab("Assigned")).getByText("0")).toBeTruthy();
  });

  it("selecting a segment switches the column", async () => {
    await mount();
    fireEvent.click(tab("Assigned"));
    expect(columnsOnShow()).toEqual(["Assigned"]);
    expect(screen.getByText("Bump SeaweedFS")).toBeTruthy();
    expect(tab("Assigned").getAttribute("aria-selected")).toBe("true");
    expect(tab("Draft").getAttribute("aria-selected")).toBe("false");
  });

  it("shows an empty state for an empty column", async () => {
    tasks = tasks.filter((t) => t.status !== "in_progress");
    await mount();
    fireEvent.click(tab("In progress"));
    expect(screen.getByText("No Tasks in In progress.")).toBeTruthy();
  });

  it("a swipe left goes to the next column and a swipe right to the previous one", async () => {
    await mount();
    const list = document.querySelector(".mc-tasks-columns") as HTMLElement;
    const swipe = (from: number, to: number, dy = 0) => {
      fireEvent.touchStart(list, { touches: [{ clientX: from, clientY: 200 }] });
      fireEvent.touchEnd(list, { changedTouches: [{ clientX: to, clientY: 200 + dy }] });
    };
    swipe(300, 100);
    expect(columnsOnShow()).toEqual(["Assigned"]);
    swipe(100, 300);
    expect(columnsOnShow()).toEqual(["Draft"]);
  });

  it("a short or mostly vertical gesture is not a swipe", async () => {
    await mount();
    const list = document.querySelector(".mc-tasks-columns") as HTMLElement;
    fireEvent.touchStart(list, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(list, { changedTouches: [{ clientX: 280, clientY: 200 }] });
    fireEvent.touchStart(list, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(list, { changedTouches: [{ clientX: 200, clientY: 400 }] });
    expect(columnsOnShow()).toEqual(["Draft"]);
  });
});

describe("phone: swipe vs drag", () => {
  it("a long-press drag released sideways does not also swipe the column", async () => {
    await mount();
    document.elementFromPoint = (() => document.body) as typeof document.elementFromPoint;
    const el = card("t1");
    vi.useFakeTimers();
    fireEvent.touchStart(el, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, pointerType: "touch", isPrimary: true, clientX: 300, clientY: 300 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 60, clientY: 230 });
    });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 60, clientY: 230 }] });
    expect(columnsOnShow()).toEqual(["Draft"]);
  });
});

describe("phone: chips and New Task", () => {
  it("shows the Core chips as a scrolling row on the board, with counts", async () => {
    await mount();
    const chips = screen.getByRole("group", { name: "Filter by Core" });
    expect(chips.className).toContain("mc-tasks-chips");
    expect(within(chips).getByRole("button", { name: /All Cores/ }).textContent).toContain("5");
  });

  it("has no chips on a Core's Tasks tab", async () => {
    await mount({ coreId: "c1" });
    expect(screen.queryByRole("group", { name: "Filter by Core" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("New Task is a floating button that opens the dialog", async () => {
    await mount();
    const fab = screen.getByRole("button", { name: /New Task/ });
    expect(fab.className).toContain("mc-tasks-fab");
    fireEvent.click(fab);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("phone: long-press drag onto the segments", () => {
  const BAND: Record<string, number> = { draft: 50, assigned: 150, in_progress: 250, finished: 350 };
  const target = (id: string) => document.querySelector(`[data-board-column="${id}"]`) as HTMLElement;

  async function carry(id: string) {
    document.elementFromPoint = ((x: number) => {
      const col = Object.entries(BAND).find(([, bx]) => Math.abs(bx - x) < 50)?.[0];
      return col ? (document.querySelector(`[data-board-column="${col}"]`) ?? document.body) : document.body;
    }) as typeof document.elementFromPoint;
    const el = card(id);
    vi.useFakeTimers();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, pointerType: "touch", isPrimary: true, clientX: 50, clientY: 300 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
  }
  const moveTo = (col: string) => fireEvent.pointerMove(window, { pointerId: 1, clientX: BAND[col], clientY: 120 });
  const release = (col: string) =>
    act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: BAND[col], clientY: 120 });
    });

  it("turns the segments into drop targets with a hint each, and the carried card's slot into a placeholder", async () => {
    await mount();
    await carry("t1");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Drop on a column to move the Task. Let go anywhere else to cancel.")).toBeTruthy();
    expect(within(target("draft")).getByText("From here")).toBeTruthy();
    expect(within(target("assigned")).getByText("Release to assign")).toBeTruthy();
    expect(within(target("in_progress")).getByText("Only the Panel starts a Task")).toBeTruthy();
    expect(within(target("finished")).getByText("Only a result finishes a Task")).toBeTruthy();
    expect(target("in_progress").getAttribute("data-drop-state")).toBe("refused");
    expect(card("t1").getAttribute("data-placeholder")).toBe("true");
    // The list is not a drop target while the grid is.
    expect(document.querySelectorAll('[data-board-column="draft"]')).toHaveLength(1);
  });

  it("pins the help line and the drop grid in one drop bar instead of scrolling to them", async () => {
    // jsdom has no scrollIntoView; the bar is position:fixed under the top bar, so nothing needs to scroll.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await mount();
      await carry("t1");
      moveTo("assigned");
      const bar = document.querySelector(".mc-tasks-dropbar") as HTMLElement;
      expect(bar).toBeTruthy();
      expect(bar.querySelector(".mc-tasks-drop-help")).toBeTruthy();
      const grid = bar.querySelector(".mc-tasks-drop-grid") as HTMLElement;
      expect(grid).toBeTruthy();
      expect(grid.querySelectorAll("[data-board-column]")).toHaveLength(4);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("keeps the segmented control in its slot, hidden, while a card is carried", async () => {
    await mount();
    expect(document.querySelector(".mc-tasks-segments")?.hasAttribute("data-carrying")).toBe(false);
    await carry("t1");
    const seg = document.querySelector(".mc-tasks-segments") as HTMLElement;
    expect(seg).toBeTruthy();
    expect(seg.getAttribute("role")).toBe("tablist");
    expect(seg.getAttribute("data-carrying")).toBe("true");
    expect(seg.getAttribute("aria-hidden")).toBe("true");
    await release("assigned");
    const back = document.querySelector(".mc-tasks-segments") as HTMLElement;
    expect(back.hasAttribute("data-carrying")).toBe(false);
    expect(back.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelector(".mc-tasks-dropbar")).toBeNull();
  });

  it("an assigned Task offers Draft with its own hint", async () => {
    await mount();
    fireEvent.click(tab("Assigned"));
    await carry("t2");
    expect(within(target("draft")).getByText("Release to move to Draft")).toBeTruthy();
  });

  it("dropping on Assigned makes the same call as the desktop board", async () => {
    await mount();
    await carry("t1");
    moveTo("assigned");
    expect(target("assigned").getAttribute("data-drop-over")).toBe("true");
    await release("assigned");
    expect(api.setTaskStatus).toHaveBeenCalledWith("t1", "assigned");
  });

  it("a refused drop toasts \"Can’t move to <column>\" with the reason as the description", async () => {
    await mount();
    await carry("t1");
    moveTo("in_progress");
    await release("in_progress");
    expect(api.setTaskStatus).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Can’t move to In progress", {
      description: expect.stringContaining("Only the Panel starts a Task"),
    });
  });
});

describe("tablet: two columns", () => {
  it("a refused drop toasts \"Can’t move to <column>\" like on a phone", async () => {
    stubWidth(900);
    await mount();
    document.elementFromPoint = ((x: number) =>
      document.querySelector(`[data-board-column="${x < 200 ? "draft" : "in_progress"}"]`) ?? document.body) as typeof document.elementFromPoint;
    vi.useFakeTimers();
    fireEvent.pointerDown(card("t1"), { pointerId: 1, button: 0, pointerType: "touch", isPrimary: true, clientX: 50, clientY: 300 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 120 });
    });
    expect(api.setTaskStatus).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Can’t move to In progress", {
      description: expect.stringContaining("Only the Panel starts a Task"),
    });
  });

  it("shows the selected column and the next one, both highlighted", async () => {
    stubWidth(900);
    await mount();
    expect(columnsOnShow()).toEqual(["Draft", "Assigned"]);
    expect(tab("Draft").getAttribute("aria-selected")).toBe("true");
    expect(tab("Assigned").getAttribute("aria-selected")).toBe("true");
    expect(tab("In progress").getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tab("In progress"));
    expect(columnsOnShow()).toEqual(["In progress", "Finished · Partial · Failed"]);
  });
});

describe("744 px frame (phone by breakpoint, two columns from 600 px)", () => {
  it("shows two columns, and Finished selects In progress + Finished", async () => {
    stubWidth(744);
    await mount();
    expect(columnsOnShow()).toEqual(["Draft", "Assigned"]);
    expect(tab("Assigned").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("Finished"));
    expect(columnsOnShow()).toEqual(["In progress", "Finished · Partial · Failed"]);
    expect(tab("In progress").getAttribute("aria-selected")).toBe("true");
    expect(tab("Finished").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".mc-tasks-pager")).toBeNull();
  });

  it("599 px is still one column", async () => {
    stubWidth(599);
    await mount();
    expect(columnsOnShow()).toEqual(["Draft"]);
  });
});

describe("desktop: unchanged", () => {
  it("renders the grid with all four columns, no segmented control and the header button", async () => {
    stubWidth(1280);
    await mount();
    expect(columnsOnShow()).toEqual(["Draft", "Assigned", "In progress", "Finished · Partial · Failed"]);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(document.querySelector(".mc-tasks-fab")).toBeNull();
    expect(screen.getByRole("button", { name: /New Task/ })).toBeTruthy();
  });
});
