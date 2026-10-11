// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { TaskDto } from "~/shared/task-wire";

// The Time limit row in the New Task dialog and the Time limit box in the Task detail (#724).

const cores: CoreWithDial[] = [{ id: "c1", endpoint: "wss://x", label: "workstation-berlin", lastEventId: 0, createdAt: 0, updatedAt: 0, dial: { coreId: "c1", state: "connected", lastSeenAt: 1 } }];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));

let task: TaskDto;
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [{ id: "ag-c1", coreId: "c1", name: "claude-code", harness: "claude-code", model: null, isDefault: true }] })),
  createTask: vi.fn(async (_body: Record<string, unknown>) => ({ task: { id: "new" } })),
  updateTask: vi.fn(),
  commentOnTask: vi.fn(),
  setTaskStatus: vi.fn(),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { NewTaskDialog } = await import("../NewTaskDialog");
const { TaskDetail } = await import("../TaskDetail");

function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>{ui}</KeybindingsProvider>
    </QueryClientProvider>,
  );
}

const baseTask: TaskDto = { id: "T-7", title: "Rotate keys", description: "", status: "draft", coreId: "c1", agent: "ag-c1", attemptCount: 0, dispatchedAt: null, lastError: null, timeoutMinutes: 60, createdAt: 1, updatedAt: 1 };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  task = baseTask;
  api.getTask.mockImplementation(async () => ({ task, comments: [] }));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("New Task: Time limit", () => {
  const open = async () => {
    mount(<NewTaskDialog open onClose={vi.fn()} initialCoreId="c1" />);
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Do it" } });
    await screen.findByRole("radio", { name: /claude-code/ });
    return screen.getByRole("radiogroup", { name: "Time limit" });
  };
  const create = () => fireEvent.click(screen.getByRole("button", { name: /Create/ }));

  it("has 1 hour selected and sends 60", async () => {
    const group = await open();
    expect(within(group).getByRole("radio", { name: /^1 hour/ }).getAttribute("aria-checked")).toBe("true");
    create();
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ timeoutMinutes: 60 });
  });

  it("offers the presets, Custom and No limit in order", async () => {
    const group = await open();
    expect(within(group).getAllByRole("radio").map((r) => r.textContent?.replace("✓", ""))).toEqual(["30 min", "1 hour", "4 hours", "8 hours", "24 hours", "Custom…", "No limit"]);
  });

  it("sends 240 for 4 hours", async () => {
    const group = await open();
    fireEvent.click(within(group).getByRole("radio", { name: /^4 hours/ }));
    create();
    await waitFor(() => expect(api.createTask.mock.calls[0]![0]).toMatchObject({ timeoutMinutes: 240 }));
  });

  it("sends null for No limit and explains it", async () => {
    const group = await open();
    fireEvent.click(within(group).getByRole("radio", { name: /No limit/ }));
    expect(screen.getByText(/checks once a minute that the Session is alive/)).toBeTruthy();
    create();
    await waitFor(() => expect(api.createTask.mock.calls[0]![0]).toMatchObject({ timeoutMinutes: null }));
  });

  it("sends the Custom minutes", async () => {
    const group = await open();
    fireEvent.click(within(group).getByRole("radio", { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "90" } });
    create();
    await waitFor(() => expect(api.createTask.mock.calls[0]![0]).toMatchObject({ timeoutMinutes: 90 }));
  });

  it("keeps Create and Save as draft off for a Custom value of 0 or 43201", async () => {
    const group = await open();
    fireEvent.click(within(group).getByRole("radio", { name: /Custom/ }));
    for (const bad of ["0", "43201", "1.5", ""]) {
      fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: bad } });
      expect((screen.getByRole("button", { name: /Create/ }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: /Save as draft/ }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "43200" } });
    expect((screen.getByRole("button", { name: /Create/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sits between Attachments and the Start switch", async () => {
    const group = await open();
    const attachments = screen.getByText(/^Attachments/);
    const start = screen.getByRole("switch", { name: "Start as soon as it is created" });
    expect(attachments.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Task detail: Time limit", () => {
  const box = async () => within(await screen.findByRole("region", { name: "Time limit" }));

  it("shows the limit", async () => {
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    expect((await box()).getByText("1 hour", { selector: "strong" })).toBeTruthy();
  });

  it("shows the time left on a running attempt", async () => {
    const now = Date.now();
    task = { ...baseTask, status: "in_progress", attemptCount: 2, dispatchedAt: now - 20 * 60_000 };
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    expect((await box()).getByText(/40 min left on attempt 2/)).toBeTruthy();
  });

  it("says No limit with the start time for a running No-limit Task", async () => {
    task = { ...baseTask, status: "in_progress", attemptCount: 1, dispatchedAt: Date.now() - 5 * 60_000, timeoutMinutes: null };
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    expect((await box()).getByText(/^No limit · started/)).toBeTruthy();
  });

  it("changes the limit of an in_progress Task, while Edit is off", async () => {
    task = { ...baseTask, status: "in_progress", attemptCount: 1, dispatchedAt: Date.now() };
    api.updateTask.mockResolvedValue({ task });
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    const b = await box();
    expect(((await screen.findByRole("button", { name: /^Edit$/ })) as HTMLButtonElement).disabled).toBe(true);
    const four = b.getByRole("radio", { name: /^4 hours/ }) as HTMLButtonElement;
    expect(four.disabled).toBe(false);
    fireEvent.click(four);
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("T-7", { timeoutMinutes: 240 }));
    fireEvent.click(b.getByRole("radio", { name: /No limit/ }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("T-7", { timeoutMinutes: null }));
  });

  it("saves a Custom value only when it is committed with Set or Enter", async () => {
    task = { ...baseTask, status: "in_progress", attemptCount: 1, dispatchedAt: Date.now() - 30 * 60_000 };
    api.updateTask.mockResolvedValue({ task });
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    const b = await box();
    fireEvent.click(b.getByRole("radio", { name: /^Custom/ }));
    const input = b.getByLabelText("Minutes");
    for (const v of ["1", "12", "120"]) fireEvent.change(input, { target: { value: v } });
    expect(api.updateTask).not.toHaveBeenCalled();
    fireEvent.click(b.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(1));
    expect(api.updateTask).toHaveBeenCalledWith("T-7", { timeoutMinutes: 120 });
    // The text field stays enabled while the save is pending, and Enter commits too.
    api.updateTask.mockClear();
    fireEvent.change(input, { target: { value: "90" } });
    expect(api.updateTask).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(1));
    expect(api.updateTask).toHaveBeenCalledWith("T-7", { timeoutMinutes: 90 });
  });

  it("sends nothing when an invalid Custom value is set", async () => {
    task = { ...baseTask, status: "in_progress", attemptCount: 1, dispatchedAt: Date.now() };
    api.updateTask.mockResolvedValue({ task });
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    const b = await box();
    fireEvent.click(b.getByRole("radio", { name: /^Custom/ }));
    const input = b.getByLabelText("Minutes");
    fireEvent.change(input, { target: { value: "0" } });
    const set = b.getByRole("button", { name: "Set" }) as HTMLButtonElement;
    fireEvent.click(set);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    api.updateTask.mockRejectedValue(new Error("a time limit is a whole number of minutes from 1 to 43200, or null for No limit"));
    mount(<TaskDetail taskId="T-7" onClose={vi.fn()} />);
    fireEvent.click((await box()).getByRole("radio", { name: /^8 hours/ }));
    expect(await screen.findByText(/a time limit is a whole number/)).toBeTruthy();
  });
});
